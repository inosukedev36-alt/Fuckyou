'use strict';
/**
 * lib/gf/webchat.js — Gemini WEB (cookies) backend for the girlfriends.
 *
 *  • ONE Gemini conversation per (girl, user): Gemini itself remembers the earlier messages,
 *    so after the first turn only a short "tags + his message" is sent (no history pasted into the prompt).
 *  • A new conversation (full persona + short history + 24h memory lines) starts when the persona changes
 *    (mode / language), after SESSION_TTL_MS of silence, after MAX_TURNS turns, or after any failure.
 *  • ANY problem (cookies expired, blocked, timeout, empty / "limit" reply) makes ask() throw;
 *    plugins/girlfriends.js then uses the old https://ai.dnuz.top endpoint for that message.
 *  • Circuit breaker: after a failure the web path is skipped for a while (no waiting 40 s on every message).
 *
 * Switch off with  GF_WEB=0  in .env.  Cookies: lib/Geminicook.txt  or  GEMINI_COOKIES in .env.
 */
const path = require('path');
const { pathToFileURL } = require('url');

const CFG = {
    SESSION_TTL_MS:   24 * 3_600_000,   // idle conversation is dropped after 24 h (the bot's own memory is 24 h too)
    MAX_TURNS:        60,               // very long conversations get slow → start a fresh one
    TIMEOUT_MS:       40_000,
    AUTH_COOLDOWN_MS: 10 * 60_000,      // cookies missing / expired → don't even try for 10 min
    FAIL_COOLDOWN_MS: 30_000,           // any other failure → 30 s
};

const sessions = new Map();             // key → { chat, sig, turns, last, busy: Promise }
let downUntil = 0;
let lastError = '';

const enabled = () => !process.env.GF_FAST && process.env.GF_WEB !== '0';
const available = () => enabled() && Date.now() >= downUntil;

// ───────── load the ESM module from CommonJS (lib/gemini.mjs is always ESM; gemini.js needs Node ≥ 22.7) ─────────
let modP = null;
function gem() {
    if (!modP) {
        modP = (async () => {
            let err;
            for (const f of ['gemini.mjs', 'gemini.js']) {
                try { return await import(pathToFileURL(path.join(__dirname, '..', f)).href); }
                catch (e) { err = e; }
            }
            throw err;
        })();
        modP.catch(() => { modP = null; });          // retry the import next time
    }
    return modP;
}

// ───────── Gemini's web page markup (<Section>, <TextBox …/>, <Elicitations>) → plain WhatsApp text ─────────
function clean(text = '') {
    return String(text)
        .replace(/<Elicitations[\s\S]*?<\/Elicitations>/g, '')
        .replace(/<TextBox[^>]*text="([^"]*)"[^>]*\/>/g, '$1')
        .replace(/<\/?Section[^>]*>/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Gemini's own "I can't / limit" notices are not girlfriend replies → let the old endpoint answer
const NOTICE = /(reached (?:your|the) (?:limit|usage)|usage limit|try again (?:later|in)|something went wrong|unusual traffic|sign in to (?:continue|use)|i can't help with that|i cannot help with that|i'm just a language model)/i;
const AUTH   = /(cookies not found|WIZ_global_data|SNlM0e|not authenticated|\b40[13]\b)/i;

const withTimeout = (p, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Gemini-web timeout (${ms / 1000}s)`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
});

/**
 * @param key   one conversation per key  (`${girl}_${sender}`)
 * @param sig   persona signature (the system prompt text): when it changes a new conversation starts
 * @param first () => full prompt for a NEW conversation (persona + history + memory + tags + message)
 * @param next  () => short prompt for a CONTINUING conversation (memory + tags + message)
 */
async function ask(key, { sig, first, next, language = 'si' }) {
    if (!enabled()) throw new Error('WEB_OFF');
    if (Date.now() < downUntil) throw new Error(`WEB_DOWN: ${lastError || 'recent failure'}`);

    let s = sessions.get(key);
    // one message at a time per conversation
    const prev = s && s.busy ? s.busy.catch(() => {}) : Promise.resolve();
    let release;
    const mine = new Promise(r => { release = r; });
    if (s) s.busy = prev.then(() => mine);
    await prev;

    try {
        const g = await gem();
        const now = Date.now();
        if (!s || s.sig !== sig || now - s.last > CFG.SESSION_TTL_MS || s.turns >= CFG.MAX_TURNS) {
            s = { chat: g.createSession({ language }), sig, turns: 0, last: now, busy: s ? s.busy : mine };
            sessions.set(key, s);
        }
        const prompt = s.turns === 0 ? first() : next();
        const res = await withTimeout(s.chat.send(prompt), CFG.TIMEOUT_MS);
        const text = clean(res && res.text);
        if (!text) throw new Error('Empty Gemini-web reply');
        if (text.length < 400 && NOTICE.test(text)) throw new Error(`Gemini-web notice: ${text.slice(0, 80)}`);
        s.turns++;
        s.last = Date.now();
        downUntil = 0; lastError = '';
        return text;
    } catch (e) {
        sessions.delete(key);                                   // the next try starts a clean conversation
        // network errors (AggregateError ETIMEDOUT has an EMPTY message) and cookie errors → long pause, so the
        // bot doesn't wait for a dead connection on every message; it just answers via ai.dnuz.top
        const code = e.code || (e.errors && e.errors[0] && e.errors[0].code) || '';
        lastError = e.message || code || 'unknown error';
        const hard = AUTH.test(lastError) || /ETIMEDOUT|ENETUNREACH|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN/.test(`${code} ${lastError}`);
        downUntil = Date.now() + (hard ? CFG.AUTH_COOLDOWN_MS : CFG.FAIL_COOLDOWN_MS);
        if (!e.message) e.message = lastError;
        throw e;
    } finally {
        release();
    }
}

/** forget a conversation (e.g. the owner switched girl / reset her) */
const reset = (key) => { if (key) sessions.delete(key); else sessions.clear(); };

setInterval(() => {
    const now = Date.now();
    for (const [k, s] of sessions) if (now - s.last > CFG.SESSION_TTL_MS) sessions.delete(k);
}, 15 * 60_000).unref();

module.exports = {
    enabled, available, ask, reset, clean, CFG,
    status: () => ({ enabled: enabled(), conversations: sessions.size, downForMs: Math.max(0, downUntil - Date.now()), lastError }),
};
