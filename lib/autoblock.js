'use strict';
/**
 * lib/autoblock.js — a number that is not owner / sudo / trusted writes to the bot's inbox → it gets BLOCKED.
 *
 * pair.js calls guard() for every private message of someone who is not owner / sudo (groups, status, channels and bots are never touched).
 * plugins/autoblock.js is the owner's remote control (/autoblock on | off | status | allow | deny | unblock | notify).
 *
 * A wrong block is a real person who suddenly cannot reach the bot, so there are many safety checks:
 *   • never blocked: the owner, this linked number, sudo, trusted numbers, the allow-list (/autoblock allow, config.AUTO_BLOCK_ALLOW)
 *   • nothing in the first minute after a start (the sudo list is still loading) and nothing on old messages (the offline queue)
 *   • nothing while the settings cannot be read from MongoDB, and nothing when the phone number behind an @lid chat is unknown
 *   • at most 20 numbers per hour (AUTO_BLOCK_MAX_PER_HOUR); then it pauses and tells the owner — something must be wrong
 *   • every block is reported to the owner (/autoblock notify off), and /autoblock unblock <number> undoes it and allows the number from then on
 *
 * Switches: /autoblock on|off (kept in MongoDB) · env AUTO_BLOCK=off (hard off) · config.AUTO_BLOCK = false (the default when nothing is saved)
 */
const mongoose = require('mongoose');

let config = {};
try { config = require('../config'); } catch { /* optional */ }

const STARTED = Date.now();
const WARMUP_MS = 60_000;
const OLD_MESSAGE_SECONDS = 120;
const maxPerHour = () => (Number(process.env.AUTO_BLOCK_MAX_PER_HOUR) > 0 ? Number(process.env.AUTO_BLOCK_MAX_PER_HOUR) : 20);

const digitsOf = (x) => String(x || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const clip = (t, n = 80) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms).unref())]);
const isOff = (v) => /^(off|false|0|no)$/i.test(String(v));
const envOff = () => process.env.AUTO_BLOCK !== undefined && isOff(process.env.AUTO_BLOCK);

/** "0771234567" → 94771234567 (the Sri Lankan local form); anything else: its digits */
function normNumber(x) {
    const d = String(x || '').replace(/\D/g, '');
    return /^0\d{9}$/.test(d) ? `94${d.slice(1)}` : d;
}

// ═════════════════════════ the settings (MongoDB) ═════════════════════════
const BlockedSchema = new mongoose.Schema({ number: String, jid: String, name: String, text: String, at: Date }, { _id: false });
const Cfg = mongoose.models.AutoBlockCfg || mongoose.model('AutoBlockCfg', new mongoose.Schema({
    _id: String,
    enabled: { type: Boolean, default: true },
    notify: { type: Boolean, default: true },
    allow: { type: [String], default: [] },
    blocked: { type: [BlockedSchema], default: [] },
}, { minimize: false }));

let state = null;       // { enabled, notify, allow: Set, blocked: [] }  — null until it was read from MongoDB
let loading = null;

async function load() {
    if (state) return state;
    if (mongoose.connection.readyState !== 1) return null;       // MongoDB not connected (yet): nothing is blocked
    if (!loading) {
        loading = (async () => {
            const doc = await withTimeout(Cfg.findById('main').lean(), 3000);
            state = {
                enabled: doc ? doc.enabled !== false : !(config.AUTO_BLOCK !== undefined && isOff(config.AUTO_BLOCK)),
                notify: doc ? doc.notify !== false : true,
                allow: new Set(((doc && doc.allow) || []).map(normNumber).filter(Boolean)),
                blocked: ((doc && doc.blocked) || []).map((b) => ({ number: b.number, jid: b.jid, name: b.name, text: b.text, at: b.at })),
            };
            return state;
        })().catch((e) => {
            console.error('[autoblock] could not read the settings:', e && e.message);
            return null;
        }).finally(() => { loading = null; });
    }
    return loading;
}

async function save() {
    if (!state || mongoose.connection.readyState !== 1) return false;
    try {
        await withTimeout(Cfg.updateOne({ _id: 'main' }, {
            $set: { enabled: state.enabled, notify: state.notify, allow: [...state.allow], blocked: state.blocked.slice(-50) },
        }, { upsert: true }), 4000);
        return true;
    } catch (e) {
        console.error('[autoblock] could not save the settings:', e && e.message);
        return false;
    }
}

// ═════════════════════════ who is safe? ═════════════════════════
function safeDigits(sock, xnumber, st) {
    const out = new Set();
    const add = (x) => { const d = digitsOf(x); if (d) out.add(d); };
    [config.OWNER_NUMBER, config.OWNER_LID, xnumber, sock && sock.user && sock.user.id, sock && sock.user && sock.user.lid].forEach(add);
    (Array.isArray(global.sudoList) ? global.sudoList : []).forEach(add);
    (config.TRUSTED_NUMBERS || []).forEach((t) => add(t && t.number));
    (config.AUTO_BLOCK_ALLOW || []).forEach(add);
    st.allow.forEach((d) => out.add(d));
    return out;
}

/** the phone number behind this chat ('' when it is not known: an @lid chat WhatsApp gave no number for) */
async function resolvePn(sock, from, key) {
    const direct = key.senderPn || key.remoteJidAlt || key.participantPn;
    if (direct) return digitsOf(direct);
    if (/@s\.whatsapp\.net$/.test(from)) return digitsOf(from);
    try {
        const map = sock.signalRepository && sock.signalRepository.lidMapping;
        if (map && typeof map.getPNForLID === 'function') {
            const pn = await withTimeout(Promise.resolve(map.getPNForLID(from)), 2000);
            if (pn) return digitsOf(pn);
        }
    } catch { /* no mapping known */ }
    return '';
}

const tsOf = (mek) => {
    const t = mek && mek.messageTimestamp;
    return Number(t && typeof t.toNumber === 'function' ? t.toNumber() : t) || 0;
};

// ═════════════════════════ blocking ═════════════════════════
const recent = new Map();       // number → when it was handled: a burst from one stranger is handled once, and the bot stays silent
let stamps = [];                // when the last blocks happened (the per-hour limit)
let pausedNoticeAt = 0;
const logged = new Map();

function logOnce(key, msg) {
    const now = Date.now();
    if (now - (logged.get(key) || 0) > 3_600_000) {
        logged.set(key, now);
        console.log(`[autoblock] ${msg}`);
    }
}

function tellOwner(sock, text) {
    const number = digitsOf(config.OWNER_NUMBER) || digitsOf(sock && sock.user && sock.user.id);
    if (!number) return;
    Promise.resolve(sock.sendMessage(`${number}@s.whatsapp.net`, { text }, { _noAntiBan: true }))
        .catch((e) => console.error('[autoblock] could not tell the owner:', e && e.message));
}

async function blockNow(sock, mek, { from, pn, body }) {
    const now = Date.now();
    if (recent.has(pn) && now - recent.get(pn) < 5 * 60_000) return true;
    if (recent.size > 500) for (const [k, t] of recent) if (now - t > 5 * 60_000) recent.delete(k);

    stamps = stamps.filter((t) => now - t < 3_600_000);
    if (stamps.length >= maxPerHour()) {                 // far more than usual → something is wrong: stop blocking, just ignore strangers
        if (now - pausedNoticeAt > 3_600_000) {
            pausedNoticeAt = now;
            tellOwner(sock, `⚠️ *Auto-block paused*: ${stamps.length} numbers were blocked within an hour, that is more than expected. Nothing more is blocked for now (strangers are only ignored).\nCheck /autoblock status — if something is wrong: /autoblock off`);
        }
        return true;
    }

    recent.set(pn, now);
    let ok = false;
    let error = '';
    try {
        await sock.updateBlockStatus(from, 'block');
        ok = true;
    } catch (e) {
        error = (e && e.message) || String(e);
        if (!/@s\.whatsapp\.net$/.test(from)) {           // an @lid chat: try the phone-number form too
            try { await sock.updateBlockStatus(`${pn}@s.whatsapp.net`, 'block'); ok = true; error = ''; } catch (e2) { error = (e2 && e2.message) || String(e2); }
        }
    }
    if (!ok) {
        console.error(`[autoblock] could not block ${pn}: ${error}`);
        return true;
    }

    stamps.push(now);
    const name = clip(mek.pushName, 30);
    state.blocked.push({ number: pn, jid: from, name, text: clip(body, 80), at: new Date() });
    if (state.blocked.length > 50) state.blocked.splice(0, state.blocked.length - 50);
    save();
    console.log(`🚫 [autoblock] blocked ${pn}${name ? ` (${name})` : ''}`);
    if (state.notify) {
        tellOwner(sock, `🚫 *Auto-blocked* ${pn}${name ? ` (${name})` : ''}${body ? `\n"${clip(body, 60)}"` : ''}\nNot sudo → blocked.  Wrong? /autoblock unblock ${pn}`);
    }
    return true;
}

/**
 * pair.js: a private message of someone who is not owner / sudo.  true = handled (blocked / ignored) → pair.js must not go on with it.
 * false = go on as normal (also whenever anything is uncertain).
 */
async function guard(sock, mek, info) {
    try {
        const { from, sender, body, xnumber, eventType } = info;
        if (eventType !== 'notify') return false;                                                  // history / appended messages: nobody writes to the bot now
        if (!/^\d+(?::\d+)?@(?:s\.whatsapp\.net|lid)$/.test(String(from))) return false;          // not a person: group, status, channel, broadcast, bot
        if (Date.now() - STARTED < WARMUP_MS) return false;                                        // the sudo list is still loading right after a start
        const ts = tsOf(mek);
        if (ts && Date.now() / 1000 - ts > OLD_MESSAGE_SECONDS) return false;                      // an old message of the offline queue
        if (envOff()) return false;
        const st = await load();
        if (!st || !st.enabled) return false;

        const key = mek.key || {};
        const pn = await resolvePn(sock, from, key);
        const cands = [...new Set([from, sender, key.senderPn, key.remoteJidAlt, key.participantPn, pn].map(digitsOf).filter(Boolean))];
        if (cands.some((d) => d === '0' || d.length < 7)) return false;                            // WhatsApp's own account and other system numbers
        const safe = safeDigits(sock, xnumber, st);
        if (cands.some((d) => safe.has(d))) return false;                                          // owner, sudo, trusted, allow-list
        if (!pn) {
            logOnce(`lid:${digitsOf(from)}`, `skipped ${digitsOf(from)}: the phone number behind this @lid chat is not known`);
            return false;
        }
        return await blockNow(sock, mek, { from, pn, body });
    } catch (e) {
        console.error('[autoblock] guard error (the message goes on as normal):', e && e.message);
        return false;
    }
}

// ═════════════════════════ the owner's remote control (plugins/autoblock.js) ═════════════════════════
async function ready() {
    const st = await load();
    if (!st) throw new Error('MongoDB is not ready yet — try again in a moment');
    return st;
}

async function status() {
    const st = await load();
    if (!st) return { loaded: false };
    const now = Date.now();
    const lastHour = stamps.filter((t) => now - t < 3_600_000).length;
    return {
        loaded: true,
        enabled: st.enabled && !envOff(),
        envOff: envOff(),
        notify: st.notify,
        allow: [...st.allow],
        blocked: st.blocked.slice(-10).reverse(),
        blockedTotal: st.blocked.length,
        lastHour,
        maxPerHour: maxPerHour(),
        paused: lastHour >= maxPerHour(),
        warmingUp: now - STARTED < WARMUP_MS,
    };
}

async function setEnabled(on) { const st = await ready(); st.enabled = !!on; return save(); }
async function setNotify(on) { const st = await ready(); st.notify = !!on; return save(); }
async function allow(number) { const st = await ready(); st.allow.add(normNumber(number)); recent.delete(normNumber(number)); return save(); }
async function deny(number) { const st = await ready(); st.allow.delete(normNumber(number)); return save(); }

/** unblock on WhatsApp and allow the number from now on (otherwise its next message would block it again) */
async function unblock(sock, number) {
    const st = await ready();
    const n = normNumber(number);
    await sock.updateBlockStatus(`${n}@s.whatsapp.net`, 'unblock');
    st.allow.add(n);
    recent.delete(n);
    return save();
}

module.exports = { guard, status, setEnabled, setNotify, allow, deny, unblock, normNumber };
