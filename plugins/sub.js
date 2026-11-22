/**
 * 🎬 SUBTITLE DOWNLOADER — KCeY Subs API
 * ──────────────────────────────────────────────────────────────
 *  .sub <name>            search            e.g.  .sub naruto
 *  .sub <name> ep <no>    jump to episode   e.g.  .sub naruto ep 5
 *
 *  Used by the buttons (you can also type them by hand):
 *  .subget <sid> <title#> [page]    show file list
 *  .subdl  <sid> <title#> <file#>   send the file
 *
 *  Built for the `baileyz` socket (Dnuzi / DanuZz): buttons go through
 *  conn.sendMessage(jid, { interactiveMessage }) — no extra imports needed.
 *
 *  SETUP
 *  1) npm i axios                               (skip if already installed)
 *  2) Put this file in your plugins folder      (fix the require('../command') path if yours differs)
 *  3) Button taps must reach your handler as text. In index.js, where `body` is built, add:
 *       : (type === 'interactiveResponseMessage')
 *         ? JSON.parse(mek.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson).id
 *  4) Recommended: put the key in .env as KCEY_API_KEY instead of hard-coding it.
 */

const { cmd } = require('../command');
const axios = require('axios');

// ───────────── Config ─────────────
const API_URL     = 'https://api.kcey.online/api/subs';
const API_KEY     = process.env.KCEY_API_KEY || 'kcey_854640828e7d4c1f97a612eeeed122c3a6f0';
const PREFIX      = process.env.PREFIX || '.';
const PAGE_SIZE   = 8;                 // files per page (8 + 2 nav rows = 10, WhatsApp's list-row limit)
const MAX_TITLES  = 10;                // titles shown after a search
const MAX_FILE_MB = 90;                // bigger files → send the link instead
const TTL         = 15 * 60 * 1000;    // how long the buttons stay valid

// ───────────── Session store (results stay in memory, buttons carry only a short id) ─────────────
const sessions = new Map();

function newSession(data) {
  const now = Date.now();
  for (const [k, v] of sessions) if (now - v.at > TTL) sessions.delete(k);
  const sid = Math.random().toString(36).slice(2, 7);
  sessions.set(sid, { ...data, at: now });
  return sid;
}

function getSession(sid) {
  const s = sessions.get(sid);
  return s && Date.now() - s.at < TTL ? s : null;
}

// ───────────── Helpers ─────────────
const MIME = {
  srt: 'application/x-subrip', ass: 'text/x-ssa', ssa: 'text/x-ssa', vtt: 'text/vtt',
  zip: 'application/zip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
};
const ext        = (n) => (n.split('.').pop() || '').toLowerCase();
const isArchive  = (n) => ['zip', '7z', 'rar'].includes(ext(n));
const cut        = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const fmtSize    = (b) => (!b ? '' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const errMsg = (e) =>
  [401, 403].includes(e.response?.status) ? 'API key rejected — check KCEY_API_KEY.'
  : e.response?.status === 429 ? 'API rate limit reached — try again in a bit.'
  : e.message;

// API result → { title, source, files[{name,size,download}] }
function normalize(r) {
  const raw = r.files?.length ? r.files : r.download ? [{ download: r.download }] : [];
  return {
    title: r.title || r.english || r.romaji || 'Unknown',
    source: r.source || '',
    files: raw.filter((f) => f && f.download).map((f) => ({
      name: f.name || safeDecode(f.download.split('?')[0].split('/').pop()),
      size: f.size || 0,
      download: f.download,
    })),
  };
}

// files shown for one title: episode filter (if "ep N" was used) + archives first
function visibleFiles(sess, entry) {
  let files = entry.files;
  if (sess.ep != null) {
    const re = new RegExp(`E0*${sess.ep}(?!\\d)`, 'i');   // matches E5 / E05 / E005, not E15 / E50
    const hit = files.filter((f) => re.test(f.name));
    if (hit.length) files = hit;
  }
  return [...files].sort((a, b) => isArchive(b.name) - isArchive(a.name));
}

// baileyz native-flow "list" button  (header = plain string, title = body text)
async function sendList(conn, jid, mek, { title, body, footer, button, sections }) {
  await conn.sendMessage(jid, {
    interactiveMessage: {
      header: title,
      title: body,
      footer,
      buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify({ title: button, sections }) }],
    },
  }, { quoted: mek });
}

// download the file and send it as a document
async function sendFile(conn, from, mek, f) {
  if (f.size > MAX_FILE_MB * 1048576) {
    return conn.sendMessage(from, { text: `⚠️ Too large to upload (${fmtSize(f.size)}).\n\n🔗 ${f.download}` }, { quoted: mek });
  }
  await conn.sendMessage(from, { react: { text: '⬇️', key: mek.key } });
  const res = await axios.get(f.download, {
    responseType: 'arraybuffer',
    timeout: 120000,
    maxContentLength: MAX_FILE_MB * 1048576,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  await conn.sendMessage(from, {
    document: Buffer.from(res.data),
    mimetype: MIME[ext(f.name)] || 'application/octet-stream',
    fileName: f.name,
    caption: `✅ ${cut(f.name, 120)}`,
  }, { quoted: mek });
  await conn.sendMessage(from, { react: { text: '✅', key: mek.key } });
}

// paged file list for one title (sends the file directly if only one matches)
async function showFiles(conn, from, mek, sid, ei, page) {
  const sess = getSession(sid);
  if (!sess) return conn.sendMessage(from, { text: '⌛ Session expired — please search again.' }, { quoted: mek });
  const entry = sess.entries[ei - 1];
  if (!entry) return conn.sendMessage(from, { text: '❌ Invalid title number.' }, { quoted: mek });

  const files = visibleFiles(sess, entry);
  if (files.length === 1) return sendFile(conn, from, mek, files[0]);

  const pages = Math.ceil(files.length / PAGE_SIZE);
  const pg = Math.min(Math.max(page, 1), pages);
  const start = (pg - 1) * PAGE_SIZE;
  const slice = files.slice(start, start + PAGE_SIZE);

  const rows = slice.map((f, i) => {
    const code = (f.name.match(/S\d{1,2}E\d{1,4}/i) || [])[0];
    return {
      header: '',
      title: isArchive(f.name) ? '📦 ' + cut(f.name, 21) : code ? code.toUpperCase() : cut(f.name, 24),
      description: cut([fmtSize(f.size), f.name].filter(Boolean).join(' • '), 72),
      id: `${PREFIX}subdl ${sid} ${ei} ${start + i + 1}`,
    };
  });

  const sections = [{ title: `Files ${start + 1}-${start + slice.length} of ${files.length}`, rows }];
  const nav = [];
  if (pg > 1)     nav.push({ header: '', title: '⬅️ Previous page', description: `Page ${pg - 1}/${pages}`, id: `${PREFIX}subget ${sid} ${ei} ${pg - 1}` });
  if (pg < pages) nav.push({ header: '', title: 'Next page ➡️',     description: `Page ${pg + 1}/${pages}`, id: `${PREFIX}subget ${sid} ${ei} ${pg + 1}` });
  if (nav.length) sections.push({ title: 'Navigation', rows: nav });

  const list = slice.map((f, i) => `${start + i + 1}. ${cut(f.name, 60)}`).join('\n');
  await sendList(conn, from, mek, {
    title: `📂 ${cut(entry.title, 40)}`,
    body: `Page ${pg}/${pages} • ${files.length} files\n\n${list}\n\nButtons not showing? Type:\n${PREFIX}subdl ${sid} ${ei} <file number>`,
    footer: '🎬 Subtitle Downloader',
    button: '📄 Select file',
    sections,
  });
}

// ───────────── Commands ─────────────

// 1) search
cmd({
  pattern: 'sub',
  alias: ['subs', 'subtitle'],
  desc: 'Search & download subtitles (anime / movies)',
  category: 'download',
  use: '.sub naruto  |  .sub naruto ep 5',
  filename: __filename,
}, async (conn, mek, m, { from, q, reply }) => {
  try {
    if (!q) return reply(`🎬 *Subtitle Downloader*\n\n${PREFIX}sub naruto\n${PREFIX}sub naruto ep 5`);

    const epm = q.match(/\s+(?:ep|episode)\s*(\d{1,4})$/i);
    const ep = epm ? parseInt(epm[1], 10) : null;
    const query = (epm ? q.slice(0, epm.index) : q).trim();

    await conn.sendMessage(from, { react: { text: '🔎', key: mek.key } });
    const { data } = await axios.get(API_URL, { params: { q: query, key: API_KEY }, timeout: 60000 });

    const entries = (data?.results || []).map(normalize).filter((e) => e.files.length).slice(0, MAX_TITLES);
    if (!data?.status || !entries.length) return reply(`❌ No subtitles found for *${query}*`);

    const sid = newSession({ entries, ep });
    if (entries.length === 1) return showFiles(conn, from, mek, sid, 1, 1);

    const rows = entries.map((e, i) => ({
      header: '',
      title: cut(e.title, 24),
      description: `📁 ${e.files.length} file${e.files.length > 1 ? 's' : ''}${e.source ? ' • ' + e.source : ''}`,
      id: `${PREFIX}subget ${sid} ${i + 1}`,
    }));
    const list = entries.map((e, i) => `${i + 1}. ${cut(e.title, 50)} (${e.files.length})`).join('\n');

    await sendList(conn, from, mek, {
      title: '🎬 Subtitle Search',
      body: `*${query}*${ep != null ? ` • Episode ${ep}` : ''}\n\n${list}\n\nButtons not showing? Type:\n${PREFIX}subget ${sid} <number>`,
      footer: '🎬 Subtitle Downloader',
      button: '📋 Select title',
      sections: [{ title: 'Results', rows }],
    });
  } catch (e) {
    console.log('[sub]', e);
    reply('❌ ' + errMsg(e));
  }
});

// 2) file list (button target)
cmd({
  pattern: 'subget',
  desc: 'Subtitle file list (internal)',
  category: 'download',
  dontAddCommandList: true,
  filename: __filename,
}, async (conn, mek, m, { from, q, reply }) => {
  try {
    const [sid, ei, pg] = (q || '').trim().split(/\s+/);
    await showFiles(conn, from, mek, sid, parseInt(ei, 10) || 1, parseInt(pg, 10) || 1);
  } catch (e) {
    console.log('[subget]', e);
    reply('❌ ' + errMsg(e));
  }
});

// 3) download (button target)
cmd({
  pattern: 'subdl',
  desc: 'Subtitle file download (internal)',
  category: 'download',
  dontAddCommandList: true,
  filename: __filename,
}, async (conn, mek, m, { from, q, reply }) => {
  try {
    const [sid, ei, fi] = (q || '').trim().split(/\s+/);
    const sess = getSession(sid);
    if (!sess) return reply('⌛ Session expired — please search again.');
    const entry = sess.entries[(parseInt(ei, 10) || 0) - 1];
    const file = entry && visibleFiles(sess, entry)[(parseInt(fi, 10) || 0) - 1];
    if (!file) return reply('❌ Invalid file number.');
    await sendFile(conn, from, mek, file);
  } catch (e) {
    console.log('[subdl]', e);
    reply('❌ ' + errMsg(e));
  }
});
