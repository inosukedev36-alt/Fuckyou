const axios = require('axios');
const { cmd } = require('../command');
const { generateWAMessageFromContent, proto, prepareWAMessageMedia } = require('@dnuzi/baileys');

// ============================================================
// Config
// ============================================================
const API_BASE = 'https://vortex-api-theta.vercel.app/anime/mal';
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;   // a menu stays open for 5 minutes
const REQUEST_TIMEOUT_MS = 20000;
const ROWS_PER_LIST = 10;                   // a WhatsApp list holds 10 rows: more results are sent as extra lists
const MAX_RESULTS = 100;                    // safety net only (the API sends about 10): never flood a chat
const MAX_BODY_LEN = 1000;                  // keep the menu text under WhatsApp's 1024 limit
const MAX_TEXT_LEN = 3500;                  // longer texts are sent in several parts
const SEP = '━━━━━━━━━━━━━━━━━━━━';

// ============================================================
// Sessions: one open menu per chat
// ============================================================
let globalConn = null;
const sessions = {};

// Ends a session AND its expiry timer (a leftover timer must never touch a later session)
function endSession(from) {
  const s = sessions[from];
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  delete sessions[from];
}

function resetSessionTimeout(from) {
  const s = sessions[from];
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  s.timeout = setTimeout(() => {
    // expire only THIS session, never a newer one started in the same chat
    if (sessions[from] === s) {
      delete sessions[from];
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
// Small helpers
// ============================================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// shows "typing…" in the chat while a task is running
async function withTyping(conn, jid, task) {
  try { await conn.sendPresenceUpdate('composing', jid); } catch (e) {}
  try {
    return await task();
  } finally {
    try { await conn.sendPresenceUpdate('paused', jid); } catch (e) {}
  }
}

// ============================================================
// API (vortex-api)
// ============================================================

// one retry: serverless APIs sometimes fail on a cold start
async function apiGet(path) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.get(`${API_BASE}${path}`, { timeout: REQUEST_TIMEOUT_MS });
      return res.data;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(800);
    }
  }
  throw lastErr;
}

// GET /anime/mal/search?text=naruto  ->  { status, result: [ { id, title, type, year, aired, score, status, url, image } ] }
async function searchAnime(query) {
  const data = await apiGet(`/search?text=${encodeURIComponent(query)}`);
  const list = data && data.status !== false && Array.isArray(data.result) ? data.result : [];
  return list.filter(r => r && typeof r === 'object' && r.id != null);
}

// GET /anime/mal/info?id=41457  ->  { status, result: { ...every detail of the anime } }
async function fetchAnimeInfo(id) {
  const data = await apiGet(`/info?id=${encodeURIComponent(id)}`);
  const info = data && data.status !== false ? data.result : null;
  if (!info || typeof info !== 'object') throw new Error('Empty info response');
  return info;
}

// ============================================================
// Interactive list (button)
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
    // the numbered text is still readable and "reply with a number" still works
    console.error('[ANIINFO] Interactive list error:', e.message);
    await conn.sendMessage(from, { text: bodyText + '\n\n' + footerText }, { quoted: mek });
    return false;
  }
}

// ============================================================
// Format builders
// ============================================================

// ---------- search results ----------
// How much of each result goes into the menu text: the first level that fits WhatsApp's body limit is used.
// (The list rows always carry type | score | aired | status, so nothing is lost either way.)
const BODY_LEVELS = [
  (r) => [r.type, r.score ? `⭐ ${r.score}` : null, r.aired || r.year, r.status],
  (r) => [r.type, r.score ? `⭐ ${r.score}` : null, r.year],
  () => []
];

// pageResults = the results of ONE list, startIndex = how many results came before it (numbering is global)
function buildResultsBody(query, pageResults, startIndex, total) {
  const range = total > pageResults.length
    ? ` (${startIndex + 1}–${startIndex + pageResults.length} of ${total})` : '';
  const head = `🔍 *Results for "${truncate(query, 60)}"*${range}\n\n`;

  const build = (level, maxTitle) => head + pageResults.map((r, i) => {
    const title = truncate(String(r.title || 'Unknown'), maxTitle);
    const meta = level(r).filter(Boolean).join(' • ');
    return `${startIndex + i + 1} | ${title}${meta ? ` — ${meta}` : ''}`;
  }).join('\n');

  for (const level of BODY_LEVELS) {
    const body = build(level, 200);
    if (body.length <= MAX_BODY_LEN) return body;
  }
  return build(() => [], 60);   // absurdly long titles: shorten them as a last resort
}

function buildResultRows(pageResults, startIndex) {
  return pageResults.map((r, i) => ({
    title: `${startIndex + i + 1} | ${truncate(String(r.title || 'Unknown'), 100)}`,
    description: truncate(
      [r.type, r.score ? `⭐ ${r.score}` : null, r.aired || r.year, r.status].filter(Boolean).join(' | '), 72
    ) || 'Anime',
    id: `ani_${startIndex + i}`
  }));
}

// EVERY result gets a row: 10 per list, so 25 results = 3 lists (numbering and ids continue across them)
async function sendResultLists(conn, from, mek, session) {
  const { query, results } = session;
  const multi = results.length > ROWS_PER_LIST;

  for (let start = 0; start < results.length; start += ROWS_PER_LIST) {
    if (sessions[from] !== session) return;   // closed while sending
    const page = results.slice(start, start + ROWS_PER_LIST);

    await sendInteractiveList(
      conn, from, mek,
      'Select Anime',
      buildResultsBody(query, page, start, results.length),
      'Tap the button or reply with a number (0 = close)',
      [{ title: multi ? `Results ${start + 1}-${start + page.length}` : 'MAL Results', rows: buildResultRows(page, start) }],
      page[0].image || null
    );

    if (start + ROWS_PER_LIST < results.length) await sleep(700);
  }
}

// ---------- full details ----------
// [key in the API response, emoji, label]. "image" is sent as the poster, "scored_by" is shown next to the score.
const FIELD_GROUPS = [
  [
    ['id', '🆔', 'MAL ID'],
    ['title', '🎌', 'Title'],
    ['title_english', '🇬🇧', 'English Title'],
    ['type', '📺', 'Type'],
    ['episodes', '🎞️', 'Episodes'],
    ['volumes', '📚', 'Volumes'],
    ['status', '📡', 'Status'],
    ['aired', '📅', 'Aired'],
    ['premiered', '🌸', 'Premiered'],
    ['broadcast', '📻', 'Broadcast'],
    ['duration', '⏱️', 'Duration']
  ],
  [
    ['score', '⭐', 'Score'],
    ['rank', '🏆', 'Rank'],
    ['popularity', '❤️', 'Popularity']
  ],
  [
    ['genres', '🎭', 'Genres'],
    ['studios', '🏢', 'Studios'],
    ['source', '📖', 'Source'],
    ['rating', '🔖', 'Rating'],
    ['url', '🔗', 'MAL Link']
  ]
];

function fmtValue(v) {
  if (v === null || v === undefined) return 'N/A';
  if (Array.isArray(v)) {
    const items = v
      .map(x => (x && typeof x === 'object') ? (x.name || x.title || JSON.stringify(x)) : String(x))
      .filter(s => s.trim() !== '');
    return items.length ? items.join(', ') : 'N/A';
  }
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v).trim();
  return s === '' ? 'N/A' : s;
}

const prettyKey = (k) => String(k).replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function buildInfoText(d) {
  const handled = new Set(['image', 'synopsis', 'scored_by']);
  const lines = ['📋 *ANIME INFORMATION*', SEP];

  for (const group of FIELD_GROUPS) {
    for (const [key, emoji, label] of group) {
      handled.add(key);
      let val = fmtValue(d[key]);
      if (key === 'score' && d.score != null && d.scored_by != null) {
        const n = Number(d.scored_by);
        val += ` (${Number.isFinite(n) ? n.toLocaleString('en-US') : d.scored_by} users)`;
      }
      if ((key === 'rank' || key === 'popularity') && /^\d+$/.test(val)) val = `#${val}`;
      if (key === 'rating' && /^(Rx|R\+)/i.test(val)) val += ' 🔞';
      lines.push(`${emoji} *${label}:* ${val}`);
    }
    lines.push(SEP);
  }

  // any other field the API sends is listed too, so nothing is ever left out
  const extras = Object.keys(d).filter(k => !handled.has(k));
  if (extras.length) {
    for (const k of extras) lines.push(`🔸 *${prettyKey(k)}:* ${fmtValue(d[k])}`);
    lines.push(SEP);
  }

  lines.push('📝 *SYNOPSIS*', fmtValue(d.synopsis));
  return lines.join('\n');
}

// splits a long text on line breaks so every part stays below MAX_TEXT_LEN
function chunkText(text, max = MAX_TEXT_LEN) {
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && (cur + '\n' + line).length > max) { parts.push(cur); cur = ''; }
    let l = line;
    while (l.length > max) {
      let cut = l.lastIndexOf(' ', max);       // prefer a word boundary
      if (cut < max * 0.5) cut = max;
      parts.push(l.slice(0, cut).trimEnd());
      l = l.slice(cut).trimStart();
    }
    cur = cur ? cur + '\n' + l : l;
  }
  if (cur) parts.push(cur);
  return parts;
}

// poster (the "image" field) first, then every detail
async function sendAnimeInfo(conn, from, quoted, info) {
  const name = info.title_english || info.title || 'Anime';

  if (info.image) {
    try {
      await conn.sendMessage(from, { image: { url: info.image }, caption: `🎌 *${name}*` }, { quoted });
    } catch (e) {
      console.error('[ANIINFO] Poster send error:', e.message);   // the details are still sent below
    }
  }

  for (const part of chunkText(buildInfoText(info))) {
    await conn.sendMessage(from, { text: part }, { quoted });
  }
}

// ============================================================
// Main Command: .aniinfo
// ============================================================
cmd({
  pattern: "aniinfo",
  alias: ["ani"],
  desc: "Search anime on MyAnimeList and get its full details",
  category: "download",
  react: "🎌"
}, async (conn, mek, m, { from, reply, q }) => {
  globalConn = conn;
  ensureListener(conn);   // (re)binds the listener whenever the socket object changes (reconnects)

  const query = (q || '').trim();
  if (!query) return reply('Please provide an anime name.\nExample: .aniinfo Naruto');

  endSession(from);       // drop any old menu in this chat (and its timer)

  const session = {
    step: 'searching',
    query,
    results: [],
    cmdMsg: mek,                    // every reply quotes the command message
    triggerId: mek?.key?.id,        // the message that opened the menu is never an answer to it
    sender: senderOf(mek?.key),     // in groups only this person can answer
    seen: new Set()                 // message ids already handled (no double sends)
  };
  sessions[from] = session;
  resetSessionTimeout(from);

  try {
    const results = await withTyping(conn, from, () => searchAnime(query));
    if (sessions[from] !== session) return;   // closed or replaced while searching

    if (results.length === 0) {
      endSession(from);
      return reply(`❌ No results found for "${query}".`);
    }

    session.results = results.slice(0, MAX_RESULTS);
    session.step = 'select_anime';
    resetSessionTimeout(from);

    await sendResultLists(conn, from, mek, session);
  } catch (error) {
    console.error('[ANIINFO] Search error:', error.message);
    if (sessions[from] === session) endSession(from);
    reply('❌ Search failed: the anime server did not respond. Please try again in a moment.');
  }
});

// ============================================================
// Listener
// ============================================================

// One listener for the whole process. It follows the CURRENT socket: when the bot reconnects
// (new socket object) or this plugin is reloaded, the old listener is removed and a new one is bound.
function ensureListener(conn) {
  const cur = global._aniMalListener;
  if (cur && cur.conn === conn && cur.handler === onUpsert) return;
  if (cur) { try { cur.conn.ev.off('messages.upsert', cur.handler); } catch (e) {} }
  conn.ev.on('messages.upsert', onUpsert);
  global._aniMalListener = { conn, handler: onUpsert };
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
  const session = sessions[from];
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

  // The same message can be delivered twice: handle each one only once
  if (msg.key.id) {
    if (session.seen.has(msg.key.id)) return;
    session.seen.add(msg.key.id);
  }

  // Cancel
  if (listId === 'close' || textMsg.toLowerCase() === 'cancel' || textMsg === '0') {
    endSession(from);
    await globalConn.sendMessage(from, { text: '❌ Menu closed.' }, { quoted: session.cmdMsg });
    return;
  }

  await handleSelection(session, from, listId, textMsg);
}

// An anime was picked: take its ID -> /info?id=<ID> -> send the poster + every detail
async function handleSelection(session, from, listId, textMsg) {
  if (session.step !== 'select_anime') return;   // still searching, or already loading: ignore

  let selection = null;
  if (listId && listId.startsWith('ani_')) {
    const idx = parseInt(listId.slice(4), 10);
    if (Number.isInteger(idx) && idx >= 0 && idx < session.results.length) selection = idx;
  }
  if (selection === null && textMsg) {
    const match = textMsg.match(/^(\d{1,3})(?:\s*\|.*)?$/);   // "3" or "3 | Title"
    if (match) {
      const num = parseInt(match[1], 10);
      if (num >= 1 && num <= session.results.length) selection = num - 1;
    }
  }
  if (selection === null) return;

  const item = session.results[selection];
  session.step = 'loading';   // lock: a second tap while loading is ignored
  resetSessionTimeout(from);

  try {
    const info = await withTyping(globalConn, from, () => fetchAnimeInfo(item.id));
    if (sessions[from] !== session) return;   // closed while loading
    await sendAnimeInfo(globalConn, from, session.cmdMsg, info);
  } catch (err) {
    console.error('[ANIINFO] Info error:', err.message);
    if (sessions[from] === session) {
      try {
        await globalConn.sendMessage(from, {
          text: `❌ Failed to load the details of *${item.title}*. Tap a result again to retry.`
        }, { quoted: session.cmdMsg });
      } catch (e) { /* connection problem: nothing more we can do */ }
    }
  } finally {
    // unlock: the menu stays open so another result can be picked
    if (sessions[from] === session) {
      session.step = 'select_anime';
      resetSessionTimeout(from);
    }
  }
}
