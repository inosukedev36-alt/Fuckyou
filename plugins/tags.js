const { cmd } = require('../command');
const fs = require('fs-extra');
const path = require('path');

const DATA_DIR   = path.join(__dirname, '..', 'data');
const SHH_FILE   = path.join(DATA_DIR, 'shh.json');
const TIMER_FILE = path.join(DATA_DIR, 'mute_timers.json');
const SUDO_FILE  = path.join(DATA_DIR, 'sudo.json');   // optional, see getSudoNumbers()

const MAX_MUTE_MS = 365 * 24 * 60 * 60 * 1000;         // longest timer allowed (365 days)

// ═══════════════════════════════════════════════════════════
//  HELPERS  (json files + ids)
// ═══════════════════════════════════════════════════════════

function readJson(file, fallback) {
    try {
        const data = fs.readJsonSync(file);
        if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch (e) { /* missing or unreadable */ }
    return fallback;
}

// Saves to a temp file first, then renames it over the real one. If the bot restarts or
// crashes in the middle of a save, the old file is still intact (no half-written json).
function writeJson(file, data) {
    fs.ensureDirSync(path.dirname(file));
    const json = JSON.stringify(data, null, 2);
    const tmp = `${file}.tmp`;
    try {
        fs.writeFileSync(tmp, json);
        fs.renameSync(tmp, file);
    } catch (e) {
        fs.writeFileSync(file, json);   // rename failed (rare, e.g. file lock on Windows) -> plain write
    }
}

// "94771234567:12@s.whatsapp.net" -> "94771234567"   |   "1234@lid" -> "1234"
const numOf = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

// drops the ":device" part, so one person always has the same id
const normJid = (jid) => {
    const [user, server] = String(jid || '').split('@');
    return server ? `${user.split(':')[0]}@${server}` : user;
};

// A group member can be known by more than one id (phone number and/or LID)
const formsOf = (p) => [p && p.id, p && p.lid, p && p.phoneNumber, p && p.jid].filter(Boolean).map(normJid);
const isAdminP = (p) => !!p && (p.admin === 'admin' || p.admin === 'superadmin' || p.admin === true);
const findMember = (meta, nums) =>
    ((meta && meta.participants) || []).find(p => formsOf(p).some(f => nums.has(numOf(f))));

async function getMeta(conn, from, ctx) {
    if (ctx.groupMetadata && Array.isArray(ctx.groupMetadata.participants)) return ctx.groupMetadata;
    try { return await conn.groupMetadata(from); } catch (e) { return null; }
}

// Load SHH List on startup
global.shhList = readJson(SHH_FILE, {});
if (!fs.existsSync(SHH_FILE)) writeJson(SHH_FILE, {});

// (tagall lives in extras.js: admin-only and chunked. The old copy here had no admin check.)

// ═══════════════════════════════════════════════════════════
//  WHO CAN USE THE COMMANDS   ->   bot owner, sudo users, and every group admin
// ═══════════════════════════════════════════════════════════

// Collects the sudo numbers. It looks at:
//   - global.<any name with "sudo" in it>   (global.sudo, global.sudoList ...)
//   - the same kind of keys inside ../config (SUDO, SUDO_NUMBERS ...)
//   - data/sudo.json   (array of numbers, or { "sudo": [...] })
// Numbers can be plain, "+94 77 ...", or full jids, as an array or a "a,b,c" string.
// If your bot keeps its sudo list somewhere else, this is the only function to change.
function getSudoNumbers() {
    const out = new Set();
    const add = (v, depth = 0) => {
        if (v == null || depth > 3 || typeof v === 'function' || typeof v === 'boolean') return;
        if (Array.isArray(v)) return v.forEach(x => add(x, depth + 1));
        if (typeof v === 'object') return Object.entries(v).forEach(([k, x]) => { add(k, depth + 1); add(x, depth + 1); });
        String(v).split(/[,;\n]+/).forEach(s => { const n = numOf(s); if (n.length >= 6) out.add(n); });
    };

    for (const k of Object.keys(global)) if (/sudo/i.test(k)) add(global[k]);
    try { const cfg = require('../config'); for (const k of Object.keys(cfg || {})) if (/sudo/i.test(k)) add(cfg[k]); } catch (e) { /* no config */ }
    try { add(fs.readJsonSync(SUDO_FILE)); } catch (e) { /* no sudo.json */ }
    return out;
}

async function isAllowed(conn, mek, m, ctx, meta) {
    const key = (mek && mek.key) || {};
    if (ctx.isOwner || ctx.isSudo || ctx.isMe || key.fromMe) return true;

    // every id the sender could be using (phone number / LID)
    const nums = new Set([ctx.sender, m && m.sender, key.participant, key.participantAlt, key.participantPn]
        .map(numOf).filter(Boolean));
    const member = findMember(meta, nums);
    if (member) formsOf(member).forEach(f => nums.add(numOf(f)));

    const sudo = getSudoNumbers();
    if ([...nums].some(n => sudo.has(n))) return true;       // sudo user

    return !!ctx.isAdmins || isAdminP(member);               // group admin
}

const botNumbers = (conn) => {
    const u = (conn && conn.user) || {};
    return new Set([u.id, u.lid, u.jid].map(numOf).filter(Boolean));
};

function botIsAdmin(conn, ctx, meta) {
    if (ctx.isBotAdmins) return true;
    return isAdminP(findMember(meta, botNumbers(conn)));
}

// ─── HIDE TAG ───
cmd({
    pattern: "hidetag",
    desc: "Tag all members without showing their names.",
    category: "group",
    react: "👻",
    filename: __filename
},
async (conn, mek, m, ctx) => {
    const { from, isGroup, reply, q } = ctx;
    try {
        if (!isGroup) return reply('❌වේසාවෝ මේක group command එකක් ');

        const meta = await getMeta(conn, from, ctx);
        if (!(await isAllowed(conn, mek, m, ctx, meta))) return reply('❌ තෝ admin කෙනෙක් නෙවේ නේ. ඒ නිසා හැමිනියන්  ');

        const participants = ((meta && meta.participants) || []).map(p => p.id);
        if (!participants.length) return reply('❌ Could not read the member list');
        const text = q ? q : 'හුත්තෝ අවදානේ ඕනේ මට!';

        await conn.sendMessage(from, {
            text: text,
            mentions: participants
        }, { quoted: mek });

    } catch (e) {
        console.log(e);
        reply(`❌ Error: ${e.message}`);
    }
});

// ═══════════════════════════════════════════════════════════
//  MUTE HELPERS  (user mute / group lock, with optional timer)
// ═══════════════════════════════════════════════════════════

// ── user mutes: shh.json = { groupJid: [jid, ...] } ──
// (format unchanged - the auto-delete handler reads global.shhList)
// A mute belongs to the PERSON (all their ids), not to their group membership, so leaving
// and re-joining the group does not remove it. Nothing in this file removes a mute except
// .unmute or the end of its timer.

function loadShh() {
    const mem = (global.shhList && typeof global.shhList === 'object' && !Array.isArray(global.shhList)) ? global.shhList : {};
    return readJson(SHH_FILE, mem);
}

function saveShh(data) {
    writeJson(SHH_FILE, data);
    global.shhList = data;
}

// Every id we know for one person: the id used in the command, the phone-number id + LID from the
// group member list, and the usual variants. The auto-delete handler can match any of them, so
// the mute still works whichever id WhatsApp uses for that person later (e.g. after re-joining).
function idsFor(jid, meta) {
    const forms = new Set([normJid(jid)]);
    const member = findMember(meta, new Set([numOf(jid)]));
    if (member) formsOf(member).forEach(f => forms.add(f));

    const out = new Set(forms);
    for (const f of forms) {
        const n = numOf(f);
        if (n) { out.add(`${n}@s.whatsapp.net`); out.add(`${n}@lid`); }
    }
    return [...out];
}

function muteUser(group, ids) {
    const shh = loadShh();
    if (!Array.isArray(shh[group])) shh[group] = [];
    for (const id of ids) if (!shh[group].includes(id)) shh[group].push(id);
    saveShh(shh);
}

function unmuteUser(group, ids) {
    const shh = loadShh();
    const nums = new Set(ids.map(numOf).filter(Boolean));
    const list = Array.isArray(shh[group]) ? shh[group] : [];
    shh[group] = list.filter(id => !nums.has(numOf(id)));
    saveShh(shh);
}

// ── timers: saved to disk, so they survive a bot restart ──
// key -> { type: 'user',  group, jid, num, ids: [...], expires: <ms timestamp> }
//        { type: 'group', group, expires: <ms timestamp> }
let timers = readJson(TIMER_FILE, {});

// Connection used to unlock a group / send notices when a timer ends.
// It is refreshed from: global.conn, every message the bot receives (handler at the bottom),
// and every .mute / .unmute.  Tip: also add `global.conn = conn;` in your main file, right
// after the socket is created - then it works even before the first message after a restart.
let sock = null;
const isConn = (c) => c && typeof c.groupSettingUpdate === 'function' && typeof c.sendMessage === 'function';
const isOpen = (c) => {
    const ws = c.ws;
    if (!ws) return true;
    if (typeof ws.isOpen === 'boolean') return ws.isOpen;
    const rs = typeof ws.readyState === 'number' ? ws.readyState : (ws.socket && ws.socket.readyState);
    return typeof rs === 'number' ? rs === 1 : true;
};
const getConn = () => {
    const all = [sock, global.conn, global.sock].filter(isConn);
    return all.find(isOpen) || all[0] || null;
};

const notify = (group, content) => {
    const conn = getConn();
    if (conn) Promise.resolve().then(() => conn.sendMessage(group, content)).catch(() => {});
};

function saveTimers() {
    try {
        writeJson(TIMER_FILE, timers);
    } catch (e) {
        console.log('mute timers save error:', e.message);
    }
}

const userKey = (group, jid) => `u:${group}:${numOf(jid)}`;
const groupKey = (group) => `g:${group}`;

// timer records of this person in this group (found by any of their ids)
function userRecordKeys(group, ids) {
    const nums = new Set(ids.map(numOf).filter(Boolean));
    return Object.keys(timers).filter(k => {
        const t = timers[k];
        return t && t.type === 'user' && t.group === group &&
            (t.ids && t.ids.length ? t.ids : [t.jid]).some(i => nums.has(numOf(i)));
    });
}

// ms > 0  -> start (or restart) a timer
// no ms   -> remove any old timer (the mute becomes permanent)
function setUserTimer(group, jid, ids, ms) {
    const old = userRecordKeys(group, ids);
    old.forEach(k => delete timers[k]);
    if (ms) timers[userKey(group, jid)] = { type: 'user', group, jid, num: numOf(jid), ids, expires: Date.now() + ms };
    if (ms || old.length) saveTimers();
}

function setGroupTimer(group, ms) {
    const key = groupKey(group);
    if (ms) timers[key] = { type: 'group', group, expires: Date.now() + ms };
    else if (timers[key]) delete timers[key];
    else return;
    saveTimers();
}

// unmute a person: remove all ids we know for them (including those saved with an old timer)
function releaseUser(group, jid, meta) {
    const ids = new Set(idsFor(jid, meta));
    for (const k of userRecordKeys(group, [...ids])) {
        const t = timers[k];
        (t.ids && t.ids.length ? t.ids : [t.jid]).forEach(i => ids.add(i));
    }
    unmuteUser(group, [...ids]);
    setUserTimer(group, jid, [...ids], null);
}

// "30s" | "10m" | "1h" | "5d" | "1h30m" | "1d 12h" | "2 h 15 m" | "5 days" | "30 sec"  ->  milliseconds  (null = invalid)
function parseDuration(text) {
    const s = String(text || '').toLowerCase().replace(/\s+/g, '');
    if (!s) return null;
    const UNIT = { d: 86400, h: 3600, m: 60, s: 1 };
    const re = /(\d+)(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/g;
    let secs = 0, used = 0, hit;
    while ((hit = re.exec(s)) !== null) {
        secs += parseInt(hit[1], 10) * UNIT[hit[2][0]];
        used += hit[0].length;
    }
    return (secs > 0 && used === s.length) ? secs * 1000 : null;
}

// 90061000 -> "1d 1h 1m 1s"
function fmtDuration(ms) {
    let left = Math.round(ms / 1000);
    const parts = [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]].map(([unit, size]) => {
        const v = Math.floor(left / size);
        left -= v * size;
        return v ? `${v}${unit}` : '';
    });
    return parts.filter(Boolean).join(' ') || '0s';
}

// Who is the target?  reply / @tag / phone number.
// Whatever else was typed after the command (e.g. "5d") is returned in `rest`.
const isPhoneArg = (a) => !!a && !isNaN(a) && String(a).replace(/[^0-9]/g, '').length >= 9;

function resolveTarget(m, args) {
    const phone = args.find(isPhoneArg);
    const mention = (m.mentionUser && m.mentionUser.length > 0) ? m.mentionUser[0] : null;

    let jid = null;
    if (m.quoted) jid = m.quoted.sender;
    else if (mention) jid = mention;
    else if (phone) jid = `${String(phone).replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    const rest = args.filter(a => !String(a).startsWith('@') && !isPhoneArg(a));
    return { jid: jid || null, rest, targeted: !!(m.quoted || mention || phone) };
}

// ── when a timer ends ──
// Runs when a timer ends. Returns true when done (entry can be removed),
// false when it has to wait (no connection yet, e.g. right after a restart).
async function expireTimer(t) {
    if (t.type === 'user') {
        unmuteUser(t.group, (t.ids && t.ids.length) ? t.ids : [t.jid]);
        notify(t.group, { text: `🔊 @${numOf(t.jid)} *Unmuted*`, mentions: [t.jid] });
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

const busy = new Set();

async function runTimer(key, t) {
    try {
        if (!(await expireTimer(t))) return;                  // waiting for a connection
        if (timers[key] === t) { delete timers[key]; saveTimers(); }
    } catch (e) {
        console.log('auto unmute error:', e && e.message);
        if (timers[key] !== t) return;                        // changed meanwhile (re-muted / unmuted)
        if (isFatal(e)) {
            delete timers[key];                               // give up
            notify(t.group, { text: "⚠️ Couldn't unlock the group automatically. Please check my admin rights." });
        } else {
            // connection problem? keep trying (5s, 10s, 20s, 40s, then every minute) - never give up
            t.fails = (t.fails || 0) + 1;
            t.retryAt = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(t.fails - 1, 4));
        }
        saveTimers();
    }
}

// Every timer is checked each second. After a restart the saved timers are loaded from disk and
// continue from where they were; a timer that ran out while the bot was off is handled at once.
function sweep() {
    const now = Date.now();
    let changed = false;

    for (const key of Object.keys(timers)) {
        const t = timers[key];
        if (!t || typeof t !== 'object') { delete timers[key]; changed = true; continue; }
        if (t.expires > now || t.retryAt > now || busy.has(key)) continue;

        busy.add(key);
        runTimer(key, t).then(() => busy.delete(key), () => busy.delete(key));
    }

    if (changed) saveTimers();
}

// guarded so a plugin reload doesn't stack intervals
if (global.__muteSweeper) clearInterval(global.__muteSweeper);
global.__muteSweeper = setInterval(sweep, 1000);
sweep();

// ─── MUTE (Lock Group / Auto Delete User) ───
//  .mute                             -> lock group
//  .mute 5d                          -> lock group for 5 days   (30s, 10m, 1h, 5d, 1h30m, 1d12h ...)
//  .mute   (reply / @tag / number)   -> auto delete that user's messages
//  .mute 30s (reply / @tag / number) -> same, but only for 30 seconds
cmd({
    pattern: "mute",
    alias: ["lock", "groupclose"],
    desc: "Lock group or mute a user (reply/tag). Add a time like 30s, 10m, 1h, 5d, 1d12h to auto unmute.",
    category: "group",
    react: "🔇",
    filename: __filename
},
async (conn, mek, m, ctx) => {
    const { from, isGroup, reply, args } = ctx;
    try {
        sock = conn;
        if (!isGroup) return reply('❌ Group only');

        const meta = await getMeta(conn, from, ctx);
        if (!(await isAllowed(conn, mek, m, ctx, meta))) return reply('❌ Admins / sudo only');
        if (!botIsAdmin(conn, ctx, meta)) return reply('❌ I need admin rights');

        const { jid, rest, targeted } = resolveTarget(m, args || []);
        if (targeted && !jid) return reply('❌ Could not find that user');   // never lock the whole group by mistake

        // optional time (days / hours / minutes / seconds)
        let ms = null;
        if (rest.length) {
            ms = parseDuration(rest.join(''));
            if (!ms) return reply('⏱ Use: *.mute 30s*  |  *.mute 10m*  |  *.mute 1h30m*  |  *.mute 5d*');
            if (ms > MAX_MUTE_MS) return reply('⏱ Max time is 365d');
        }
        const forText = ms ? ` for ${fmtDuration(ms)}` : '';

        // 1. කෙනෙක්ව Tag කරලා හෝ Reply කරලා තියෙනවා නම් (User Auto-Delete)
        if (jid) {
            const ids = idsFor(jid, meta);
            const bot = botNumbers(conn);
            if (ids.some(id => bot.has(numOf(id)))) return reply("❌ I can't mute myself");

            muteUser(from, ids);
            setUserTimer(from, jid, ids, ms);
            return reply(`🔇 *Muted*${forText}`);
        }

        // 2. කාවවත් tag කරලා නැත්නම් (Group Lock)
        await conn.groupSettingUpdate(from, 'announcement');
        setGroupTimer(from, ms);
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
    const { from, isGroup, reply, args } = ctx;
    try {
        sock = conn;
        if (!isGroup) return reply('❌ Group only');

        const meta = await getMeta(conn, from, ctx);
        if (!(await isAllowed(conn, mek, m, ctx, meta))) return reply('❌ Admins / sudo only');
        if (!botIsAdmin(conn, ctx, meta)) return reply('❌ I need admin rights');

        const { jid, targeted } = resolveTarget(m, args || []);
        if (targeted && !jid) return reply('❌ Could not find that user');

        // 1. කෙනෙක්ව Tag කරලා හෝ Reply කරලා තියෙනවා නම් (Stop User Auto-Delete)
        if (jid) {
            releaseUser(from, jid, meta);
            return reply('🔊 *Unmuted*');
        }

        // 2. කාවවත් tag කරලා නැත්නම් (Group Unlock)
        await conn.groupSettingUpdate(from, 'not_announcement');
        setGroupTimer(from, null);
        reply('🔓 *Group unlocked*');

    } catch (e) {
        console.log(e);
        reply(`❌ Error: ${e.message}`);
    }
});

// ─── keeps the connection fresh (runs silently on every message) ───
// After a restart this is what lets a group auto-unlock reach WhatsApp even if nobody has
// typed .mute / .unmute yet. (Needs a framework that supports `on: "body"` handlers.)
cmd({
    on: "body",
    dontAddCommandList: true,
    filename: __filename
},
async (conn) => {
    sock = conn;
});
