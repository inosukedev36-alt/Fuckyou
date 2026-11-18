const { cmd } = require('../command');
const fs = require('fs-extra');
const path = require('path');

const SHH_FILE = path.join(__dirname, '..', 'data', 'shh.json');
const TIMER_FILE = path.join(__dirname, '..', 'data', 'mute_timers.json');

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

// ─── HIDE TAG ───
cmd({
    pattern: "hidetag",
    desc: "Tag all members without showing their names.",
    category: "group",
    react: "👻",
    filename: __filename
},
async (conn, mek, m, { from, isGroup, isAdmins, groupMetadata, reply, q }) => {
    try {
        if (!isGroup) return reply('❌වේසාවෝ මේක group command එකක් ');
        if (!isAdmins) return reply('❌ තෝ admin කෙනෙක් නෙවේ නේ. ඒ නිසා හැමිනියන්  ');

        const participants = groupMetadata.participants.map(p => p.id);
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

// Timed mutes are saved to disk, so they survive a bot restart.
// key -> { type: 'user' | 'group', group, jid?, num?, expires: <ms timestamp>, fails? }
let timers = {};
try {
    const saved = fs.readJsonSync(TIMER_FILE);
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) timers = saved;
} catch (e) { /* nothing saved yet */ }

// Connection used to unlock a group / send notices when a timer ends.
// Tip: add `global.conn = conn;` in your main file so this is always up to date.
let sock = null;
const isConn = (c) => c && typeof c.groupSettingUpdate === 'function' && typeof c.sendMessage === 'function';
const getConn = () => [global.conn, sock].find(isConn) || null;

const notify = (group, content) => {
    const conn = getConn();
    if (conn) Promise.resolve().then(() => conn.sendMessage(group, content)).catch(() => {});
};

function saveTimers() {
    try {
        fs.ensureDirSync(path.dirname(TIMER_FILE));
        fs.writeJsonSync(TIMER_FILE, timers, { spaces: 2 });
    } catch (e) {
        console.log('mute timers save error:', e.message);
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

function muteUser(group, jid) {
    const shh = loadShh();
    if (!Array.isArray(shh[group])) shh[group] = [];
    const num = jid.split('@')[0];
    for (const id of [jid, `${num}@s.whatsapp.net`, `${num}@lid`]) {
        if (!shh[group].includes(id)) shh[group].push(id);
    }
    saveShh(shh);
}

function unmuteUser(group, jid) {
    const shh = loadShh();
    const num = jid.split('@')[0];
    const list = Array.isArray(shh[group]) ? shh[group] : [];
    shh[group] = list.filter(id => id !== jid && id.split('@')[0] !== num);
    saveShh(shh);
}

const userKey = (group, jid) => `u:${group}:${jid.split('@')[0]}`;
const groupKey = (group) => `g:${group}`;

// ms > 0  -> start (or restart) a timer
// no ms   -> remove any old timer (the mute becomes permanent)
function setTimer(key, data, ms) {
    if (ms) timers[key] = { ...data, expires: Date.now() + ms };
    else if (timers[key]) delete timers[key];
    else return;
    saveTimers();
}

function clearTimer(key) {
    if (!timers[key]) return;
    delete timers[key];
    saveTimers();
}

// "30m" | "1h" | "1h30m" | "2 h 15 m"  ->  milliseconds  (null = invalid)
function parseDuration(text) {
    const s = String(text || '').toLowerCase().replace(/\s+/g, '');
    if (!s) return null;
    const re = /(\d+)(hours?|hrs?|h|minutes?|mins?|m)/g;
    let minutes = 0, used = 0, hit;
    while ((hit = re.exec(s)) !== null) {
        minutes += parseInt(hit[1], 10) * (hit[2][0] === 'h' ? 60 : 1);
        used += hit[0].length;
    }
    return (minutes > 0 && used === s.length) ? minutes * 60000 : null;
}

// 90 min -> "1h 30m"
function fmtDuration(ms) {
    const mins = Math.round(ms / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return [h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m';
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
// false when it has to wait (no connection yet).
async function expireTimer(t) {
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

        for (const key of Object.keys(timers)) {
            const t = timers[key];
            if (!t) { delete timers[key]; changed = true; continue; }
            if (t.expires > now) continue;

            try {
                if (await expireTimer(t)) {
                    delete timers[key];
                    changed = true;
                }
            } catch (e) {
                console.log('auto unmute error:', e && e.message);
                t.fails = (t.fails || 0) + 1;
                if (isFatal(e) || t.fails >= 30) delete timers[key];   // give up
                else t.expires = Date.now() + 60 * 1000;               // connection problem? retry in a minute
                changed = true;
            }
        }

        if (changed) saveTimers();
    } finally {
        sweeping = false;
    }
}

// Check timers every 5s (guarded so a plugin reload doesn't stack intervals)
if (global.__muteSweeper) clearInterval(global.__muteSweeper);
global.__muteSweeper = setInterval(sweep, 5000);
sweep();

// ─── MUTE (Lock Group / Auto Delete User) ───
//  .mute                           -> lock group
//  .mute 1h                        -> lock group for 1 hour   (30m, 1h, 1h30m ...)
//  .mute   (reply / @tag / number) -> auto delete that user's messages
//  .mute 30m (reply / @tag / number) -> same, but only for 30 minutes
cmd({
    pattern: "mute",
    alias: ["lock", "groupclose"],
    desc: "Lock group or mute a user (reply/tag). Add a time like 30m, 1h, 1h30m to auto unmute.",
    category: "group",
    react: "🔇",
    filename: __filename
},
async (conn, mek, m, { from, isGroup, isAdmins, isBotAdmins, reply, args }) => {
    try {
        sock = conn;
        if (!isGroup) return reply('❌ Group only');
        if (!isAdmins) return reply('❌ Admins only');
        if (!isBotAdmins) return reply('❌ I need admin rights');

        const { jid, rest } = resolveTarget(m, args);

        // optional time (hours / minutes)
        let ms = null;
        if (rest.length) {
            ms = parseDuration(rest.join(''));
            if (!ms) return reply('⏱ Use: *.mute 30m*  |  *.mute 1h*  |  *.mute 1h30m*');
        }
        const forText = ms ? ` for ${fmtDuration(ms)}` : '';

        // 1. කෙනෙක්ව Tag කරලා හෝ Reply කරලා තියෙනවා නම් (User Auto-Delete)
        if (jid) {
            muteUser(from, jid);
            setTimer(userKey(from, jid), { type: 'user', group: from, jid, num: jid.split('@')[0] }, ms);
            return reply(`🔇 *Muted*${forText}`);
        }

        // 2. කාවවත් tag කරලා නැත්නම් (Group Lock)
        await conn.groupSettingUpdate(from, 'announcement');
        setTimer(groupKey(from), { type: 'group', group: from }, ms);
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
async (conn, mek, m, { from, isGroup, isAdmins, isBotAdmins, reply, args }) => {
    try {
        sock = conn;
        if (!isGroup) return reply('❌ Group only');
        if (!isAdmins) return reply('❌ Admins only');
        if (!isBotAdmins) return reply('❌ I need admin rights');

        const { jid } = resolveTarget(m, args);

        // 1. කෙනෙක්ව Tag කරලා හෝ Reply කරලා තියෙනවා නම් (Stop User Auto-Delete)
        if (jid) {
            unmuteUser(from, jid);
            clearTimer(userKey(from, jid));
            return reply('🔊 *Unmuted*');
        }

        // 2. කාවවත් tag කරලා නැත්නම් (Group Unlock)
        await conn.groupSettingUpdate(from, 'not_announcement');
        clearTimer(groupKey(from));
        reply('🔓 *Group unlocked*');

    } catch (e) {
        console.log(e);
        reply(`❌ Error: ${e.message}`);
    }
});
