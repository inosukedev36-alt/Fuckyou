'use strict';
/**
 * lib/antiban.js — makes the bot behave like a polite, human-paced WhatsApp client.
 *
 * Everything here is about HOW the bot behaves. Nothing in this file pretends to be another kind of device
 * or answers WhatsApp's own integrity checks — it only keeps the account from doing the things that get
 * numbers restricted: bursts, floods, copy-paste broadcasts, cold messaging, reconnect storms, permanent "online".
 *
 *  1. SEND GOVERNOR    every sendMessage / relayMessage goes through per-chat + global buckets (minute / hour / day),
 *                      a minimum gap between two messages to the same chat, and a "never hold a message longer than X" rule.
 *  2. REPLY vs PROACTIVE  a chat that wrote to the bot a moment ago gets replies; anything else is proactive.
 *                      Proactive messages are spread out (seconds apart) and, to people who never wrote first, capped.
 *  3. DUPLICATE GUARD  the same text again and again in one chat, or to many chats within minutes, is refused.
 *  4. HUMAN TYPING     "typing…" / "recording…" sized to the message, with jitter, before it is sent.
 *  5. PRESENCE         no permanent / flapping "online": the bot is online only while it is typing or replying,
 *                      then goes offline after a random idle time (pair.js also sets markOnlineOnConnect:false).
 *  6. SERVER PUSHBACK  a rate-overlimit style error starts an exponential cool-down for everything except the owner.
 *  7. RECONNECT POLICY exponential back-off with jitter, aware of the close code (515 restart, 440 replaced, 403, 401).
 *  8. INBOUND HYGIENE  old (offline-queue) messages are not answered in a burst; one person cannot make the bot
 *                      answer dozens of commands a minute.
 *  9. GROUP ACTIONS    add / remove / promote / demote are spaced out and `add` is capped per hour.
 * 10. WARM-UP (opt-in) a freshly linked number is held to a fraction of the normal limits for its first weeks.
 *
 * No tool can promise that a number is never banned — unofficial clients can always be restricted.
 * This lowers the risk by removing the bot-shaped behaviour; it does not remove it.
 *
 * Settings live in config.js → ANTIBAN (everything has a default here, so the block is optional).
 */

const DEFAULTS = {
    ENABLED: true,
    LOG: true,
    SEND: {
        PER_CHAT_BURST: 8,            // messages that may go to one chat back-to-back…
        PER_CHAT_PER_MIN: 30,         // …then this many per minute
        GLOBAL_BURST: 15,
        GLOBAL_PER_MIN: 45,
        GLOBAL_PER_HOUR: 900,
        GLOBAL_PER_DAY: 7000,
        MIN_GAP_MS: [600, 1400],      // pause between two messages to the same chat (random in range)
        PROACTIVE_GAP_MS: [4000, 9000], // pause between two messages that are NOT replies (random in range)
        REPLY_WINDOW_SEC: 300,        // a chat that wrote to the bot within this time = replies are "replies"
        MAX_WAIT_MS: 90000,           // never hold a message longer than this; beyond it the send is refused
        LIGHT_WEIGHT: 0.3,            // reactions / deletes / edits count this much of a message
    },
    COLD: { PER_HOUR: 15, PER_DAY: 60, KNOWN_HOURS: 72 },   // NEW 1:1 chats the bot starts itself (people who never wrote first)
    DUPLICATE: {
        ENABLED: true,
        MIN_LEN: 4,                   // shorter texts are not checked
        PER_CHAT_MAX: 3,              // the same text this many times…
        PER_CHAT_WINDOW_SEC: 60,      // …within this many seconds in ONE chat
        ACROSS_CHATS_MAX: 8,          // the same text to this many OTHER chats…
        ACROSS_WINDOW_SEC: 600,       // …within this many seconds
    },
    TYPING: { ENABLED: true, PER_CHAR_MS: 32, MIN_MS: 700, MAX_MS: 3500, MEDIA_MS: [500, 1400], VOICE_MS: [1200, 3200] },
    PRESENCE: { ENABLED: true, IDLE_OFFLINE_SEC: [25, 75] },
    INBOUND: {
        STALE_SEC: 180,               // commands older than this (offline queue) are ignored. 0 = off
        PER_USER_MAX: 8,              // commands from one person…
        PER_USER_WINDOW_SEC: 60,      // …per this many seconds; more = ignored…
        PENALTY_SEC: 120,             // …for this long
        GLOBAL_MAX: 60,               // commands from everybody (except owner/sudo) per window
        GLOBAL_WINDOW_SEC: 60,
    },
    GROUP_ACTIONS: { ADD_PER_HOUR: 10, MIN_GAP_MS: [2500, 6000] },
    PUSHBACK: { COOLDOWN_SEC: [120, 1800], DECAY_MIN: 30 },
    RECONNECT: {
        BASE_MS: 5000, MAX_MS: 300000, JITTER: 0.3,
        STABLE_AFTER_SEC: 120,        // a connection that lived this long resets the back-off
        MAX_PER_HOUR: 12, COOLDOWN_SEC: 900,
        ON_REPLACED: 'stop',          // 440: the same session is open elsewhere → 'stop' (do not fight it) | 'retry'
        ON_FORBIDDEN: 'stop',         // 403: WhatsApp refuses the session → 'stop' | 'retry'
    },
    WARMUP: { LINKED_AT: '' },        // 'YYYY-MM-DD' = the day this number was first linked. '' = off
};

// ───────────────────────── small helpers ─────────────────────────
const isPlain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

function deepMerge(base, extra) {
    const out = {};
    for (const k of Object.keys(base)) out[k] = isPlain(base[k]) ? deepMerge(base[k], {}) : (Array.isArray(base[k]) ? base[k].slice() : base[k]);
    for (const k of Object.keys(extra || {})) {
        if (isPlain(extra[k]) && isPlain(out[k])) out[k] = deepMerge(out[k], extra[k]);
        else if (extra[k] !== undefined) out[k] = Array.isArray(extra[k]) ? extra[k].slice() : extra[k];
    }
    return out;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const digitsOf = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const normText = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
function fnv(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
}
function fmtLeft(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}
const quiet = (fn) => { try { const r = fn(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) {} };

class AntiBanError extends Error {
    constructor(code, message, retryInMs = 0) {
        super(message);
        this.name = 'AntiBanError';
        this.code = code;
        this.retryInMs = retryInMs;
        this.antiban = true;
    }
}

/** token bucket with "reservation" semantics: take() may push it below zero, wait() then reports the debt */
class Bucket {
    constructor(cap, perSec, now) {
        this.baseCap = cap; this.baseRate = perSec;
        this.cap = cap; this.rate = perSec;
        this.tokens = cap; this.now = now; this.at = now();
    }
    scale(f) {
        this.cap = Math.max(1, this.baseCap * f);
        this.rate = Math.max(1e-6, this.baseRate * f);
        if (this.tokens > this.cap) this.tokens = this.cap;
    }
    refill() {
        const t = this.now();
        if (t > this.at) this.tokens = Math.min(this.cap, this.tokens + ((t - this.at) / 1000) * this.rate);
        this.at = t;
    }
    wait(n) { this.refill(); const missing = n - this.tokens; return missing <= 0 ? 0 : Math.ceil((missing / this.rate) * 1000); }
    take(n) { this.refill(); this.tokens -= n; }
    level() { this.refill(); return this.tokens; }
}

// ───────────────────────── the engine ─────────────────────────
function create(userCfg = {}, deps = {}) {
    const cfg = deepMerge(DEFAULTS, userCfg || {});
    const S = cfg.SEND, C = cfg.COLD, D = cfg.DUPLICATE, T = cfg.TYPING, P = cfg.PRESENCE, I = cfg.INBOUND;
    const G = cfg.GROUP_ACTIONS, PB = cfg.PUSHBACK, R = cfg.RECONNECT;

    const now = deps.now || Date.now;
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const rand = deps.rand || Math.random;
    const setT = deps.setTimeout || setTimeout;
    const clearT = deps.clearTimeout || clearTimeout;
    const out = deps.log || ((...a) => console.log(...a));

    const randIn = (a, b) => { const lo = Math.min(a, b), hi = Math.max(a, b); return Math.floor(lo + rand() * (hi - lo + 1)); };
    const range = (pair) => randIn(pair[0], pair[1]);
    const jittered = (ms, frac) => Math.max(0, Math.round(ms * (1 + (rand() * 2 - 1) * frac)));

    const lastLogged = new Map();
    const say = (msg) => { if (cfg.LOG) out(msg); };
    const sayOnce = (key, msg, everyMs = 30000) => {
        const t = now();
        if (t - (lastLogged.get(key) || 0) < everyMs) return;
        lastLogged.set(key, t);
        say(msg);
    };

    // ── state ──
    const st = {
        enabled: !!cfg.ENABLED,
        strikes: 0, lastStrikeAt: 0, cooldownUntil: 0,
        panicUntil: 0, panicReason: '',
        stats: { sent: 0, light: 0, blocked: 0, errors: 0, pushbacks: 0, delayedMs: 0, staleSkipped: 0, commandsIgnored: 0 },
    };
    const gMin = new Bucket(S.GLOBAL_BURST, S.GLOBAL_PER_MIN / 60, now);
    const gHour = new Bucket(S.GLOBAL_PER_HOUR, S.GLOBAL_PER_HOUR / 3600, now);
    const gDay = new Bucket(S.GLOBAL_PER_DAY, S.GLOBAL_PER_DAY / 86400, now);
    const addBucket = new Bucket(G.ADD_PER_HOUR, G.ADD_PER_HOUR / 3600, now);
    const chatBuckets = new Map();   // jid → { b, at }
    const lastSend = new Map();      // jid → planned send time of the last message
    const lastInbound = new Map();   // jid → when this chat last wrote to the bot
    const known = new Map();         // digits → when this person last wrote to the bot 1:1
    const coldSeen = new Map();      // digits → when the bot first wrote to them (they had not written first)
    const dupChat = new Map();       // jid|hash → [timestamps]
    const dupAcross = new Map();     // hash → Map(jid → timestamp)
    const userHits = new Map();      // sender → [timestamps of commands]
    const ignoreUntil = new Map();   // sender → timestamp
    const globalHits = [];           // timestamps of commands from non-privileged senders
    const sentLog = [];              // planned send times of the last 24h (status only)
    const chains = new Map();        // jid → promise tail (keeps sends to one chat in order)
    const sessions = new Map();      // sessionId → controller
    const conn = new Map();          // sessionId → reconnect state
    let nextProactiveAt = 0;
    let nextGroupAction = 0;

    const linkedAt = cfg.WARMUP && cfg.WARMUP.LINKED_AT ? Date.parse(cfg.WARMUP.LINKED_AT) : NaN;
    function warmFactor(t = now()) {
        if (!Number.isFinite(linkedAt)) return 1;
        const days = (t - linkedAt) / 86400000;
        if (days < 2) return 0.25;
        if (days < 5) return 0.4;
        if (days < 10) return 0.6;
        if (days < 20) return 0.8;
        return 1;
    }

    function mode(t = now()) {
        if (st.panicUntil > t) return { name: 'panic', until: st.panicUntil, blocked: true };
        if (st.cooldownUntil > t) return { name: 'cooldown', until: st.cooldownUntil, blocked: true };
        return { name: 'normal', until: 0, blocked: false };
    }

    function block(code, message, retryInMs = 0) {
        st.stats.blocked++;
        sayOnce(`block:${code}`, `🛡️ [antiban] refused (${code}): ${message}`);
        return new AntiBanError(code, `🛡️ anti-ban: ${message}`, retryInMs);
    }

    // ───────────── classification ─────────────
    // 'free' / 'self' → never throttled · 'owner' → throttled lightly, never paused · 'group' / 'user' / 'status' → full rules
    function classify(ctl, jid) {
        if (typeof jid !== 'string' || !jid) return 'free';
        if (jid.endsWith('@newsletter')) return 'free';
        if (jid.endsWith('@g.us')) return 'group';
        if (jid === 'status@broadcast') return 'status';
        if (ctl.selfDigits().has(digitsOf(jid))) return 'self';
        if (ctl.privileged(jid)) return 'owner';
        return 'user';
    }

    function describe(content) {
        const c = content || {};
        if (c.react !== undefined || c.delete !== undefined || c.edit !== undefined) return { kind: 'light', text: '' };
        const text = typeof c.text === 'string' ? c.text : (typeof c.caption === 'string' ? c.caption : '');
        if (c.audio) return { kind: c.ptt ? 'voice' : 'media', text };
        if (c.image || c.video || c.document || c.sticker) return { kind: 'media', text };
        if (c.forward) return { kind: 'forward', text };
        if (typeof c.text === 'string') return { kind: 'text', text };
        return { kind: 'other', text };
    }

    // ───────────── hard rules (throw before anything is reserved) ─────────────
    function dupCheck(jid, text, t) {
        if (!D.ENABLED) return null;
        const n = normText(text);
        if (n.length < D.MIN_LEN) return null;
        const h = fnv(n);
        const k = `${jid}|${h}`;
        const arr = (dupChat.get(k) || []).filter((x) => t - x <= D.PER_CHAT_WINDOW_SEC * 1000);
        if (arr.length >= D.PER_CHAT_MAX) {
            throw block('duplicate', `the same message was already sent ${arr.length}× to this chat in the last ${D.PER_CHAT_WINDOW_SEC}s`, D.PER_CHAT_WINDOW_SEC * 1000);
        }
        let distinct = 0;
        const m = dupAcross.get(h);
        if (m) for (const [j, at] of m) if (j !== jid && t - at <= D.ACROSS_WINDOW_SEC * 1000) distinct++;
        if (distinct >= D.ACROSS_CHATS_MAX) {
            throw block('broadcast', `the same message already went to ${distinct} other chats in the last ${Math.round(D.ACROSS_WINDOW_SEC / 60)} min`, D.ACROSS_WINDOW_SEC * 1000);
        }
        return { k, h, arr };
    }
    function dupRecord(ticket, jid, t) {
        if (!ticket) return;
        ticket.arr.push(t);
        dupChat.set(ticket.k, ticket.arr);
        let m = dupAcross.get(ticket.h);
        if (!m) { m = new Map(); dupAcross.set(ticket.h, m); }
        m.set(jid, t);
    }

    function coldCheck(jid, t, f) {
        const d = digitsOf(jid);
        if (!d) return null;
        const kn = known.get(d);
        if (kn && t - kn <= C.KNOWN_HOURS * 3600000) return null;            // they wrote to the bot recently → not cold
        const seen = coldSeen.get(d);
        if (seen && t - seen <= 86400000) return null;                        // already counted today
        let hour = 0, day = 0;
        for (const at of coldSeen.values()) { if (t - at <= 3600000) hour++; if (t - at <= 86400000) day++; }
        const perHour = Math.max(1, Math.floor(C.PER_HOUR * f));
        const perDay = Math.max(1, Math.floor(C.PER_DAY * f));
        if (hour >= perHour) throw block('cold-hour', `already started ${hour} new chats this hour (limit ${perHour})`, 3600000);
        if (day >= perDay) throw block('cold-day', `already started ${day} new chats in 24h (limit ${perDay})`, 86400000);
        return d;
    }

    function chatBucket(jid, t) {
        let e = chatBuckets.get(jid);
        if (!e) { e = { b: new Bucket(S.PER_CHAT_BURST, S.PER_CHAT_PER_MIN / 60, now), at: t }; chatBuckets.set(jid, e); }
        e.at = t;
        return e.b;
    }

    // ───────────── the governor ─────────────
    async function admit(ctl, jid, info, cls) {
        const t = now();
        const light = info.kind === 'light';
        if (st.strikes > 0 && t - st.lastStrikeAt > PB.DECAY_MIN * 60000) { st.strikes--; st.lastStrikeAt = t; }

        const priv = cls === 'owner';
        const m = mode(t);
        if (m.blocked && !priv) {
            throw block(m.name,
                m.name === 'panic'
                    ? `sending is paused (${st.panicReason || 'panic'}) — ${fmtLeft(m.until - t)} left`
                    : `cooling down after a WhatsApp rate-limit warning — ${fmtLeft(m.until - t)} left`,
                m.until - t);
        }

        const f = warmFactor(t);
        const li = lastInbound.get(jid);
        const proactive = !priv && !(li !== undefined && t - li <= S.REPLY_WINDOW_SEC * 1000);
        const weight = light ? S.LIGHT_WEIGHT : 1;

        let dupTicket = null, coldKey = null;
        if (!light && !priv) {
            dupTicket = dupCheck(jid, info.text, t);
            if (proactive && cls === 'user') coldKey = coldCheck(jid, t, f);
        }

        gMin.scale(f); gHour.scale(f); gDay.scale(f);
        const cb = chatBucket(jid, t);
        let wait = Math.max(gMin.wait(weight), gHour.wait(weight), gDay.wait(weight), cb.wait(weight));
        let slot = 0;
        if (!light) {
            wait = Math.max(wait, (lastSend.get(jid) || 0) + range(S.MIN_GAP_MS) - t);
            if (proactive) { slot = Math.max(t, nextProactiveAt); wait = Math.max(wait, slot - t); }
        }
        wait = Math.max(0, wait);
        if (wait > S.MAX_WAIT_MS) throw block('rate-cap', `too many messages right now (would have to wait ${fmtLeft(wait)})`, wait);

        // commit
        gMin.take(weight); gHour.take(weight); gDay.take(weight); cb.take(weight);
        if (!light) {
            sentLog.push(t + wait);
            lastSend.set(jid, t + wait);
            if (proactive) nextProactiveAt = slot + range(S.PROACTIVE_GAP_MS);
            dupRecord(dupTicket, jid, t);
            if (coldKey) coldSeen.set(coldKey, t);
        }
        if (wait > 0) { st.stats.delayedMs += wait; await sleep(wait); }
    }

    // keeps messages to ONE chat in order and one at a time
    function serial(key, fn) {
        const prev = chains.get(key) || Promise.resolve();
        const run = prev.then(fn);
        const tail = run.catch(() => {});
        chains.set(key, tail);
        tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
        return run;
    }

    // ───────────── presence (online only while active) ─────────────
    function armIdle(ctl) {
        if (ctl.offTimer) clearT(ctl.offTimer);
        ctl.offTimer = setT(() => goOffline(ctl), Math.max(0, range(P.IDLE_OFFLINE_SEC) * 1000));
        if (ctl.offTimer && typeof ctl.offTimer.unref === 'function') ctl.offTimer.unref();
    }
    function goOffline(ctl) {
        ctl.offTimer = null;
        if (ctl.stopped || !ctl.online) return;
        ctl.online = false;
        quiet(() => ctl.raw.sendPresenceUpdate('unavailable'));
    }
    function presenceTouch(ctl) {
        if (!P.ENABLED || ctl.stopped) return;
        if (!ctl.online) { ctl.online = true; quiet(() => ctl.raw.sendPresenceUpdate('available')); }
        armIdle(ctl);
    }

    function withTimeout(p, ms) {
        return new Promise((resolve) => {
            const timer = setT(() => resolve(), ms);
            Promise.resolve(p).then(() => { clearT(timer); resolve(); }, () => { clearT(timer); resolve(); });
        });
    }

    // "typing…" / "recording…" sized to what is about to be sent
    async function humanize(ctl, jid, info) {
        if (!T.ENABLED || jid === 'status@broadcast') return;
        let state = 'composing', ms;
        if (info.kind === 'text') ms = clamp(Math.round(info.text.length * T.PER_CHAR_MS * (0.75 + rand() * 0.6) + 350), T.MIN_MS, T.MAX_MS);
        else if (info.kind === 'voice') { state = 'recording'; ms = range(T.VOICE_MS); }
        else if (info.kind === 'media') ms = range(T.MEDIA_MS);
        else return;
        await withTimeout(ctl.sock.sendPresenceUpdate(state, jid), 2000);
        await sleep(ms);
        await withTimeout(ctl.sock.sendPresenceUpdate('paused', jid), 2000);
        await sleep(randIn(120, 380));
    }

    // ───────────── server pushback ─────────────
    function pushback(reason) {
        const t = now();
        st.strikes = Math.min(6, st.strikes + 1);
        st.lastStrikeAt = t;
        st.stats.pushbacks++;
        const sec = clamp(PB.COOLDOWN_SEC[0] * Math.pow(2, st.strikes - 1), PB.COOLDOWN_SEC[0], PB.COOLDOWN_SEC[1]);
        st.cooldownUntil = t + sec * 1000;
        say(`🛡️ [antiban] ${reason} → pausing everything except the owner chat for ${fmtLeft(sec * 1000)} (strike ${st.strikes})`);
    }
    function onSendError(e) {
        st.stats.errors++;
        if (e && e.antiban) return;
        const msg = String((e && (e.message || e.data)) || e || '');
        const code = Number((e && ((e.output && e.output.statusCode) || e.statusCode)) || 0);
        if (code === 429 || /rate-overlimit|rate limit|too many requests/i.test(msg)) pushback(`WhatsApp pushed back (${msg.slice(0, 60)})`);
    }
    async function track(ctl, jid, info, fn) {
        if (info.kind === 'light') st.stats.light++; else { st.stats.sent++; presenceTouch(ctl); }
        try { return await fn(); } catch (e) { onSendError(e); throw e; }
    }

    // ───────────── wiring onto a socket ─────────────
    function attach(sock, opts = {}) {
        const sessionId = opts.sessionId || 'default';
        detach(sessionId);
        const ctl = {
            sessionId, sock, stopped: false, online: false, offTimer: null,
            number: digitsOf(opts.number),
            privileged: typeof opts.privileged === 'function' ? opts.privileged : () => false,
            raw: {
                sendMessage: sock.sendMessage.bind(sock),
                relayMessage: typeof sock.relayMessage === 'function' ? sock.relayMessage.bind(sock) : null,
                sendPresenceUpdate: typeof sock.sendPresenceUpdate === 'function' ? sock.sendPresenceUpdate.bind(sock) : async () => {},
                groupParticipantsUpdate: typeof sock.groupParticipantsUpdate === 'function' ? sock.groupParticipantsUpdate.bind(sock) : null,
            },
            selfDigits() {
                const s = new Set();
                for (const x of [this.number, sock.user && sock.user.id, sock.user && sock.user.lid]) { const d = digitsOf(x); if (d) s.add(d); }
                return s;
            },
        };
        const live = () => st.enabled && !ctl.stopped;

        sock.sendMessage = (jid, content, options = {}, ...rest) => {
            if (!live()) return ctl.raw.sendMessage(jid, content, options, ...rest);
            const cls = classify(ctl, jid);
            if (cls === 'free' || cls === 'self') return ctl.raw.sendMessage(jid, content, options, ...rest);
            const info = describe(content);
            if (info.kind === 'light') {
                return admit(ctl, jid, info, cls).then(() => track(ctl, jid, info, () => ctl.raw.sendMessage(jid, content, options, ...rest)));
            }
            // only the waiting + typing part is queued per chat (keeps order and spacing); the network send itself is not,
            // so one slow upload can never block the next message to the same chat
            return serial(jid, async () => {
                await admit(ctl, jid, info, cls);
                if (!(options && options._noAntiBan)) await humanize(ctl, jid, info);
            }).then(() => track(ctl, jid, info, () => ctl.raw.sendMessage(jid, content, options, ...rest)));
        };

        if (ctl.raw.relayMessage) {
            sock.relayMessage = (jid, message, ropts, ...rest) => {
                if (!live()) return ctl.raw.relayMessage(jid, message, ropts, ...rest);
                const cls = classify(ctl, jid);
                if (cls === 'free' || cls === 'self') return ctl.raw.relayMessage(jid, message, ropts, ...rest);
                const light = !!(message && (message.protocolMessage || message.reactionMessage || message.editedMessage));
                const info = { kind: light ? 'light' : 'relay', text: '' };
                if (light) return admit(ctl, jid, info, cls).then(() => track(ctl, jid, info, () => ctl.raw.relayMessage(jid, message, ropts, ...rest)));
                return serial(jid, () => admit(ctl, jid, info, cls)).then(() => track(ctl, jid, info, () => ctl.raw.relayMessage(jid, message, ropts, ...rest)));
            };
        }

        if (ctl.raw.groupParticipantsUpdate) {
            sock.groupParticipantsUpdate = async (jid, participants, action, ...rest) => {
                if (!live()) return ctl.raw.groupParticipantsUpdate(jid, participants, action, ...rest);
                await groupGate(action, Array.isArray(participants) ? participants.length : 1);
                try { return await ctl.raw.groupParticipantsUpdate(jid, participants, action, ...rest); } catch (e) { onSendError(e); throw e; }
            };
        }

        // chat-state / presence calls made by plugins keep the "online while active" bookkeeping honest
        sock.sendPresenceUpdate = async (type, toJid, ...rest) => {
            if (!live() || !P.ENABLED) return ctl.raw.sendPresenceUpdate(type, toJid, ...rest);
            if (type === 'available') { ctl.online = true; armIdle(ctl); return ctl.raw.sendPresenceUpdate(type, toJid, ...rest); }
            if (type === 'unavailable') {
                ctl.online = false;
                if (ctl.offTimer) { clearT(ctl.offTimer); ctl.offTimer = null; }
                return ctl.raw.sendPresenceUpdate(type, toJid, ...rest);
            }
            presenceTouch(ctl);   // composing / recording / paused = somebody is "using the app" right now
            return ctl.raw.sendPresenceUpdate(type, toJid, ...rest);
        };

        sessions.set(sessionId, ctl);
        say(`🛡️ [antiban] active for ${sessionId} (send governor · human typing · online-only-while-active · group-action limits)`);
        return ctl;
    }

    function detach(sessionId) {
        const ctl = sessions.get(sessionId);
        if (!ctl) return;
        ctl.stopped = true;
        if (ctl.offTimer) { clearT(ctl.offTimer); ctl.offTimer = null; }
        sessions.delete(sessionId);
    }

    async function groupGate(action, count) {
        const t = now();
        const m = mode(t);
        if (m.blocked) throw block(m.name, `group actions are paused — ${fmtLeft(m.until - t)} left`, m.until - t);
        const slot = Math.max(t, nextGroupAction);
        const wait = slot - t;
        if (wait > S.MAX_WAIT_MS) throw block('group-queue', `too many group actions queued (would have to wait ${fmtLeft(wait)})`, wait);
        if (action === 'add') {
            addBucket.scale(warmFactor(t));
            const w = addBucket.wait(count);
            if (w > 0) throw block('add-cap', `adding members is limited to ${G.ADD_PER_HOUR} per hour — try again in ${fmtLeft(w)}`, w);
            addBucket.take(count);
        }
        nextGroupAction = slot + range(G.MIN_GAP_MS);
        if (wait > 0) { st.stats.delayedMs += wait; await sleep(wait); }
    }

    // ───────────── inbound hygiene ─────────────
    function noteInbound(mek, opts = {}) {
        try {
            const key = mek && mek.key;
            if (!key || typeof key.remoteJid !== 'string') return;
            const jid = key.remoteJid;
            const t = now();
            lastInbound.set(jid, t);
            if (opts && opts.own) return;   // typed by the owner on the paired phone: replies to it are replies, but it says nothing about who wrote to the bot first
            if (!jid.endsWith('@g.us') && !jid.endsWith('@newsletter') && jid !== 'status@broadcast') {
                const d = digitsOf(jid);
                if (d) known.set(d, t);
                for (const alt of [key.senderPn, key.participantPn, key.remoteJidAlt]) {   // the other form (phone number / LID) of the same person
                    const a = digitsOf(alt);
                    if (a) known.set(a, t);
                }
            }
            if (lastInbound.size > 20000) prune();
        } catch (e) {}
    }

    function isStale(mek) {
        if (!st.enabled || !I.STALE_SEC) return false;
        let ts = mek && mek.messageTimestamp;
        if (ts && typeof ts === 'object') ts = typeof ts.toNumber === 'function' ? ts.toNumber() : Number(ts.low !== undefined ? ts.low : ts);
        ts = Number(ts);
        if (!Number.isFinite(ts) || ts <= 0) return false;
        const stale = now() - ts * 1000 > I.STALE_SEC * 1000;
        if (stale) st.stats.staleSkipped++;
        return stale;
    }

    function allowCommand({ sender, privileged } = {}) {
        if (!st.enabled || privileged) return true;
        const t = now();
        const key = String(sender || '');
        const until = ignoreUntil.get(key);
        if (until && until > t) { st.stats.commandsIgnored++; return false; }
        if (until) ignoreUntil.delete(key);
        while (globalHits.length && t - globalHits[0] > I.GLOBAL_WINDOW_SEC * 1000) globalHits.shift();
        if (globalHits.length >= I.GLOBAL_MAX) {
            st.stats.commandsIgnored++;
            sayOnce('inbound-global', `🛡️ [antiban] ${globalHits.length} commands in ${I.GLOBAL_WINDOW_SEC}s from non-owners — ignoring the extra ones`);
            return false;
        }
        const arr = (userHits.get(key) || []).filter((x) => t - x <= I.PER_USER_WINDOW_SEC * 1000);
        if (arr.length >= I.PER_USER_MAX) {
            ignoreUntil.set(key, t + I.PENALTY_SEC * 1000);
            userHits.delete(key);
            st.stats.commandsIgnored++;
            sayOnce(`inbound:${key}`, `🛡️ [antiban] ${key} sent ${arr.length} commands in ${I.PER_USER_WINDOW_SEC}s — ignoring them for ${I.PENALTY_SEC}s`);
            return false;
        }
        arr.push(t);
        userHits.set(key, arr);
        globalHits.push(t);
        return true;
    }

    // ───────────── reconnect policy ─────────────
    function cstate(id) {
        let s = conn.get(id);
        if (!s) { s = { attempts: 0, history: [], restarts: [], openAt: 0 }; conn.set(id, s); }
        return s;
    }
    function opened(id) { cstate(id).openAt = now(); }

    /** → { action: 'retry' | 'stop' | 'logout', delayMs, reason } */
    function decide(id, statusCode) {
        const t = now();
        const s = cstate(id);
        if (s.openAt && t - s.openAt >= R.STABLE_AFTER_SEC * 1000) { s.attempts = 0; s.history = []; }
        s.openAt = 0;
        const code = Number(statusCode) || 0;

        if (code === 401) return { action: 'logout', delayMs: 0, reason: 'logged out from the phone' };
        if (code === 403 && R.ON_FORBIDDEN !== 'retry') {
            return { action: 'stop', delayMs: 0, reason: '403 forbidden — WhatsApp refused this session (restricted / banned number?), not hammering it' };
        }
        if (code === 440 && R.ON_REPLACED !== 'retry') {
            return { action: 'stop', delayMs: 0, reason: 'connection replaced — this session is open somewhere else, not fighting it' };
        }
        if (code === 515) {   // "restart required" is normal right after pairing; many in a row is a failure
            s.restarts = s.restarts.filter((x) => t - x < 300000);
            s.restarts.push(t);
            if (s.restarts.length <= 5) return { action: 'retry', delayMs: randIn(800, 2000), reason: 'restart required' };
        }

        s.attempts++;
        s.history = s.history.filter((x) => t - x < 3600000);
        s.history.push(t);
        if (s.history.length > R.MAX_PER_HOUR) {
            s.attempts = 0; s.history = [];
            return { action: 'retry', delayMs: jittered(R.COOLDOWN_SEC * 1000, R.JITTER), reason: `more than ${R.MAX_PER_HOUR} reconnects in an hour — cooling down` };
        }
        let delay = clamp(jittered(R.BASE_MS * Math.pow(2, s.attempts - 1), R.JITTER), 1000, R.MAX_MS);
        if (code === 440) delay = Math.max(delay, 30000);
        return { action: 'retry', delayMs: delay, reason: `attempt ${s.attempts}` };
    }

    // ───────────── controls / status ─────────────
    function panic(minutes = 30, reason = 'manual') {
        st.panicUntil = now() + clamp(Number(minutes) || 30, 1, 1440) * 60000;
        st.panicReason = reason;
        say(`🛡️ [antiban] PANIC pause for ${fmtLeft(st.panicUntil - now())} (${reason})`);
        return st.panicUntil;
    }
    function resume() { st.panicUntil = 0; st.cooldownUntil = 0; st.strikes = 0; st.panicReason = ''; }
    function setEnabled(v) { st.enabled = !!v; }

    function prune() {
        const t = now();
        for (const [k, v] of lastInbound) if (t - v > 3600000) lastInbound.delete(k);
        for (const [k, v] of known) if (t - v > C.KNOWN_HOURS * 3600000) known.delete(k);
        for (const [k, v] of coldSeen) if (t - v > 86400000) coldSeen.delete(k);
        for (const [k, arr] of dupChat) {
            const keep = arr.filter((x) => t - x <= D.PER_CHAT_WINDOW_SEC * 1000);
            if (keep.length) dupChat.set(k, keep); else dupChat.delete(k);
        }
        for (const [h, m] of dupAcross) {
            for (const [j, at] of m) if (t - at > D.ACROSS_WINDOW_SEC * 1000) m.delete(j);
            if (!m.size) dupAcross.delete(h);
        }
        for (const [k, v] of chatBuckets) if (t - v.at > 3600000) chatBuckets.delete(k);
        for (const [k, v] of lastSend) if (t - v > 3600000) lastSend.delete(k);
        for (const [k, v] of ignoreUntil) if (v < t) ignoreUntil.delete(k);
        for (const [k, arr] of userHits) {
            const keep = arr.filter((x) => t - x <= I.PER_USER_WINDOW_SEC * 1000);
            if (keep.length) userHits.set(k, keep); else userHits.delete(k);
        }
        while (sentLog.length && sentLog[0] < t - 86400000) sentLog.shift();
        if (lastInbound.size > 20000) { let n = lastInbound.size - 15000; for (const k of lastInbound.keys()) { if (n-- <= 0) break; lastInbound.delete(k); } }
    }
    if (!deps.noTimers) { const iv = setInterval(prune, 300000); if (iv.unref) iv.unref(); }

    function status() {
        const t = now();
        prune();
        const m = mode(t);
        let min = 0, hour = 0, day = 0, queued = 0;
        for (const x of sentLog) {
            if (x > t) { queued++; continue; }
            const age = t - x;
            if (age <= 60000) min++;
            if (age <= 3600000) hour++;
            if (age <= 86400000) day++;
        }
        let coldH = 0, coldD = 0;
        for (const at of coldSeen.values()) { if (t - at <= 3600000) coldH++; if (t - at <= 86400000) coldD++; }
        const f = warmFactor(t);
        return {
            enabled: st.enabled,
            mode: m.name, modeLeftMs: m.blocked ? m.until - t : 0, panicReason: st.panicReason,
            strikes: st.strikes,
            warmup: { active: Number.isFinite(linkedAt) && f < 1, factor: f },
            sent: { lastMinute: min, lastHour: hour, last24h: day, queued },
            limits: {
                perMinute: Math.round(S.GLOBAL_PER_MIN * f), perHour: Math.round(S.GLOBAL_PER_HOUR * f), perDay: Math.round(S.GLOBAL_PER_DAY * f),
                perChatPerMinute: S.PER_CHAT_PER_MIN,
                coldPerHour: Math.max(1, Math.floor(C.PER_HOUR * f)), coldPerDay: Math.max(1, Math.floor(C.PER_DAY * f)),
                addPerHour: Math.max(1, Math.round(G.ADD_PER_HOUR * f)),
            },
            cold: { lastHour: coldH, last24h: coldD },
            stats: { ...st.stats },
            sessions: [...sessions.values()].map((c) => ({ id: c.sessionId, online: c.online })),
            reconnect: [...conn.entries()].map(([id, s]) => ({ id, attempts: s.attempts, lastHour: s.history.filter((x) => t - x < 3600000).length })),
        };
    }

    return {
        cfg, DEFAULTS, AntiBanError, create, fmtLeft,
        attach, detach,
        noteInbound, isStale, allowCommand,
        decideReconnect: decide, connectionOpened: opened,
        status, panic, resume, setEnabled, isEnabled: () => st.enabled,
        _prune: prune,
    };
}

let userCfg = {};
try { userCfg = require('../config').ANTIBAN || {}; } catch (e) { /* defaults are fine */ }

module.exports = create(userCfg);
