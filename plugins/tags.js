const { cmd } = require('../command');
const fs = require('fs-extra');
const path = require('path');

const SHH_FILE = path.join(__dirname, '..', 'data', 'shh.json');
const TIMER_FILE = path.join(__dirname, '..', 'data', 'mute_timers.json');
const SUDO_FILE = path.join(__dirname, '..', 'data', 'sudo.json');

// Load SHH List on startup
if (fs.existsSync(SHH_FILE)) {
    try {
        const loaded = fs.readJsonSync(SHH_FILE);
        global.shhList = (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) ? loaded : {};
    } catch (e) {
        global.shhList = {};
    }
} else {
    global.shhList = {};
    if (!fs.existsSync(path.dirname(SHH_FILE))) {
        fs.mkdirSync(path.dirname(SHH_FILE), { recursive: true });
    }
    fs.writeJsonSync(SHH_FILE, {});
}

// (tagall lives in extras.js: admin-only and chunked. The old copy here had no admin check.)

// ═══════════════════════════════════════════════════════════
//  WHO CAN USE hidetag / mute / unmute
//  group admins  +  the owner  +  sudo users
// ═══════════════════════════════════════════════════════════

let botConfig = {};
try { botConfig = require('../config') || {}; } catch (e) { /* no config.js */ }

const digits = (j) => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');

// array / Set / "947..,947.." string / { number: ... }  ->  ['947...', ...]
function toNumbers(v) {
    if (!v) return [];
    if (typeof v === 'string' || typeof v === 'number') return String(v).split(/[,;\n]+/).map(digits).filter(Boolean);
    if (Array.isArray(v) || v instanceof Set) return [...v].flatMap(toNumbers);
    if (typeof v === 'object') return Object.keys(v).map(digits).filter(Boolean);
    return [];
}

// The sudo list. It is looked up in the usual places:
// ctx.isSudo, global.sudo / sudoList / sudoUsers / SUDO, env SUDO, config.js (SUDO ...), data/sudo.json.
// If your bot keeps its sudo list somewhere else, this is the only function to change.
function sudoNumbers() {
    const out = [];
    for (const k of ['sudo', 'sudoList', 'sudoUsers', 'SUDO']) out.push(...toNumbers(global[k]));
    out.push(...toNumbers(process.env.SUDO));
    for (const k of ['SUDO', 'SUDO_NUMBERS', 'SUDO_NUMBER', 'SUDO_USERS', 'sudo']) out.push(...toNumbers(botConfig[k]));
    try { out.push(...toNumbers(fs.readJsonSync(SUDO_FILE))); } catch (e) { /* no sudo.json */ }
    return out;
}

// every id (phone number / LID) we can find for the sender
function senderIds(ctx, m) {
    const ids = new Set();
    const add = (x) => { const d = digits(x); if (d) ids.add(d); };
    add(ctx.sender); add(ctx.senderNumber); add(m && m.sender);

    // phone number <-> LID: the member list of the group carries both (Baileys 7)
    const parts = (ctx.groupMetadata && ctx.groupMetadata.participants) || [];
    const me = parts.find(p => [p.id, p.lid, p.phoneNumber, p.jid].some(x => x && ids.has(digits(x))));
    if (me) [me.id, me.lid, me.phoneNumber, me.jid].forEach(add);
    return ids;
}

// is the sender an admin of this group (meta = group metadata)?
const isAdminIn = (meta, ids) => ((meta && meta.participants) || [])
    .some(p => p.admin && [p.id, p.lid, p.phoneNumber, p.jid].some(x => x && ids.has(digits(x))));

// privileged = owner or sudo (allowed everywhere, admin or not)
function whoIs(ctx, m) {
    const ids = senderIds(ctx, m);
    const sudo = ctx.isSudo === true || sudoNumbers().some(n => ids.has(n));
    return { ids, privileged: !!ctx.isOwner || sudo };
}

// ─── HIDE TAG ───
//  .hidetag                        -> blank message that tags everyone
//  .hidetag hello                  -> "hello", tags everyone
//  .hidetag  (reply to a message)  -> copy of that message, tags everyone
//  .hidetag <group jid>,<message>  -> same, but sent to that group
//                                     (owner / sudo, or an admin of that group - works from any chat)
//  .hidetag <group jid>            -> blank message to that group
// Always sent as a NEW message (never as a reply to the command).

const BLANK = '\u200E'; // invisible character -> "blank" message
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'];
const VIEW_ONCE = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
const COPYABLE = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage', 'contactMessage', 'contactsArrayMessage', 'locationMessage'];

// strip wrapper layers (ephemeral / view once / document caption) -> the real content
function unwrap(msg) {
    let cur = msg;
    for (let i = 0; i < 5 && cur; i++) {
        const w = WRAPPERS.find(k => cur[k] && cur[k].message);
        if (!w) break;
        cur = cur[w].message;
    }
    return cur;
}

function isViewOnce(raw) {
    if (!raw) return false;
    if (VIEW_ONCE.some(k => raw[k])) return true;
    return Object.values(unwrap(raw) || {}).some(v => v && v.viewOnce === true);
}

// contextInfo (with quotedMessage) of the command message, when it was sent as a reply
function getReplyContext(mek, m) {
    const msg = unwrap(mek && mek.message) || {};
    const ctx = Object.values(msg).map(v => v && v.contextInfo).find(c => c && c.quotedMessage);
    if (ctx) return ctx;

    const viaFw = m && m.msg && m.msg.contextInfo;
    if (viaFw && viaFw.quotedMessage) return viaFw;

    const fake = m && m.quoted && m.quoted.fakeObj;
    if (fake && fake.message) return { quotedMessage: fake.message, stanzaId: fake.key && fake.key.id };
    return null;
}

// "120363xxxxxxxxxx@g.us,hello"  ->  { jid, text: 'hello' }   (null if it doesn't start with a group jid)
function parseGroupTarget(q) {
    const hit = String(q || '').match(/^\s*(\d[\d-]*@g\.us)\s*(?:[,\s]\s*([\s\S]*))?$/i);
    return hit ? { jid: hit[1].toLowerCase(), text: (hit[2] || '').trim() } : null;
}

// Copy the replied message into `jid` (tagging everyone). Returns an error text, or null when sent.
async function copyReplied(conn, jid, ctx, mentions) {
    const raw = ctx.quotedMessage;
    if (isViewOnce(raw)) return "❌ Can't copy a view once message";

    const msg = unwrap(raw) || {};
    const text = msg.conversation || (msg.extendedTextMessage && msg.extendedTextMessage.text);
    if (text) {
        await conn.sendMessage(jid, { text, mentions });
        return null;
    }

    if (!COPYABLE.some(k => msg[k])) return "❌ Can't copy this type of message";
    await conn.sendMessage(jid, {
        forward: { key: { remoteJid: jid, fromMe: true, id: ctx.stanzaId }, message: msg },
        mentions,
        contextInfo: { mentionedJid: mentions }
    });
    return null;
}

cmd({
    pattern: "hidetag",
    desc: "Tag everyone without showing names. Reply to a message to copy it. Or from any chat: .hidetag <group jid>,<message>",
    category: "group",
    react: "👻",
    filename: __filename
},
async (conn, mek, m, ctx) => {
    const { from, isGroup, isAdmins, groupMetadata, reply, q } = ctx;
    try {
        remember(conn);
        const { ids, privileged } = whoIs(ctx, m);

        // ".hidetag <group jid>,<message>" -> target group + message
        const remote = parseGroupTarget(q);
        const jid = remote ? remote.jid : from;
        const text = remote ? remote.text : String(q || '').trim();
        const external = jid !== from; // sending to a different chat than the one the command was typed in

        let meta = groupMetadata;
        if (external) {
            // another group: owner / sudo, or an admin of that group
            meta = await conn.groupMetadata(jid).catch(() => null);
            if (!meta) return reply(privileged ? '❌ Group not found (is the bot in it?)' : '❌ Admins only');
            if (!privileged && !isAdminIn(meta, ids)) return reply('❌ Admins only');
        } else {
            if (!isGroup) return reply(privileged ? '❌ Group only. From here use: *.hidetag <group jid>,<message>*' : '❌ Group only');
            if (!isAdmins && !privileged) return reply('❌ Admins only');
        }

        const participants = meta.participants.map(p => p.id);

        if (text) {
            // typed message
            await conn.sendMessage(jid, { text, mentions: participants });
        } else {
            const rc = getReplyContext(mek, m);
            if (rc) {
                // reply -> copy of the replied message
                const problem = await copyReplied(conn, jid, rc, participants);
                if (problem) return reply(problem);
            } else if (m && m.quoted) {
                return reply("❌ Can't read the replied message");
            } else {
                // nothing typed, no reply -> blank message
                await conn.sendMessage(jid, { text: BLANK, mentions: participants });
            }
        }

        if (external) reply('✅ Sent');

    } catch (e) {
        console.log(e);
        reply(`❌ Error: ${e.message}`);
    }
});

// ═══════════════════════════════════════════════════════════
//  MUTE HELPERS  (user mute / group lock, with optional timer)
// ═══════════════════════════════════════════════════════════

// Saved to disk (data/mute_timers.json), so it all survives a bot restart.
// key -> { type: 'user' | 'group', group, jid?, num?, expires: <ms timestamp> | null (= until .unmute), fails? }
//   user  : every user muted with .mute  (lets us restore the mute after a restart / re-join)
//   group : a group lock that has a timer
let store = {};
try {
    const saved = fs.readJsonSync(TIMER_FILE);
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) store = saved;
} catch (e) { /* nothing saved yet */ }

function saveStore() {
    try {
        fs.ensureDirSync(path.dirname(TIMER_FILE));
        fs.writeJsonSync(TIMER_FILE, store, { spaces: 2 });
    } catch (e) {
        console.log('mute store save error:', e.message);
    }
}

// Live connection: needed to unlock a group / send notices when a timer ends - also right after a restart.
// It is picked up from every mute/unmute/hidetag and from every incoming message (see "muteconn" below).
// Tip: `global.conn = conn;` in your main file makes it available even before the first message.
let sock = null;
const isConn = (c) => c && typeof c.groupSettingUpdate === 'function' && typeof c.sendMessage === 'function';
const getConn = () => [global.conn, sock].find(isConn) || null;

const notify = (group, content) => {
    const conn = getConn();
    if (conn) Promise.resolve().then(() => conn.sendMessage(group, content)).catch(() => {});
};

const attached = new WeakSet();

function remember(conn) {
    if (!isConn(conn)) return;
    sock = conn;
    if (conn.ev && typeof conn.ev.on === 'function' && !attached.has(conn)) {
        attached.add(conn);
        conn.ev.on('group-participants.update', onParticipants);
    }
}

// someone joined (or re-joined) a group -> make sure their mute is still there
function onParticipants(ev) {
    try {
        if (!ev || ev.action !== 'add' || !Array.isArray(ev.participants)) return;
        const nums = new Set();
        for (const p of ev.participants) {
            const list = (p && typeof p === 'object') ? [p.id, p.lid, p.phoneNumber, p.jid] : [p];
            list.forEach(x => { const d = digits(x); if (d) nums.add(d); });
        }
        restoreMutes(ev.id, nums);
    } catch (e) {
        console.log('mute restore error:', e.message);
    }
}

// shh.json = { groupJid: [jid, ...] }  (format unchanged - the auto-delete handler reads global.shhList)
function loadShh() {
    try {
        const data = fs.readJsonSync(SHH_FILE);
        if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch (e) { /* fall back to memory */ }
    return (global.shhList && typeof global.shhList === 'object') ? global.shhList : {};
}

function saveShh(data) {
    fs.writeJsonSync(SHH_FILE, data, { spaces: 2 });
    global.shhList = data;
}

// puts the jid (+ phone / LID variants) into shh[group]; true if something was added
function addMuteIds(shh, group, jid) {
    if (!Array.isArray(shh[group])) shh[group] = [];
    const num = jid.split('@')[0];
    let added = false;
    for (const id of [jid, `${num}@s.whatsapp.net`, `${num}@lid`]) {
        if (!shh[group].includes(id)) { shh[group].push(id); added = true; }
    }
    return added;
}

function muteUser(group, jid) {
    const shh = loadShh();
    addMuteIds(shh, group, jid);
    saveShh(shh);
}

function unmuteUser(group, jid) {
    const shh = loadShh();
    const num = jid.split('@')[0];
    const list = Array.isArray(shh[group]) ? shh[group] : [];
    shh[group] = list.filter(id => id !== jid && id.split('@')[0] !== num);
    saveShh(shh);
}

// Every muted user in the store must also be in shh.json / global.shhList.
// Runs at startup, and when someone (re)joins a group. group / nums narrow it down.
function restoreMutes(group, nums) {
    const shh = loadShh();
    const now = Date.now();
    let changed = false;
    for (const t of Object.values(store)) {
        if (!t || t.type !== 'user' || !t.jid || !t.group) continue;
        if (group && t.group !== group) continue;
        if (nums && !nums.has(digits(t.jid))) continue;
        if (t.expires && t.expires <= now) continue; // time is over - the sweeper removes it
        if (addMuteIds(shh, t.group, t.jid)) changed = true;
    }
    if (changed) saveShh(shh);
}

const userKey = (group, jid) => `u:${group}:${jid.split('@')[0]}`;
const groupKey = (group) => `g:${group}`;

// ms -> timer, no ms -> until .unmute
function setEntry(key, data, ms) {
    store[key] = { ...data, expires: ms ? Date.now() + ms : null };
    saveStore();
}

function clearEntry(key) {
    if (!store[key]) return;
    delete store[key];
    saveStore();
}

// a group lock only needs an entry when it has a timer
function setGroupLock(group, ms) {
    if (ms) setEntry(groupKey(group), { type: 'group', group }, ms);
    else clearEntry(groupKey(group));
}

const UNIT_MS = { s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 86400 * 1000, w: 7 * 86400 * 1000 };
const MAX_MS = 3650 * 86400 * 1000; // 10 years - just a sanity limit

// "30s" | "10m" | "2h" | "5d" | "1d12h" | "2h30m10s" | "1w"  ->  milliseconds  (null = invalid)
function parseDuration(text) {
    const s = String(text || '').toLowerCase().replace(/\s+/g, '');
    if (!s) return null;
    const re = /(\d+)(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w)/g;
    let total = 0, used = 0, hit;
    while ((hit = re.exec(s)) !== null) {
        total += parseInt(hit[1], 10) * UNIT_MS[hit[2][0]];
        used += hit[0].length;
    }
    return (total > 0 && total <= MAX_MS && used === s.length) ? total : null;
}

// 90061000 -> "1d 1h 1m 1s"
function fmtDuration(ms) {
    let s = Math.round(ms / 1000);
    const d = Math.floor(s / 86400); s %= 86400;
    const h = Math.floor(s / 3600);  s %= 3600;
    const m = Math.floor(s / 60);    s %= 60;
    return [d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(' ') || '0s';
}

// Who is the target?  reply / @tag / phone number.
// Whatever else was typed after the command (e.g. "1h") is returned in `rest`.
const isPhoneArg = (a) => !!a && !isNaN(a) && String(a).replace(/[^0-9]/g, '').length >= 9;

function resolveTarget(m, args) {
    let jid = null;
    if (m.quoted) jid = m.quoted.sender;
    else if (m.mentionUser && m.mentionUser.length > 0) jid = m.mentionUser[0];
    else if (isPhoneArg(args[0])) jid = `${args[0].replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    const rest = args.filter(a => !String(a).startsWith('@') && !isPhoneArg(a));
    return { jid, rest };
}

// Runs when a timer ends. Returns true when done (entry can be removed),
// false when it has to wait (no live connection yet, e.g. right after a restart).
async function expireEntry(t) {
    if (t.type === 'user') {
        unmuteUser(t.group, t.jid);
        notify(t.group, { text: `🔊 @${t.num} *Unmuted*`, mentions: [t.jid] });
        return true;
    }

    if (t.type === 'group') {
        const conn = getConn();
        if (!conn) return false;
        await conn.groupSettingUpdate(t.group, 'not_announcement');
        notify(t.group, { text: '🔓 *Group unlocked*' });
        return true;
    }

    return true; // unknown entry -> drop it
}

// Errors that will never succeed on retry (bot not admin, group gone ...)
const isFatal = (e) => {
    const code = e && (e.data || (e.output && e.output.statusCode));
    return code === 403 || code === 404 || /forbidden|not-authorized|item-not-found/i.test(String(e && e.message));
};

let sweeping = false;
async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
        const now = Date.now();
        let changed = false;

        for (const key of Object.keys(store)) {
            const t = store[key];
            if (!t) { delete store[key]; changed = true; continue; }
            if (!t.expires || t.expires > now) continue; // no timer, or not over yet

            try {
                if (await expireEntry(t) && store[key] === t) {
                    delete store[key];
                    changed = true;
                }
            } catch (e) {
                console.log('auto unmute error:', e && e.message);
                t.fails = (t.fails || 0) + 1;
                if (isFatal(e) || t.fails >= 30) delete store[key];   // give up
                else t.expires = Date.now() + 60 * 1000;              // connection problem? retry in a minute
                changed = true;
            }
        }

        if (changed) saveStore();
    } finally {
        sweeping = false;
    }
}

// After a (re)start: bring back every mute that is saved, then check the timers every second.
// (guarded so a plugin reload doesn't stack intervals)
restoreMutes();
if (global.__muteSweeper) clearInterval(global.__muteSweeper);
global.__muteSweeper = setInterval(sweep, 1000);
sweep();

// Keeps the live connection fresh. Silent - runs on every incoming message.
// This is what lets a timed group lock be undone right after a bot restart.
cmd({
    pattern: "muteconn",
    on: "body",
    dontAddCommandList: true,
    category: "misc",
    desc: "internal: keeps the connection for auto unmute",
    filename: __filename
},
async (conn) => { remember(conn); });

// ─── MUTE (Lock Group / Auto Delete User) ───
//  .mute                             -> lock group
//  .mute 1h                          -> lock group for 1 hour   (30s, 10m, 2h, 5d, 1d12h ...)
//  .mute   (reply / @tag / number)   -> auto delete that user's messages
//  .mute 5d (reply / @tag / number)  -> same, but only for 5 days
// Who: group admins, the owner and sudo users.
cmd({
    pattern: "mute",
    alias: ["lock", "groupclose"],
    desc: "Lock group or mute a user (reply/tag). Add a time like 30s, 10m, 2h, 5d to auto unmute.",
    category: "group",
    react: "🔇",
    filename: __filename
},
async (conn, mek, m, ctx) => {
    const { from, isGroup, isAdmins, isBotAdmins, reply, args } = ctx;
    try {
        remember(conn);
        if (!isGroup) return reply('❌ Group only');
        if (!isAdmins && !whoIs(ctx, m).privileged) return reply('❌ Admins only');
        if (!isBotAdmins) return reply('❌ I need admin rights');

        const { jid, rest } = resolveTarget(m, args);

        // optional time (seconds / minutes / hours / days)
        let ms = null;
        if (rest.length) {
            ms = parseDuration(rest.join(''));
            if (!ms) return reply('⏱ Use: *.mute 30s* | *.mute 10m* | *.mute 2h* | *.mute 5d* | *.mute 1d12h*');
        }
        const forText = ms ? ` for ${fmtDuration(ms)}` : '';

        // 1. කෙනෙක්ව Tag කරලා හෝ Reply කරලා තියෙනවා නම් (User Auto-Delete)
        if (jid) {
            muteUser(from, jid);
            setEntry(userKey(from, jid), { type: 'user', group: from, jid, num: jid.split('@')[0] }, ms);
            return reply(`🔇 *Muted*${forText}`);
        }

        // 2. කාවවත් tag කරලා නැත්නම් (Group Lock)
        await conn.groupSettingUpdate(from, 'announcement');
        setGroupLock(from, ms);
        reply(`🔒 *Group locked*${forText}`);

    } catch (e) {
        console.log(e);
        reply(`❌ Error: ${e.message}`);
    }
});

// ─── UNMUTE (Unlock Group / Stop Auto Delete User) ───
cmd({
    pattern: "unmute",
    alias: ["unlock", "groupopen"],
    desc: "Unlock group (no tag) or unmute a user (tag/reply). Cancels any running timer.",
    category: "group",
    react: "🔊",
    filename: __filename
},
async (conn, mek, m, ctx) => {
    const { from, isGroup, isAdmins, isBotAdmins, reply, args } = ctx;
    try {
        remember(conn);
        if (!isGroup) return reply('❌ Group only');
        if (!isAdmins && !whoIs(ctx, m).privileged) return reply('❌ Admins only');
        if (!isBotAdmins) return reply('❌ I need admin rights');

        const { jid } = resolveTarget(m, args);

        // 1. කෙනෙක්ව Tag කරලා හෝ Reply කරලා තියෙනවා නම් (Stop User Auto-Delete)
        if (jid) {
            unmuteUser(from, jid);
            clearEntry(userKey(from, jid));
            return reply('🔊 *Unmuted*');
        }

        // 2. කාවවත් tag කරලා නැත්නම් (Group Unlock)
        await conn.groupSettingUpdate(from, 'not_announcement');
        clearEntry(groupKey(from));
        reply('🔓 *Group unlocked*');

    } catch (e) {
        console.log(e);
        reply(`❌ Error: ${e.message}`);
    }
});
