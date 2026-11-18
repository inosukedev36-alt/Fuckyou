const axios = require('axios');
const { cmd } = require('../command');
const { generateWAMessageFromContent, proto, prepareWAMessageMedia } = require('@dnuzi/baileys');

// ============================================================
// Config
// ============================================================
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const VA_LANGUAGES = ['Japanese', 'English'];                          // voice-actor languages shown under each character
const TRANSIENT_STEPS = ['searching', 'show_details', 'loading_full']; // steps where the user is waiting for output

// ============================================================
// Sessions
// ============================================================
let globalConn = null;
const aniInfoSessions = {};
global._aniInfoSessions = aniInfoSessions;

// Ends a session AND its expiry timer (a leftover timer must never touch a later session)
function endSession(from) {
  const s = aniInfoSessions[from];
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  delete aniInfoSessions[from];
}

function resetSessionTimeout(from) {
  const s = aniInfoSessions[from];
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  s.timeout = setTimeout(() => {
    // expire only THIS session, never a newer one started in the same chat
    if (aniInfoSessions[from] === s) {
      delete aniInfoSessions[from];
      console.log(`[ANIINFO] Session expired for ${from}`);
    }
  }, SESSION_TIMEOUT_MS);
}

// ---------- who is talking (matters in groups) ----------
const isGroupJid = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');

function senderOf(key) {
  if (!key) return null;
  if (key.fromMe) return 'me';
  return key.participant || key.remoteJid || null;
}

function sameSender(a, b) {
  if (!a || !b || a === b) return true;
  if (a === 'me' || b === 'me') return false;      // owner vs. somebody else
  const [ua, sa] = String(a).split('@');
  const [ub, sb] = String(b).split('@');
  if (sa !== sb) return true;                      // e.g. @lid vs @s.whatsapp.net: cannot compare, so do not block
  return ua.split(':')[0] === ub.split(':')[0];
}

// ============================================================
// Antiban Helpers
// ============================================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

async function simulateTyping(conn, from, durationMs) {
  try {
    await conn.sendPresenceUpdate('composing', from);
    await sleep(durationMs);
    await conn.sendPresenceUpdate('paused', from);
  } catch (e) {}
}

// ============================================================
// Interactive Helpers
// ============================================================
async function sendInteractiveList(conn, from, mek, headerTitle, bodyText, footerText, sections, imageUrl = null) {
  try {
    let media = {};
    if (imageUrl) {
      try {
        media = await prepareWAMessageMedia({ image: { url: imageUrl } }, { upload: conn.waUploadToServer });
      } catch (e) { media = {}; }
    }
    const msg = generateWAMessageFromContent(from, {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        header: proto.Message.InteractiveMessage.Header.fromObject({
          title: headerTitle, hasMediaAttachment: !!imageUrl && Object.keys(media).length > 0, ...media
        }),
        body: { text: bodyText },
        footer: { text: footerText },
        nativeFlowMessage: { buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify({ title: headerTitle, sections }) }] }
      })
    }, { quoted: mek });
    await conn.relayMessage(from, msg.message, { messageId: msg.key.id });
    return true;
  } catch (e) {
    await conn.sendMessage(from, { text: bodyText + '\n\n' + footerText }, { quoted: mek });
    return false;
  }
}

async function sendQuickButtons(conn, from, mek, bodyText, footerText, buttons) {
  try {
    const msg = generateWAMessageFromContent(from, {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        body: { text: bodyText },
        footer: { text: footerText },
        nativeFlowMessage: {
          buttons: buttons.map(b => ({
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id })
          }))
        }
      })
    }, { quoted: mek });
    await conn.relayMessage(from, msg.message, { messageId: msg.key.id });
    return true;
  } catch (e) {
    let fb = bodyText + '\n\n';
    buttons.forEach((b, i) => { fb += `${i + 1} | ${b.text}\n`; });
    fb += '\n' + footerText;
    await conn.sendMessage(from, { text: fb }, { quoted: mek });
    return false;
  }
}

const SERVER_BUTTONS = [
  { text: '📚 Server 1 (MAL)', id: 'server_1' },
  { text: '🎬 Server 2 (Bilibili)', id: 'server_2' },
  { text: '🌸 Server 3 (Jikan Full)', id: 'server_3' }
];

function sendServerMenu(conn, from, quoted, bodyText) {
  return sendQuickButtons(
    conn, from, quoted, bodyText,
    '📚 S1 = MAL (Basic)\n🎬 S2 = Bilibili (Video)\n🌸 S3 = Jikan (Full + Episodes + Characters + Staff + 18+)',
    SERVER_BUTTONS
  );
}

async function sendPoster(conn, from, quoted, url, title) {
  if (!url) {
    await conn.sendMessage(from, { text: '❌ No poster available.' }, { quoted });
    return;
  }
  try {
    await conn.sendMessage(from, { image: { url }, caption: `🖼️ *${title}* Poster` }, { quoted });
  } catch (e) {
    console.error('[ANIINFO] Poster send error:', e.message);
    await conn.sendMessage(from, { text: '❌ Could not send the poster.' }, { quoted });
  }
}

// ============================================================
// Jikan API Fetchers
// ============================================================
async function fetchJikanFullDetails(malId) {
  const res = await axios.get(`https://api.jikan.moe/v4/anime/${malId}/full`, { timeout: 20000 });
  return res.data?.data || null;
}

async function fetchJikanCharacters(malId) {
  const res = await axios.get(`https://api.jikan.moe/v4/anime/${malId}/characters`, { timeout: 20000 });
  return res.data?.data || [];
}

async function fetchJikanStaff(malId) {
  const res = await axios.get(`https://api.jikan.moe/v4/anime/${malId}/staff`, { timeout: 20000 });
  return res.data?.data || [];
}

async function fetchJikanEpisodes(malId, page = 1) {
  const res = await axios.get(`https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`, { timeout: 20000 });
  // NOTE: this endpoint's pagination has NO "total" (only last_visible_page / has_next_page),
  // so the total episode count comes from the anime's own data (fullData.episodes) instead.
  return {
    episodes: res.data?.data || [],
    hasNext: res.data?.pagination?.has_next_page || false
  };
}

// ============================================================
// Format Builders
// ============================================================
function formatNameList(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 'N/A';
  return arr.map(x => x.name).join(', ');
}

function buildInfoText(data) {
  const titles = data.titles || [];
  const altTitles = titles.filter(t => t.type !== 'Default')
    .map(t => `  • ${t.type}: ${t.title}`)
    .join('\n') || '  • N/A';

  const synonyms = Array.isArray(data.title_synonyms) && data.title_synonyms.length > 0
    ? data.title_synonyms.join(', ') : 'N/A';

  const genres = formatNameList(data.genres);
  const themes = formatNameList(data.themes);
  const demographics = formatNameList(data.demographics);
  const genreLine = [genres, themes, demographics].filter(x => x !== 'N/A').join(', ') || 'N/A';

  // ---------- AIRED (detailed) ----------
  const airedFromObj = data.aired?.prop?.from || {};
  const airedToObj = data.aired?.prop?.to || {};

  // Only prints the parts MAL actually knows: 03/10/2002, 10/2002 or just 2002
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtDate = (o) => {
    if (!o || !o.year) return 'Unknown';
    return [o.day ? pad2(o.day) : null, o.month ? pad2(o.month) : null, o.year].filter(Boolean).join('/');
  };

  const airedFrom = fmtDate(airedFromObj);
  const airedTo = fmtDate(airedToObj);
  const airedString = data.aired?.string
    || (airedFrom !== 'Unknown' ? `${airedFrom} to ${airedTo === 'Unknown' ? '?' : airedTo}` : 'N/A');

  // ---------- DURATION ----------
  const durationStr = data.duration || 'N/A';

  const hash = (v) => (v == null ? 'N/A' : `#${v}`);

  return (
    `📋 *INFORMATION*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎌 *Title:* ${data.title_english || data.title}\n` +
    `📛 *Japanese:* ${data.title_japanese || 'N/A'}\n` +
    `🔤 *Synonyms:* ${synonyms}\n` +
    `📝 *Alternative Titles:*\n${altTitles}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📺 *Type:* ${data.type || 'N/A'}\n` +
    `🎞️ *Episodes:* ${data.episodes ?? 'N/A'}\n` +
    `📡 *Status:* ${data.status || 'N/A'}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📅 *Aired:*\n` +
    `   ├ From: ${airedFrom}\n` +
    `   ├ To:   ${airedTo}\n` +
    `   └ Range: ${airedString}\n` +
    `⏱️ *Duration:* ${durationStr}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⭐ *Score:* ${data.score ?? 'N/A'} (${data.scored_by ?? 0} users)\n` +
    `🏆 *Rank:* ${hash(data.rank)}\n` +
    `❤️ *Popularity:* ${hash(data.popularity)}\n` +
    `🏢 *Studios:* ${formatNameList(data.studios)}\n` +
    `🎬 *Producers:* ${formatNameList(data.producers)}\n` +
    `📜 *Licensors:* ${formatNameList(data.licensors)}\n` +
    `📖 *Source:* ${data.source || 'N/A'}\n` +
    `🎭 *Genres:* ${genreLine}\n` +
    `🔞 *Rating:* ${data.rating || 'N/A'}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📝 *SYNOPSIS*\n${data.synopsis || 'N/A'}`
  );
}

function buildCharactersText(characters) {
  if (!characters || characters.length === 0) {
    return '👥 *CHARACTERS & VOICE ACTORS*\n━━━━━━━━━━━━━━━━━━━━\n❌ No character data available.';
  }

  let text = '👥 *CHARACTERS & VOICE ACTORS*\n━━━━━━━━━━━━━━━━━━━━\n';

  const mains = characters.filter(c => c.role === 'Main');
  const supports = characters.filter(c => c.role !== 'Main');
  const sorted = [...mains, ...supports].slice(0, 25);

  sorted.forEach((c, idx) => {
    const charName = c.character?.name || 'Unknown';
    const role = c.role || 'N/A';
    const vaList = (c.voice_actors || [])
      .filter(va => VA_LANGUAGES.includes(va.language))
      .map(va => `    🎙️ ${va.person?.name || '?'} (${va.language})`)
      .join('\n');

    text += `\n${idx + 1}. *${charName}* [${role}]\n`;
    text += vaList || '    🎙️ No VA info';
    text += '\n';
  });

  if (characters.length > 25) {
    text += `\n... and ${characters.length - 25} more characters.`;
  }

  return text;
}

function buildStaffText(staff) {
  if (!staff || staff.length === 0) {
    return '🎬 *STAFF*\n━━━━━━━━━━━━━━━━━━━━\n❌ No staff data available.';
  }

  let text = '🎬 *STAFF*\n━━━━━━━━━━━━━━━━━━━━\n';

  const grouped = {};
  staff.forEach(s => {
    const pos = s.positions?.join(', ') || 'Unknown';
    if (!grouped[pos]) grouped[pos] = [];
    grouped[pos].push(s.person?.name || 'Unknown');
  });

  let count = 0;
  for (const [pos, names] of Object.entries(grouped)) {
    if (count >= 20) break;
    text += `\n*${pos}*\n  ${names.join(', ')}\n`;
    count++;
  }

  if (Object.keys(grouped).length > count) {
    text += `\n... and more staff members.`;
  }

  return text;
}

// total = the anime's real episode count (null while it is still airing / unknown)
function buildEpisodesText(episodes, total, hasNext, title) {
  if (!episodes || episodes.length === 0) {
    return `📃 *EPISODES — ${title}*\n━━━━━━━━━━━━━━━━━━━━\n❌ No episode data available.`;
  }

  const totalLabel = Number.isFinite(total) && total > 0
    ? String(total)
    : (hasNext ? `${episodes.length}+` : String(episodes.length));

  let text = `📃 *EPISODES — ${title}*\n`;
  text += `Total: ${totalLabel} episodes${hasNext ? ' (showing first page)' : ''}\n━━━━━━━━━━━━━━━━━━━━\n`;

  episodes.slice(0, 30).forEach(ep => {
    const aired = ep.aired ? new Date(ep.aired).toLocaleDateString() : 'N/A';
    const flags = [ep.filler ? '🔹Filler' : '', ep.recap ? '🔸Recap' : ''].filter(Boolean).join(' ');
    text += `\nEp ${ep.mal_id ?? '?'} | ${ep.title || 'Untitled'}\n📅 ${aired} ${flags}\n`;
  });

  if (episodes.length > 30) {
    text += `\n... and ${episodes.length - 30} more episodes on this page.`;
  }
  if (hasNext) {
    text += `\n⚠️ More pages available (Jikan paginates at 100/page).`;
  }

  return text;
}

// ============================================================
// Main Command: .aniinfo
// ============================================================
cmd({
  pattern: "aniinfo",
  alias: ["ani"],
  desc: "Search anime from 3 servers (MAL / Bilibili / Jikan Full — 18+ supported)",
  category: "download",
  react: "🎌"
}, async (conn, mek, m, { from, reply, q }) => {
  globalConn = conn;
  ensureListener(conn);   // (re)binds the listener whenever the socket object changes (reconnects)
  const query = q;

  if (!query) return reply('Please provide an anime name.\nExample: .aniinfo Naruto');

  try {
    endSession(from);     // drop any old menu in this chat (and its timer)

    aniInfoSessions[from] = {
      step: 'select_server',
      query,
      triggerId: mek?.key?.id,        // the message that opened the menu is never an answer to it
      sender: senderOf(mek?.key)      // in groups only this person can answer
    };
    resetSessionTimeout(from);

    await simulateTyping(conn, from, randomDelay(1200, 2000));

    await sendServerMenu(conn, from, mek, `🔍 *Search:* ${query}\n\nSelect a server:`);
  } catch (error) {
    console.error('[ANIINFO] Command error:', error);
    reply('❌ Something went wrong.');
    endSession(from);
  }
});

// ============================================================
// Listener
// ============================================================

// One listener for the whole process. It follows the CURRENT socket: when the bot reconnects
// (new socket object) or this plugin is reloaded, the old listener is removed and a new one is bound.
function ensureListener(conn) {
  const cur = global._aniInfoListener;
  if (cur && cur.conn === conn && cur.handler === onUpsert) return;
  if (cur) { try { cur.conn.ev.off('messages.upsert', cur.handler); } catch (e) {} }
  conn.ev.on('messages.upsert', onUpsert);
  global._aniInfoListener = { conn, handler: onUpsert };
}

async function onUpsert(m) {
  for (const msg of (m?.messages || [])) {
    try {
      await handleIncoming(m.type, msg);
    } catch (err) {
      console.error('[ANIINFO] Listener error:', err);
    }
  }
}

async function handleIncoming(type, msg) {
  if (!msg || !msg.message || !msg.key) return;

  // The bot's own sends are echoed back as type 'append'. Only the owner typing on their phone arrives as 'notify'.
  if (msg.key.fromMe && type !== 'notify') return;

  const from = msg.key.remoteJid;
  const session = aniInfoSessions[from];
  if (!session) return;

  // The message that opened the menu is not an answer to it
  if (session.triggerId && msg.key.id === session.triggerId) return;

  // In groups only the person who opened the menu can answer it
  if (isGroupJid(from) && !sameSender(session.sender, senderOf(msg.key))) return;

  const inner = msg.message?.viewOnceMessage?.message || msg.message?.viewOnceMessageV2?.message ||
                msg.message?.ephemeralMessage?.message || msg.message;
  const textMsg = (inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || '').trim();

  let listId = inner.listResponseMessage?.singleSelectReply?.selectedRowId ||
               inner.templateButtonReplyMessage?.selectedId ||
               inner.buttonsResponseMessage?.selectedButtonId || null;
  if (!listId) {
    const pj = inner.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
               inner.interactiveResponseMessage?.nativeFlowResponseMessage?.params_json;
    if (pj) {
      try {
        const p = typeof pj === 'string' ? JSON.parse(pj) : pj;
        listId = p.id || p.selectedId || p.selected_id || null;
      } catch (e) {}
    }
  }

  // Ignore stickers/images/etc. and other commands (".aniinfo bleach", "!menu" ...): valid answers never start with a symbol
  if (!listId && (!textMsg || /^[^\p{L}\p{N}]/u.test(textMsg))) return;

  // Global cancel
  if (listId === 'close' || textMsg.toLowerCase() === 'cancel' || textMsg === '0') {
    endSession(from);
    await globalConn.sendMessage(from, { text: '❌ Menu closed.' }, { quoted: msg });
    return;
  }

  try {
    await runStep(session, from, msg, listId, textMsg);
  } catch (err) {
    console.error('[ANIINFO] Step error:', err);
    // never leave the user waiting on a half-finished step
    if (aniInfoSessions[from] === session && TRANSIENT_STEPS.includes(session.step)) {
      endSession(from);
      try {
        await globalConn.sendMessage(from, { text: '❌ Something went wrong. Please run the command again.' }, { quoted: msg });
      } catch (e) { /* connection problem: nothing more we can do */ }
    }
  }
}

async function runStep(session, from, msg, listId, textMsg) {
  // --------------------------------------------------
  // STEP 1: Server Selection
  // --------------------------------------------------
  if (session.step === 'select_server') {
    let server = null;
    if (listId === 'server_1' || textMsg === '1') server = 1;
    else if (listId === 'server_2' || textMsg === '2') server = 2;
    else if (listId === 'server_3' || textMsg === '3') server = 3;

    if (!server) {
      await globalConn.sendMessage(from, { text: '❌ Please select Server 1, 2 or 3.' }, { quoted: msg });
      return;
    }

    session.server = server;
    session.step = 'searching';
    resetSessionTimeout(from);

    await simulateTyping(globalConn, from, randomDelay(1500, 2500));

    // Server 3 uses sfw=false → includes 18+ (Hentai/Rx)
    const apiUrl = server === 1
      ? `https://api-nomo.zone.id/api/animesearch?q=${encodeURIComponent(session.query)}`
      : server === 2
      ? `https://api-nomo.zone.id/api/anisearch?q=${encodeURIComponent(session.query)}`
      : `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(session.query)}&sfw=false&limit=10`;

    let results;
    try {
      const res = await axios.get(apiUrl, { timeout: 15000 });
      const raw = server === 3 ? res.data?.data : (res.data?.status ? res.data.result : []);
      results = Array.isArray(raw) ? raw.filter(r => r && typeof r === 'object') : [];
    } catch (err) {
      console.error(`[ANIINFO] Server ${server} search error:`, err.message);
      if (aniInfoSessions[from] !== session) return;
      // keep the session: the user can retry or pick another server right away
      session.step = 'select_server';
      resetSessionTimeout(from);
      await sendServerMenu(globalConn, from, msg,
        `❌ *Server ${server}* did not respond.\n\n🔍 *Search:* ${session.query}\n\nTry again or pick another server:`);
      return;
    }

    // the menu may have been closed (or replaced) while we were waiting for the API
    if (aniInfoSessions[from] !== session) return;

    if (results.length === 0) {
      endSession(from);
      await globalConn.sendMessage(from, { text: '❌ No results found.' }, { quoted: msg });
      return;
    }

    results = results.slice(0, 10);

    // build everything first: if this throws, the step is still "searching" and the safety net tells the user
    let body = `🔍 *Results for "${session.query}"* (Server ${server})\n\n`;
    results.forEach((item, i) => {
      const title = item.title_english || item.title || 'Unknown';
      const ratingTag = item.rating && (item.rating.includes('Rx') || item.rating.includes('R+'))
        ? ' 🔞' : '';
      body += `${i + 1} | ${title}${ratingTag}\n`;
    });
    body += `\n0 | ❌ Close`;

    const sections = [{
      title: `Server ${server} Results`,
      rows: results.map((item, i) => {
        const ratingTag = item.rating && (item.rating.includes('Rx') || item.rating.includes('R+'))
          ? ' 🔞' : '';
        return {
          title: `${i + 1} | ${item.title_english || item.title}${ratingTag}`,
          description: server === 1
            ? `${item.type || 'Anime'} | ⭐ ${item.score || 'N/A'}`
            : server === 2
            ? `${item.duration || ''} | ${item.author || ''}`
            : `${item.type || 'Anime'} | ⭐ ${item.score || 'N/A'} | ${item.episodes || '?'} eps`,
          id: `ani_${i}`
        };
      })
    }];
    sections[0].rows.push({ title: '0 | ❌ Close', description: 'Close', id: 'close' });

    const thumb = server === 1
      ? (results[0].imageUrl || null)
      : server === 2
      ? (results[0].thumbnail || null)
      : (results[0].images?.jpg?.large_image_url || results[0].images?.jpg?.image_url || null);

    session.results = results;
    session.step = 'select_anime';
    resetSessionTimeout(from);

    await sendInteractiveList(globalConn, from, msg, 'Select Anime', body,
      'Tap a result or reply with a number', sections, thumb);
    return;
  }

  // --------------------------------------------------
  // STEP 2: Anime Selected → Show Details
  // --------------------------------------------------
  if (session.step === 'select_anime') {
    let selection = null;

    if (listId && listId.startsWith('ani_')) {
      const idx = parseInt(listId.split('_')[1]);
      if (!isNaN(idx) && idx >= 0 && idx < session.results.length) selection = idx;
    }
    if (selection === null && textMsg !== '') {
      const match = textMsg.match(/^(\d+)/);
      if (match) {
        const num = parseInt(match[1]);
        if (num >= 1 && num <= session.results.length) selection = num - 1;
      }
    }
    if (selection === null || !session.results[selection]) return;

    const item = session.results[selection];
    session.mediaTitle = item.title_english || item.title;
    session.step = 'show_details';
    resetSessionTimeout(from);

    await simulateTyping(globalConn, from, randomDelay(1500, 2500));

    // ----------------------------------------------
    // Server 1 & 2
    // ----------------------------------------------
    if (session.server !== 3) {
      let infoText = '';
      let posterUrl = null;

      if (session.server === 1) {
        const desc = item.description
          ? (item.description.length > 300 ? item.description.substring(0, 300) + '...' : item.description)
          : 'No description available.';
        infoText = `🎌 *${item.title}*\n📺 *Type:* ${item.type || 'N/A'}\n🎞️ *Episodes:* ${item.episodes || 'N/A'}\n⭐ *Score:* ${item.score || 'N/A'}\n🔗 *Link:* ${item.link || 'N/A'}\n\n📝 *Description:*\n${desc}`;
        posterUrl = item.imageUrl || null;
      } else {
        infoText = `🎬 *${item.title}*\n👁️ *Views:* ${item.views || 'N/A'}\n⏱️ *Duration:* ${item.duration || 'N/A'}\n👤 *Author:* ${item.author || 'N/A'}\n🔗 *URL:* ${item.url || 'N/A'}`;
        posterUrl = item.thumbnail || null;
      }

      session.posterUrl = posterUrl;
      session.step = 'ask_poster';

      await sendQuickButtons(globalConn, from, msg, infoText, 'Do you want the poster?', [
        { text: '🖼️ Yes, send poster', id: 'poster_yes' },
        { text: '❌ No, thanks', id: 'poster_no' }
      ]);
      return;
    }

    // ----------------------------------------------
    // Server 3 (Jikan) — FULL details
    // ----------------------------------------------
    const malId = item.mal_id;
    if (!malId) {
      endSession(from);
      await globalConn.sendMessage(from, { text: '❌ Invalid MAL ID.' }, { quoted: msg });
      return;
    }

    try {
      const fullData = await fetchJikanFullDetails(malId);
      if (!fullData) throw new Error('No full data');
      if (aniInfoSessions[from] !== session) return;   // closed while loading

      session.fullData = fullData;
      session.posterUrl = fullData.images?.jpg?.large_image_url || fullData.images?.jpg?.image_url || null;
      session.malId = malId;
      session.step = 'details_actions';
      resetSessionTimeout(from);

      // Send INFORMATION + SYNOPSIS
      await globalConn.sendMessage(from, { text: buildInfoText(fullData) }, { quoted: msg });

      // Action buttons
      await sendQuickButtons(
        globalConn, from, msg,
        '✅ *Information & Synopsis delivered.*\n\nWhat would you like next?',
        'Choose below:',
        [
          { text: '📃 Full Info & Episodes', id: 'show_full' },
          { text: '🖼️ Send Poster', id: 'poster_yes' },
          { text: '❌ Close', id: 'poster_no' }
        ]
      );
    } catch (err) {
      console.error('[ANIINFO] Jikan full details error:', err.message);
      if (aniInfoSessions[from] !== session) return;
      // keep the session: tapping a result again retries
      session.step = 'select_anime';
      resetSessionTimeout(from);
      await globalConn.sendMessage(from, { text: '❌ Failed to load full details. Tap a result again to retry.' }, { quoted: msg });
    }
    return;
  }

  // --------------------------------------------------
  // STEP 3: Details Actions (Server 3)
  // --------------------------------------------------
  if (session.step === 'details_actions') {
    // -------- FULL INFO + CHARACTERS + STAFF + EPISODES --------
    if (listId === 'show_full' || textMsg === '1') {
      const malId = session.malId;
      const title = session.mediaTitle;
      const total = session.fullData?.episodes ?? null;

      session.step = 'loading_full';   // lock: a second tap while loading is ignored
      resetSessionTimeout(from);

      try {
        await simulateTyping(globalConn, from, randomDelay(1500, 2000));

        // Characters
        await sleep(800);
        const characters = await fetchJikanCharacters(malId);

        // Staff
        await sleep(800);
        const staff = await fetchJikanStaff(malId);

        // Episodes
        await sleep(800);
        const { episodes, hasNext } = await fetchJikanEpisodes(malId, 1);

        if (aniInfoSessions[from] !== session) return;   // closed while loading

        // Send CHARACTERS
        await globalConn.sendMessage(from, { text: buildCharactersText(characters) }, { quoted: msg });
        await sleep(700);

        // Send STAFF
        await globalConn.sendMessage(from, { text: buildStaffText(staff) }, { quoted: msg });
        await sleep(700);

        // Send EPISODES
        await globalConn.sendMessage(from, { text: buildEpisodesText(episodes, total, hasNext, title) }, { quoted: msg });

        // Poster / Close
        session.step = 'ask_poster';
        resetSessionTimeout(from);
        await sendQuickButtons(
          globalConn, from, msg,
          '✅ *All data delivered!*',
          'What next?',
          [
            { text: '🖼️ Send Poster', id: 'poster_yes' },
            { text: '❌ Close', id: 'poster_no' }
          ]
        );
      } catch (err) {
        console.error('[ANIINFO] Full info fetch error:', err.message);
        if (aniInfoSessions[from] !== session) return;
        session.step = 'details_actions';   // unlock so the user can retry
        resetSessionTimeout(from);
        await globalConn.sendMessage(from, {
          text: '❌ Failed to load some data. Please try again.\n(Jikan API rate limit: 3 req/sec)'
        }, { quoted: msg });
      }
      return;
    }

    // -------- POSTER --------
    if (listId === 'poster_yes' || textMsg === '2') {
      const { posterUrl, mediaTitle } = session;
      endSession(from);   // end first, so a double tap cannot send the poster twice
      await sendPoster(globalConn, from, msg, posterUrl, mediaTitle);
      await globalConn.sendMessage(from, { text: '✅ Done. Have a nice day!' }, { quoted: msg });
      return;
    }

    // -------- CLOSE --------
    if (listId === 'poster_no' || textMsg === '3') {
      endSession(from);
      await globalConn.sendMessage(from, { text: '✅ Done. Have a nice day!' }, { quoted: msg });
      return;
    }

    await globalConn.sendMessage(from, { text: '❌ Please use the buttons.' }, { quoted: msg });
    return;
  }

  // --------------------------------------------------
  // STEP 4: Poster Confirmation (Server 1/2, and after "Full Info")
  // --------------------------------------------------
  if (session.step === 'ask_poster') {
    // exact answers only: free text such as "death note" must not count as "no"
    const yes = listId === 'poster_yes' || /^(y|yes|1)$/i.test(textMsg);
    const no = listId === 'poster_no' || /^(n|no|2)$/i.test(textMsg);

    if (yes) {
      const { posterUrl, mediaTitle } = session;
      endSession(from);
      await sendPoster(globalConn, from, msg, posterUrl, mediaTitle);
    } else if (no) {
      endSession(from);
      await globalConn.sendMessage(from, { text: '✅ Done. Have a nice day!' }, { quoted: msg });
    } else {
      await globalConn.sendMessage(from, { text: '❌ Please choose (1 = Yes / 2 = No).' }, { quoted: msg });
    }
    return;
  }
}
