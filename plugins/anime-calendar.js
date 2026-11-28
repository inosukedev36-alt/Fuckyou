// plugins/anime-calendar.js — Daily Anime Release Calendar (poddax-api.dev)
const axios = require('axios');
const cron = require('node-cron');
const config = require('../config');
const { cmd } = require('../command');

// ═══════════════ සැකසුම් ═══════════════
const CALENDAR_IMAGE_URL = 'https://files.catbox.moe/s39kdz.jpeg';
const AUTO_CRON = '0 0 * * *';      // Auto post යන වෙලාව (ලංකා වේලාවෙන් රෑ 12:00). උදේ 6 ට ඕනේ නම් '0 6 * * *'
const CAPTION_MAX_CHAT = 1000;      // Group / inbox වල image caption එකකට දාන උපරිම අකුරු. WhatsApp caption limit එක ≈ 1024. ඊට වැඩි නම් image නැතුව text එකක් විදිහට (තවමත් එකම message එකක්) යනවා
const CAPTION_MAX_CHANNEL = 1000;   // Channel එකේ image caption එක ~1024 ට වැඩි වුණොත් කැපෙනවා
const CACHE_TTL = 15 * 60 * 1000;   // දත්ත විනාඩි 15ක් cache කරනවා

// ── දත්ත මූලාශ්‍රය ──
// poddax-api.dev → අද දවසේ anime list එක (title, වේලාව, thumbnail). Token එකක් ඕනේ නැහැ.
// API එක දෙන වේලාවන් ලංකා වේලාවෙන් කියලා සලකලා එහෙමම පෙන්නනවා.
const API_URL = 'https://poddax-api.dev/today';
const EXCLUDE_TITLES = [];          // list එකේ කිසිම විදිහට ඕනේ නැති ඒවා (title එකේ කොටසක්, පොඩි අකුරෙන්. උදා: ['rilakkuma', 'keroro'])

// Message එක channel එකකින් "Forwarded" කරපු වගේ පේන්න (View channel button එකත් එක්ක)
const FORWARD_LOOK = true;                          // ඕනේ නැත්නම් false කරන්න
const CHANNEL_INVITE = 'https://www.whatsapp.com/channel/0029Vb9co3HFi8xjeHvhRI2m';  // https://whatsapp.com/channel/0029VbE79hZBadmXSbahq33R
const CHANNEL_JID = '120363431533516657@newsletter';                             // JID එක (120363xxxxxxxxxx@newsletter) දන්නවා නම් මෙතන දාන්න. හිස් නම් invite code එකෙන් auto හොයාගන්නවා
const CHANNEL_NAME = ' 𝓐𝓷𝓲𝓶𝓮 𝓝𝓮𝔀𝓼 𝓑𝔂 𝓘𝓷𝓸𝓼𝓾𝓴𝓮';                            // හිස් නම් channel එකේ නම auto ගන්නවා

// ශ්‍රී ලංකා වේලාව = UTC+5:30 (DST නැහැ).
// Server එකේ timezone එක මොකක් වුණත් වැරදෙන්නේ නැති වෙන්න ගණනය කරන්නේ මෙතනින්ම.
const SL_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "typing..." පෙන්නනවා / නවත්තනවා — message එකක් යවන්නේ නැහැ, error එකක් ආවොත් ignore කරනවා
const typing = (sock, jid, state) =>
    Promise.resolve().then(() => sock.sendPresenceUpdate(state, jid)).catch(() => {});

// ═══════════════ ලංකා වේලාව ═══════════════

// ලංකාවේ "අද" දවස — cache key එකට, සහ API එකෙන් දවසේ නම ආවේ නැත්නම් header එකට
function getSLDay(baseMs = Date.now()) {
    const sl = new Date(baseMs + SL_OFFSET_MS);      // මෙතැන් සිට getUTC*() වලින් කියවන්නේ ලංකා වේලාවයි
    return { y: sl.getUTCFullYear(), mo: sl.getUTCMonth(), d: sl.getUTCDate(), weekday: sl.getUTCDay() };
}

function cleanTitle(t) {
    const s = String(t).replace(/[*_~`]/g, '').trim();      // WhatsApp formatting අකුරු අයින් කරනවා
    return s.length > 60 ? s.slice(0, 57).trimEnd() + '...' : s;
}

// ═══════════════ poddax-api.dev ═══════════════

// අද anime list එක ගන්නවා. fail වුණොත් (timeout / server error) 3 පාරක් වෙනකම් ආයෙ try කරනවා
async function apiRequest(tries = 3) {
    let lastErr;
    for (let i = 1; i <= tries; i++) {
        try {
            const res = await axios.get(API_URL, {
                timeout: 20000,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
                }
            });
            const body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
            if (!body || body.status === false || !Array.isArray(body.anime)) throw new Error('poddax-api: unexpected response');
            return body;
        } catch (e) {
            lastErr = e;
            const status = e.response?.status;
            console.error(`⚠️ poddax-api request failed (${i}/${tries}):`, status ? `HTTP ${status}` : e.message);
            if (status && status < 500 && status !== 429) break;        // 4xx (429 නැතුව) — ආයෙ try කරලා වැඩක් නැහැ
            if (i < tries) await sleep(i * 2000);
        }
    }
    throw lastErr;
}

// API response → { day, items: [{ title, time }] }
// API එක දෙන order එකමයි (වේලාව අනුව කලින්ම sort වෙලා එන්නේ)
function normalizeAnime(body) {
    const seen = new Set();
    const items = [];
    for (const a of body.anime) {
        const title = a && a.title ? cleanTitle(a.title) : '';
        const time = a && a.time ? String(a.time).trim() : '';
        if (!title || !time) continue;

        const lower = title.toLowerCase();
        if (EXCLUDE_TITLES.some((k) => lower.includes(String(k).toLowerCase()))) continue;

        const key = `${lower}|${time}`;
        if (seen.has(key)) continue;                        // එකම title එක එකම වේලාවට දෙපාරක් ආවොත්
        seen.add(key);
        items.push({ title, time });
    }
    const dayItem = body.anime.find((a) => a && a.day);
    return { day: dayItem ? String(dayItem.day).trim() : '', items };
}

// ═══════════════ දත්ත ගන්න හැටි (cache) ═══════════════

let cache = null;           // { key, at, data, retryAt }

async function getData(day) {
    const key = `${day.y}-${day.mo}-${day.d}`;
    const sameDay = cache && cache.key === key;
    if (sameDay && Date.now() - cache.at < CACHE_TTL) return cache.data;
    if (sameDay && Date.now() < (cache.retryAt || 0)) return cache.data;           // ළඟදි fail වුණා නම් ආයෙ ගහන්නේ නැහැ

    try {
        const data = normalizeAnime(await apiRequest());
        cache = { key, at: Date.now(), data };
        return data;
    } catch (e) {
        if (sameDay) {
            cache.retryAt = Date.now() + 2 * 60 * 1000;
            console.warn('⚠️ poddax-api failed — using the cached list:', e.message);
            return cache.data;
        }
        throw e;
    }
}

// ═══════════════ Message එක හදනවා ═══════════════

function buildHeader(dayName, total) {
    return [
        `╭━━━〔 📺 *TODAY ANIME* 〕━━━╮`,
        `┃ 📅 *Day:* ${dayName}`,
        `┃ 🎬 *Total:* ${total}`,
        `╰━━━━━━━━━━━━━━━━━━━━╯`
    ].join('\n');
}

// 1. Title
// 🕐 08:00 PM
function buildList(items) {
    return items.map((i, n) => `*${n + 1}. ${i.title}*\n🕐 ${i.time}`).join('\n\n');
}

function buildFooter() {
    return `> ⚠️ *මෙහි ඇති වේලාවන් සුළු වශයෙන් වෙනස් විය හැකිය.* ⚠️ \n> ⚡ᴾᵒʷᵉʳᵉᵈ ᵇʸ ᴷⁱⁿᵍᴾᵒᵈᵈᵃᴹᵒᵈᶻ 𝙓 ᴵⁿᵒˢᵘᵏᵉ`;
}

// → { text }  (header + list + footer — මුළු message එකම)
async function buildCalendar() {
    const day = getSLDay();
    const data = await getData(day);
    const today = EN_DAYS[day.weekday];

    if (data.day && data.day.toLowerCase() !== today.toLowerCase()) {
        console.warn(`⚠️ poddax-api sent the ${data.day} list but today is ${today} (Sri Lanka time)`);
    }

    const parts = [buildHeader(data.day || today, data.items.length)];
    parts.push(data.items.length ? buildList(data.items) : '😴 No anime episodes are scheduled for today.');
    parts.push(buildFooter());
    return { text: parts.join('\n\n') };
}

// ═══════════════ Channel "Forwarded" look ═══════════════

let channelInfo = null;      // { jid, name } — එක පාරක් හොයාගත්තම cache වෙනවා
let channelRetryAt = 0;      // හොයාගන්න බැරි වුණොත් විනාඩි 10ක් යනකම් ආයෙ try කරන්නේ නැහැ
let channelWarned = false;

function withTimeout(promise, ms) {
    let t;
    return Promise.race([
        promise,
        new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })
    ]).finally(() => clearTimeout(t));
}

// Channel එකේ JID එකයි නමයි හොයාගන්නවා (invite code එකෙන්)
async function getChannelInfo(sock) {
    if (!FORWARD_LOOK) return null;
    if (channelInfo) return channelInfo;
    if (Date.now() < channelRetryAt) return null;

    let jid = CHANNEL_JID;
    let name = CHANNEL_NAME;
    if (!jid && typeof sock.newsletterMetadata === 'function') {
        try {
            const meta = await withTimeout(sock.newsletterMetadata('invite', CHANNEL_INVITE), 10000);
            jid = meta?.id || '';
            name = name || meta?.name || meta?.thread_metadata?.name?.text || '';
        } catch (e) {
            console.error('⚠️ Could not fetch channel info:', e.message);
        }
    }

    if (!jid) {
        channelRetryAt = Date.now() + 10 * 60 * 1000;
        if (!channelWarned) {
            channelWarned = true;
            console.warn('⚠️ Could not resolve the channel JID — sending without the forwarded look. Set CHANNEL_JID manually.');
        }
        return null;
    }

    channelInfo = { jid, name: name || 'Testone' };
    console.log(`📢 Forward look → ${channelInfo.name} (${channelInfo.jid})`);
    return channelInfo;
}

// "Forwarded — <channel නම> — View channel" වගේ පේන්න contextInfo එක
function forwardContext(ch) {
    if (!ch) return null;
    return {
        isForwarded: true,
        forwardingScore: 1,
        forwardedNewsletterMessageInfo: {
            newsletterJid: ch.jid,
            newsletterName: ch.name,
            serverMessageId: 143
        }
    };
}

// ═══════════════ යවන කොටස ═══════════════

async function sendCalendar(sock, jid, cal, { quoted = null, humanize = false } = {}) {
    const ctx = forwardContext(await getChannelInfo(sock));
    const withCtx = (content) => (ctx ? { ...content, contextInfo: ctx } : content);
    const isChannel = jid.endsWith('@newsletter');

    // Anti-ban: typing පෙන්නනවා (auto post වලට විතරයි)
    if (humanize) {
        try {
            if (!isChannel) {
                await sock.sendPresenceUpdate('composing', jid);
                await sleep(Math.min(5000, cal.text.length * 20 + 1000));
                await sock.sendPresenceUpdate('paused', jid);
                await sleep(500 + Math.random() * 1000);
            } else {
                await sleep(1500);
            }
        } catch (_) { /* presence error එකක් නම් ignore */ }
    }

    const opts = quoted ? { quoted } : {};
    const limit = isChannel ? CAPTION_MAX_CHANNEL : CAPTION_MAX_CHAT;

    // හැම වෙලාවකම යන්නේ message එකක් විතරයි:
    //  • caption එකට ඇතුල් වෙනවා නම්  → image + caption
    //  • දිග වැඩි නම් (WhatsApp එක caption එක කපනවා) → image නැතුව සම්පූර්ණ list එකම text එකක් විදිහට
    if (cal.text.length <= limit) {
        try {
            await sock.sendMessage(jid, withCtx({ image: { url: CALENDAR_IMAGE_URL }, caption: cal.text }), opts);
        } catch (e) {
            // catbox එක down / image එක යවන්න බැරි වුණොත් text විතරක් යවනවා
            console.error(`⚠️ Image send failed (${jid}): ${e.message} → sending text only`);
            await sock.sendMessage(jid, withCtx({ text: cal.text }), opts);
        }
    } else {
        await sock.sendMessage(jid, withCtx({ text: cal.text }), opts);
    }
    console.log(`✅ Calendar sent → ${jid}`);
}

// ═══════════════ COMMAND ═══════════════
cmd({
    pattern: "todayanime",
    alias: ["animetoday", "calendar"],
    desc: "Get today's anime release schedule (Sri Lanka time).",
    category: "anime",
    react: "📺",
    filename: __filename
},
async (conn, mek, m, { from, reply }) => {
    try {
        // වෙනම "wait" message එකක් නැහැ (message එකක් විතරයි යන්නේ) — ඒ වෙනුවට "typing..." පෙන්නනවා
        typing(conn, from, 'composing');
        const cal = await buildCalendar();
        await sendCalendar(conn, from, cal, { quoted: mek });
    } catch (e) {
        console.error('❌ todayanime error:', e);
        reply("❌ Couldn't fetch the anime list right now. Please try again in a moment.");
    } finally {
        typing(conn, from, 'paused');
    }
});

// ═══════════════ AUTO (හැම දවසකම රෑ 12:00 ට — ලංකා වේලාවෙන්) ══════════════
async function sendDailyAnimeCalendarAuto() {
    if (!config.ANIME_NEWS || !config.ANIME_NEWS.TARGET_JIDS || config.ANIME_NEWS.TARGET_JIDS.length === 0) return;

    const sockets = Object.values(global.activeSockets || {});
    if (sockets.length === 0) return;
    const sock = sockets[0];

    // දත්ත ගන්න බැරි වුණොත් විනාඩි 5කට පස්සේ ආයෙ try කරනවා (උපරිම 3 පාරක්)
    let cal = null;
    for (let attempt = 1; attempt <= 3 && !cal; attempt++) {
        try {
            console.log(`📅 Fetching auto anime releases for today... (${attempt}/3)`);
            cal = await buildCalendar();
        } catch (e) {
            console.error(`❌ Anime Calendar fetch failed (${attempt}/3):`, e.message);
            if (attempt < 3) await sleep(5 * 60 * 1000);
        }
    }
    if (!cal) return;

    for (const jid of config.ANIME_NEWS.TARGET_JIDS) {
        try {
            await sendCalendar(sock, jid, cal, { humanize: true });
        } catch (e) {
            console.error(`❌ Failed to send calendar to ${jid}:`, e.message);
        }
        await sleep(2000 + Math.random() * 3000);
    }
    console.log('✅ Auto Calendar sent successfully.');
}

cron.schedule(AUTO_CRON, () => {
    console.log('⏰ Running daily anime calendar task...');
    sendDailyAnimeCalendarAuto().catch((e) => console.error('❌ Anime Calendar Auto Error:', e.message));
}, {
    timezone: "Asia/Colombo"
});

console.log('📅 Anime Calendar Loaded (poddax-api.dev | Command: .todayanime | Auto: 00:00 AM | Sri Lanka Time).');
