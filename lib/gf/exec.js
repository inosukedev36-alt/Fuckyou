'use strict';
/**
 * lib/gf/exec.js — runs a bot command ON BEHALF of the person who asked her.
 *
 * Golden rule: she can never do more than the human could do by typing the command themselves.
 *   • owner / sudo / group-admin status comes from pair.js (real WhatsApp data), never from chat text
 *   • config.OWNER_ONLY_COMMANDS and the per-tool rules in tools.js are enforced here too
 *   • eval / exec / restart / update / boom … (config.GF.NL_BLOCKED) can never be triggered from conversation
 */
const { TOOLS, canon } = require('./tools');
const runctx = require('./runctx');

/** why the sender is NOT allowed, or null if fine. reasons: blocked | needGroup | noOwner | noAdmin | noBotAdmin */
function checkPerm(tool, ctx, config) {
    const name = canon(tool);
    const meta = name && TOOLS[name];
    if (!meta) return 'blocked';
    const blocked = (config.GF && config.GF.NL_BLOCKED) || [];
    if (blocked.includes(name) || blocked.includes(tool)) return 'blocked';
    if (meta.group && !ctx.isGroup) return 'needGroup';
    const ownerOnly = new Set(config.OWNER_ONLY_COMMANDS || []);
    if ((ownerOnly.has(name) || meta.perm === 'owner') && !ctx.isOwner) return 'noOwner';
    if (meta.perm === 'group-admin') {
        if (!ctx.isOwner && !ctx.isSudo && !ctx.isAdmins) return 'noAdmin';
        if (!ctx.isBotAdmins) return 'noBotAdmin';
    }
    return null;
}

const jidOfNumber = (n) => `${n}@s.whatsapp.net`;

/**
 * Run `tool` with `arg`. Returns { ok, sent, lastText, error }.
 * `commandMap` is events.commandMap from pair.js (pattern + alias → command object).
 * The plugin gets the REAL socket (see runctx.js for how sends are still counted).
 */
async function runTool({ sock, mek, m, ctx, tool, arg = '', commandMap }) {
    const name = canon(tool);
    const cmd = commandMap && name && commandMap.get(name);
    if (!cmd) return { ok: false, sent: 0, lastText: '', error: new Error(`command "${tool}" is not registered`) };

    runctx.instrument(sock);
    const store = { sent: 0, lastText: '', claim: runctx.wantsClaims(cmd) };
    const reply = (text, opts = {}) => sock.sendMessage(ctx.from, { text, mentions: (opts && opts.mentions) || [ctx.sender] });

    // "kick 94771234567" with no tag/reply → hand the command a proper mention
    let mm = m;
    const digits = String(arg).replace(/[^0-9]/g, '');
    if (TOOLS[name].arg === 'target' && digits.length >= 9 && !(m.mentioned && m.mentioned.length) && !(m.quoted && m.quoted.sender)) {
        const jid = jidOfNumber(digits);
        mm = Object.assign(Object.create(m), { mentioned: [jid], mentionUser: [jid] });
    }
    const prefix = ctx.prefix || '/';
    const argText = String(arg || '').trim();
    const runCtx = {
        ...ctx, reply, command: name, isCmd: true, prefix,
        args: argText ? argText.split(/\s+/) : [], q: argText, body: `${prefix}${name}${argText ? ' ' + argText : ''}`,
    };
    try {
        await runctx.run(store, () => cmd.function(sock, mek, mm, runCtx));
        return { ok: true, sent: store.sent, lastText: store.lastText || '' };
    } catch (error) {
        console.error(`[GF] tool "${name}" failed:`, error && error.message);
        return { ok: false, sent: store.sent, lastText: store.lastText || '', error };
    }
}

module.exports = { checkPerm, runTool };
