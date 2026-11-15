'use strict';
/**
 * lib/gf/runctx.js — "which command run is this message coming from?"
 *
 * Uses AsyncLocalStorage, so every sendMessage() that happens (also after an `await`) inside a command run can be
 * attributed to that run, WITHOUT handing the plugin a wrapped copy of the socket. (A wrapped copy broke plugins that
 * remember the socket in a WeakSet to attach their own `conn.ev.on(...)` listener once: every run looked like a new socket.)
 *
 *  • counting   : did the command say or do anything?  (exec.js uses it to tell "done" from "silently failed")
 *  • claimReplies: some plugins ask a question and wait for the answer ("reply 1 = mobile, 2 = PC").
 *                  The id of every message such a run sends is remembered for 30 minutes; a message that REPLIES to one of them
 *                  belongs to the plugin, so she must not answer it as chat.
 */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const claimed = new Map();               // message id → expires
const CLAIM_MS = 30 * 60_000;
const ACTIVE = ['sendMessage', 'sendFileUrl', 'relayMessage', 'forwardMessage', 'edite', 'groupParticipantsUpdate', 'groupSettingUpdate'];
const instrumented = new WeakSet();

function claimReply(id) {
    if (!id) return;
    claimed.set(id, Date.now() + CLAIM_MS);
    if (claimed.size > 500) { const now = Date.now(); for (const [k, t] of claimed) if (t < now) claimed.delete(k); }
}
function isClaimed(id) {
    const t = claimed.get(id);
    if (!t) return false;
    if (t < Date.now()) { claimed.delete(id); return false; }
    return true;
}

/** wrap the socket's sending methods ONCE (idempotent); the socket object itself stays the same */
function instrument(sock) {
    if (!sock || instrumented.has(sock)) return sock;
    instrumented.add(sock);
    for (const name of ACTIVE) {
        const orig = sock[name];
        if (typeof orig !== 'function') continue;
        sock[name] = function (...args) {
            const st = als.getStore();
            if (st) {
                st.sent++;
                st.lastText = name === 'sendMessage' && args[1] && typeof args[1].text === 'string' ? args[1].text : '';
            }
            const res = orig.apply(this, args);
            if (st && st.claim && name === 'sendMessage') {
                Promise.resolve(res).then((r) => claimReply(r && r.key && r.key.id)).catch(() => {});
            }
            return res;
        };
    }
    return sock;
}

/** run fn with a fresh store: { sent, lastText, claim } */
const run = (store, fn) => als.run(store, fn);
const wantsClaims = (cmd) => !!(cmd && (cmd.claimReplies || (cmd.gf && typeof cmd.gf === 'object' && cmd.gf.claimReplies)));

module.exports = { instrument, run, isClaimed, claimReply, wantsClaims };
