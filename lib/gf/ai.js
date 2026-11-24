'use strict';
/**
 * lib/gf/ai.js — where her words come from.
 *
 *   1) Gemini through your Google-account cookies (lib/gemini.js + lib/Geminicook.txt).
 *      Every person gets ONE real Gemini conversation (per girlfriend), so Gemini itself remembers the chat:
 *      the first message of a conversation carries her instructions + the last-24h log, the next ones only the
 *      new message + the small private context (time, mood, what she knows about him).
 *   2) ONLY when that fails (cookies expired / revoked, Google down, no answer …) → the old
 *      https://ai.dnuz.top/api/gemini?q=  endpoint. It is stateless, so plugins/girlfriends.js puts the history in the prompt.
 *
 * Memory lifetime = config.GF.MEMORY_HOURS (24h), like the message log: the conversation ids live in MongoDB
 * (collection GfAiSession, TTL index) when the bot has a database, in RAM otherwise.
 *
 * Switches (env, or the same name in config.GF):
 *   GF_AI=auto          auto (default) | endpoint (never touch the cookies) | cookies (no fallback — for testing)
 *   GF_GEMINI_THREADS   off → every message starts a new Gemini conversation instead (the history travels in the prompt)
 *   GF_GEMINI_TIMEOUT_MS=25000   GF_GEMINI_MAX_TURNS=30   GEMINI_LANGUAGE=(si/en by her language)
 *   GF_AI_DEBUG=1       print one line per answer: which route made it (Gemini cookies / endpoint) and the conversation turn
 *   cookies: GEMINI_COOKIES or GEMINI_COOKIE_FILE or lib/Geminicook.txt  (see lib/gemini.js)
 * Under `node --test` (or GF_FAST=1) the cookies are never used: the tests only ever see the scripted endpoint.
 */
const crypto = require('crypto');

let config = {};
try { config = require('../../config'); } catch { /* the config is optional here */ }
const gfc = () => (config && config.GF) || {};

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const clip = (t, n = 120) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const digitsOf = (x) => String(x || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms).unref())]);

class AiError extends Error {
    constructor(message, code) { super(message); this.name = 'AiError'; this.code = code; }
}

function sourceMode() {
    const v = String(process.env.GF_AI || gfc().AI || '').toLowerCase();
    if (v === 'auto' || v === 'endpoint' || v === 'cookies') return v;
    return (process.env.NODE_TEST_CONTEXT || process.env.GF_FAST) ? 'endpoint' : 'auto';
}

function settings() {
    const g = gfc();
    const threads = process.env.GF_GEMINI_THREADS ?? g.GEMINI_THREADS ?? 'on';
    return {
        timeoutMs: num(process.env.GF_GEMINI_TIMEOUT_MS || g.GEMINI_TIMEOUT_MS, 25_000),
        maxTurns: num(process.env.GF_GEMINI_MAX_TURNS || g.GEMINI_MAX_TURNS, 30),
        threads: !/^(off|false|0|no)$/i.test(String(threads)),
        ttlMs: num(g.MEMORY_HOURS, 24) * 3_600_000,
        language: String(process.env.GEMINI_LANGUAGE || g.GEMINI_LANGUAGE || ''),
    };
}

// lib/gemini.js is an ES module, this file is CommonJS → load it with import(); if that is impossible, the endpoint is used
let libPromise = null;
function loadLib() {
    if (!libPromise) {
        libPromise = import('../gemini.js').catch((e) => {
            console.error(`[GF-AI] lib/gemini.js could not be loaded (${e.message}) → only the ai.dnuz.top endpoint is used`);
            return null;
        });
    }
    return libPromise;
}

// ═════════════════════════ her Gemini conversations (the memory) ═════════════════════════
// record: { key, sid, cid, rid, rcid, turn, sig, startedAt, last, dirty }
//   key = "<girl>_<sender>"  sid = digits of the sender  cid/rid/rcid = Gemini conversation / response / candidate id
//   sig = fingerprint of her instructions (persona + language + mode) · dirty = a message was answered elsewhere (endpoint)
const mem = new Map();

function model() {
    try {
        const mongoose = require('mongoose');
        if (!mongoose.connection || mongoose.connection.readyState !== 1) return null;
        return mongoose.models.GfAiSession || mongoose.model('GfAiSession', new mongoose.Schema({
            key: { type: String, unique: true, index: true },
            sid: { type: String, index: true },
            cid: String, rid: String, rcid: String, sig: String,
            turn: Number, startedAt: Number, last: Number, dirty: Boolean,
            at: { type: Date, default: Date.now, expires: Math.round(settings().ttlMs / 1000) },   // MongoDB deletes it itself
        }, { minimize: false }));
    } catch { return null; }
}

async function getSession(key) {
    let s = mem.get(key);
    if (!s) {
        const M = model();
        if (M) {
            try {
                const row = await withTimeout(M.findOne({ key }).lean(), 1500);
                if (row) {
                    s = {
                        key, sid: row.sid || '', cid: row.cid || '', rid: row.rid || '', rcid: row.rcid || '', sig: row.sig || '',
                        turn: row.turn || 0, startedAt: row.startedAt || Date.now(), last: row.last || 0, dirty: !!row.dirty,
                    };
                    mem.set(key, s);
                }
            } catch { /* database slow or down → a new conversation is started */ }
        }
    }
    if (s && Date.now() - s.last > settings().ttlMs) { mem.delete(key); return null; }     // she forgets after MEMORY_HOURS
    return s || null;
}

function saveSession(s) {
    mem.set(s.key, s);
    const M = model();
    if (!M) return;
    Promise.resolve(M.updateOne({ key: s.key }, { $set: { ...s, at: new Date() } }, { upsert: true }))
        .catch((e) => console.error('[GF-AI] saving the conversation id failed:', e.message));
}

/** a message was answered by the endpoint → her Gemini conversation missed it: next time the full prompt (with the log) is sent again */
function markMissed(plan) {
    getSession(plan.key).then((s) => { if (s) { s.dirty = true; saveSession(s); } }).catch(() => {});
}

/** `/gf forget` → drop every Gemini conversation of this person (ids = jids or digits) */
async function forget(ids) {
    try {
        const wanted = new Set([].concat(ids || []).map(digitsOf).filter(Boolean));
        if (!wanted.size) return 0;
        let n = 0;
        for (const [k, v] of mem) if (wanted.has(v.sid)) { mem.delete(k); n++; }
        const M = sourceMode() === 'endpoint' ? null : model();
        if (M) await withTimeout(M.deleteMany({ sid: { $in: [...wanted] } }), 3000);
        return n;
    } catch (e) {
        console.error('[GF-AI] forget failed:', e.message);
        return 0;
    }
}

setInterval(() => {
    const now = Date.now(), ttl = settings().ttlMs;
    for (const [k, v] of mem) if (now - v.last > ttl) mem.delete(k);
}, 10 * 60_000).unref();

// ═════════════════════════ is the cookie route usable right now? ═════════════════════════
// Dead cookies must not slow every message down (and must not hammer Google): after a hard failure the cookie route
// sleeps for a while — and wakes up at once when lib/Geminicook.txt (or the env cookies) change.
const SOFT_MS = 2 * 60_000, HARD_MS = 10 * 60_000, LIMIT_MS = 5 * 60_000;
const breaker = { fails: 0, until: 0, fingerprint: 'none', lastLog: 0 };
const fingerprintOf = (cookies) => (cookies ? crypto.createHash('sha1').update(cookies).digest('hex') : 'none');

async function gateOpen(lib) {
    if (Date.now() >= breaker.until) return true;
    try {
        if (fingerprintOf(await lib.loadCookiesFromFile()) !== breaker.fingerprint) {
            breaker.until = 0; breaker.fails = 0;
            return true;
        }
    } catch { /* keep waiting */ }
    return false;
}

async function tripped(e) {
    const code = e && e.code;
    breaker.fails++;
    const hard = code === 'NO_COOKIES' || code === 'AUTH';
    const wait = hard ? HARD_MS : (code === 'RATE_LIMIT' || code === 'LIMIT') ? LIMIT_MS : (breaker.fails >= 3 ? SOFT_MS : 0);
    const now = Date.now();
    const say = (msg) => { if (now - breaker.lastLog > 60_000) { breaker.lastLog = now; console.error(msg); } };
    if (!wait) return say(`[GF-AI] Gemini cookies failed (${clip(e && e.message)}) → this message goes through ai.dnuz.top`);
    breaker.until = now + wait;
    try {
        const lib = await loadLib();
        breaker.fingerprint = fingerprintOf(lib ? await lib.loadCookiesFromFile() : '');
    } catch { breaker.fingerprint = 'none'; }
    return say(`🍪 [GF-AI] Gemini cookies not usable (${clip(e && e.message)}) → ai.dnuz.top for the next ${Math.round(wait / 60_000)} min` +
        (hard ? ' — put fresh cookies in lib/Geminicook.txt (it is picked up automatically)' : ''));
}

// Gemini's own "limit reached" / "try again later" notices are not her words
const LIMIT_RE = /reached (?:your|the) (?:daily |usage )?limit|usage limit|too many requests|try again (?:later|tomorrow)/i;

// if Gemini silently starts a NEW conversation although we sent an id, conversations do not work here → carry the history in the prompt
let brokenStreak = 0;
let threadsOff = false;
function noteBroken() {
    if (++brokenStreak >= 3 && !threadsOff) {
        threadsOff = true;
        console.error('[GF-AI] Gemini ignores the conversation id here → from now on every message carries the chat history itself (like GF_GEMINI_THREADS=off)');
    }
}

// ═════════════════════════ the Gemini (cookies) route ═════════════════════════
/**
 * plan = { key, sender, sig, language, prime, turn }   (built by plugins/girlfriends.js)
 *   prime = full prompt (instructions + what she knows + examples + last-24h lines + his message)  → a new conversation
 *   turn  = short prompt (small context + his message)                                           → a conversation that already knows her
 * → { text, via:'gemini', commit() }  or  null (route not usable) ; throws when the call itself failed
 */
async function viaGemini(plan) {
    const lib = await loadLib();
    if (!lib || !(await gateOpen(lib))) return null;

    const cfg = settings();
    const useThreads = cfg.threads && !threadsOff;
    const language = cfg.language || plan.language || 'en';

    let thread = useThreads ? await getSession(plan.key) : null;
    if (thread && (!thread.cid || thread.turn >= cfg.maxTurns)) thread = null;      // worn out → a new conversation, primed from the 24h log

    const send = async (th) => {
        const primed = !th || th.sig !== plan.sig || th.dirty;       // new conversation, her instructions changed, or turns were answered elsewhere
        const res = await lib.askGemini(primed ? plan.prime : plan.turn, {
            language,
            timeoutMs: cfg.timeoutMs,
            ...(th ? { conversationId: th.cid, responseId: th.rid, candidateId: th.rcid, turnIndex: th.turn } : {}),
        });
        return { res, th };
    };

    let got = null;
    if (thread) {
        try {
            got = await send(thread);
            const moved = !!got.res.conversationId && got.res.conversationId !== thread.cid;
            if (moved) noteBroken(); else if (got.res.text) brokenStreak = 0;
            if (moved || !got.res.text) got = null;        // that answer knew nothing about her → ask again with the full prompt
        } catch (e) {
            if (!e || e.code !== 'HTTP') throw e;          // cookies / network / timeout: starting over would not help
            got = null;
        }
    }
    if (!got) got = await send(null);                      // a new conversation, started with the full prompt

    const text = String(got.res.text || '').trim();
    if (!text) throw new AiError('Gemini returned an empty answer', 'EMPTY');
    if (text.length < 240 && LIMIT_RE.test(text)) throw new AiError(`Gemini sent a limit notice: ${clip(text, 80)}`, 'LIMIT');

    breaker.fails = 0; breaker.until = 0;
    const base = got.th;
    const { res } = got;
    return {
        text,
        via: 'gemini',
        detail: base ? `turn ${base.turn + 1}` : 'new conversation',
        /** call this only for an answer that is really sent: only then it becomes part of her conversation */
        commit() {
            if (!useThreads) return;
            const now = Date.now();
            saveSession({
                key: plan.key, sid: digitsOf(plan.sender),
                cid: res.conversationId || '', rid: res.responseId || '', rcid: res.candidateId || '',
                turn: (base ? base.turn : 0) + 1, sig: plan.sig,
                startedAt: base ? base.startedAt : now, last: now, dirty: false,
            });
        },
    };
}

// ═════════════════════════ public ═════════════════════════
/**
 * @param {{ gemini?: object|null, endpoint: () => Promise<string> }} o
 *   gemini   = the plan above (leave out → endpoint only) · endpoint = the old ai.dnuz.top request
 * @returns {Promise<{ text: string, via: 'gemini'|'endpoint', commit: () => void }>}
 */
async function ask({ gemini = null, endpoint }) {
    const mode = sourceMode();
    let failure = null;
    if (gemini && mode !== 'endpoint') {
        try {
            const r = await viaGemini(gemini);
            if (r) {
                if (process.env.GF_AI_DEBUG) console.log(`[GF-AI] answered by Gemini cookies (${r.detail})`);
                return r;
            }
        } catch (e) {
            failure = e;
            await tripped(e);
        }
        if (mode === 'cookies') throw failure || new Error('Gemini cookies are not usable right now');
    }
    const text = await endpoint();
    if (process.env.GF_AI_DEBUG) console.log('[GF-AI] answered by the ai.dnuz.top endpoint');
    return { text, via: 'endpoint', commit() { if (gemini && mode !== 'endpoint') markMissed(gemini); } };
}

function status() {
    return {
        mode: sourceMode(),
        threads: settings().threads && !threadsOff,
        cookieRouteSleeping: Date.now() < breaker.until,
        sleepsUntil: breaker.until ? new Date(breaker.until).toISOString() : null,
        failuresInARow: breaker.fails,
        conversations: mem.size,
    };
}

module.exports = { ask, forget, status, sourceMode };
