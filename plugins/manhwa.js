/**
 * ─────────────────────────────────────────────────────────────────
 *  🔞  MANHWA  ·  search → pick manhwa → pick chapter(s) → PDF
 * ─────────────────────────────────────────────────────────────────
 *  Chat usage
 *    .manhwa new          → search list   (reply with the manhwa number)
 *                         → chapter list  (reply with one of these ↓)
 *         5               one chapter
 *         all             EVERY chapter (one PDF each)
 *         1-10  /  3,7,12 a range  /  a few chapters
 *         stop            cancel a running batch
 *         0               close the list
 *
 *    Optional extras – add them to ANY chapter reply, in any order:
 *         120363xxxxxxxxxxxxxx@g.us   send the PDFs to that group (bot must be a member)
 *         (SLPL)                      file name becomes  (SLPL)Solo Leveling - Chapter 1.pdf
 *      e.g.  all 120363xxxxxxxxxxxxxx@g.us (SLPL)
 *            5 (SLPL)
 *            1-10 120363xxxxxxxxxxxxxx@g.us
 *
 *    PDF_ONLY (CONFIG, default true): only the renamed PDFs are sent – no caption, no quote,
 *    no "Sending…"/summary messages. A message still appears if something fails or is stopped.
 *
 *  Install    npm i axios pdf-lib        (optional: sharp → for .webp pages)
 *  Location   <your-bot>/plugins/manhwa.js
 * ─────────────────────────────────────────────────────────────────
 */

const axios = require('axios');
// [gf-integration] pdf-lib is not installed yet in every project: load it softly so the bot still starts (run:  npm install)
let PDFDocument = null;
try { ({ PDFDocument } = require('pdf-lib')); } catch (_) { /* reported when the command is used */ }
const { cmd } = require('../command'); // ← if your bot exports `cmd` from somewhere else, change this line

let sharp = null;
try { sharp = require('sharp'); } catch (_) { /* optional */ }

/* ───────────────────────── CONFIG ───────────────────────── */
const CONFIG = {
  API_SEARCH: 'https://poddax-api.dev/manhwa-search',
  API_DL: 'https://poddax-api.dev/manhwa-dl',
  REFERER: 'https://manga18fx.com/',
  BANNER: '',              // image URL / local path for the list cards ('' = text only)
  FOOTER: 'Hexora mini 🌺👾',
  MAX_RESULTS: 10,         // how many search results to list
  SESSION_MIN: 30,         // minutes a list stays "replyable"
  DELAY_MS: 4000,          // pause between chapters in batch mode (helps avoid WhatsApp spam limits)
  IMG_CONCURRENCY: 5,      // parallel page downloads
  ONLY_REQUESTER: false,   // true = only the person who ran .manhwa can reply to the lists
  TARGET_OWNER_ONLY: true, // true = sending to ANOTHER group needs isOwner (if your bot provides it)
  PDF_ONLY: true,          // true = send ONLY the renamed PDFs (no caption / quote / status chatter); false = SS-style captions
};
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

/* ───────────────────────── STATE ───────────────────────── */
const sessions = new Map();   // bot message id  →  session
const hooked = new WeakSet(); // sockets that already have our reply listener
const seen = new Set();       // reply ids already handled

/* ───────────────────────── HELPERS ───────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jidNum = (j) => String(j || '').split('@')[0].split(':')[0];
const touch = (s) => { s.expires = Date.now() + CONFIG.SESSION_MIN * 60000; return s; };
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
const say = (conn, jid, text, quoted) => conn.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
const react = (conn, msg, emoji) =>
  conn.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } }).catch(() => {});

function prune() {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expires < now) sessions.delete(id);
}

function once(id) {
  if (!id || seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 500) seen.delete(seen.values().next().value);
  return true;
}

async function retry(fn, tries = 3, wait = 1500) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < tries) await sleep(wait * i); }
  }
  throw last;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  let stop = false;
  const worker = async () => {
    while (!stop) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); } catch (e) { stop = true; throw e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function unwrap(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    const inner = (m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2 || m.documentWithCaptionMessage || {}).message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

// "all" | "5" | "1-10" | "3,7,12"  →  sorted array of 1-based indexes (or null if invalid)
function parseSelection(text, max) {
  if (text === 'all') return Array.from({ length: max }, (_, i) => i + 1);
  const picks = new Set();
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    let a = +m[1];
    let b = m[2] ? +m[2] : a;
    if (a > b) [a, b] = [b, a];
    for (let i = Math.max(a, 1); i <= Math.min(b, max); i++) picks.add(i);
  }
  return picks.size ? [...picks].sort((x, y) => x - y) : null;
}

// "all 120363…@g.us (SLPL)"  →  { sel: 'all', target: '120363…@g.us', tag: 'SLPL' }
const GROUP_JID = /^\d{5,}(?:-\d+)?@g\.us$/i;
function parseReply(raw) {
  let rest = String(raw || '');
  let tag = '';
  const tm = rest.match(/\(([^()]*)\)/);
  if (tm) {
    tag = safeName(tm[1]).slice(0, 40).trim();
    rest = rest.replace(tm[0], ' ');
  }
  let target = '';
  const words = [];
  for (const w of rest.split(/\s+/).filter(Boolean)) {
    if (GROUP_JID.test(w)) target = w.toLowerCase();
    else if (/^\d{15,}$/.test(w)) target = `${w}@g.us`; // JID pasted without "@g.us"
    else words.push(w);
  }
  return { sel: words.join(' ').toLowerCase(), target, tag };
}

// [1,2,3,5,9,10] → "1-3,5,9-10"
function ranges(nums) {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `${nums[i]}-${nums[j]}` : `${nums[i]}`);
    i = j;
  }
  return out.join(',');
}

// WhatsApp silently drops messages from non-admins in admin-only groups, so warn when we can tell
function adminWarning(conn, meta) {
  if (!meta || !meta.announce) return '';
  const me = [conn.user && conn.user.id, conn.user && conn.user.lid].filter(Boolean).map(jidNum);
  const mine = (meta.participants || []).find((p) =>
    [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(jidNum).some((x) => me.includes(x)));
  return mine && !mine.admin ? '⚠️ That group is admin-only and the bot is not an admin — files may not be delivered.' : '';
}

/* ───────────────────────── CARDS ───────────────────────── */
const LINE = '──────────────';

const searchCard = (query, results) => [
  '╭─〔 🔞 𝐌𝐀𝐍𝐇𝐖𝐀 𝐒𝐄𝐀𝐑𝐂𝐇 〕─╮',
  `│ 🔎 Search: ${query}`,
  `╰${LINE}╯`,
  '',
  ...results.map((r, i) => `${i + 1} | 📖 ${r.title}`),
  '',
  '0 | ❎ CLOSE',
  '',
  '│ Reply with manhwa number.',
  '',
  `│ ${CONFIG.FOOTER}`,
].join('\n');

const chaptersCard = (title, chapters) => [
  '╭─〔 🔞 𝐂𝐇𝐀𝐏𝐓𝐄𝐑𝐒 〕─╮',
  `│ 📖 ${title}`,
  `│ 📄 Total Chapters: ${chapters.length}`,
  `╰${LINE}╯`,
  '',
  ...chapters.map((c, i) => `${i + 1} | 📄 ${c.title}`),
  '',
  '0 | ❎ CLOSE',
  '',
  '│ Reply with chapter number',
  '│ ➜ *all*  = every chapter',
  '│ ➜ *1-10* or *3,5,8*  = several',
  '│ ➜ + *group JID*  = send to that group',
  '│ ➜ + *(TAG)*  = file name prefix',
  '',
  `│ ${CONFIG.FOOTER}`,
].join('\n');

// image + caption when a banner is set, plain text otherwise (also for very long lists)
async function sendCard(conn, jid, text, quoted) {
  if (CONFIG.BANNER && text.length <= 2500) {
    try {
      return await conn.sendMessage(jid, { image: { url: CONFIG.BANNER }, caption: text }, { quoted });
    } catch (e) {
      console.error('[manhwa] banner failed, sending text instead:', e.message);
    }
  }
  return say(conn, jid, text, quoted);
}

/* ───────────────────────── PDF BUILDER ───────────────────────── */
async function embedImage(pdf, buf) {
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (isJpg) return pdf.embedJpg(buf);
  if (isPng) return pdf.embedPng(buf);
  if (!sharp) throw new Error('page is webp/other format → run: npm i sharp');
  const jpg = await sharp(buf).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
  return pdf.embedJpg(jpg);
}

async function buildPdf(urls) {
  const pages = await mapLimit(urls, CONFIG.IMG_CONCURRENCY, (url, i) =>
    retry(async () => {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 45000,
        headers: { Referer: CONFIG.REFERER, 'User-Agent': UA },
      });
      return Buffer.from(res.data);
    }, 3).catch((e) => { throw new Error(`page ${i + 1}: ${e.message}`); })
  );

  if (!PDFDocument) throw new Error('pdf-lib is not installed (npm install)');
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages.length; i++) {
    const img = await embedImage(pdf, pages[i]);
    pdf.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    pages[i] = null; // free memory as we go
  }
  return Buffer.from(await pdf.save());
}

/* ───────────────────────── SENDING CHAPTERS ───────────────────────── */
// job = { dest, other, destName, tag, warn }   dest = where the PDFs go, other = dest is not this chat
async function sendOne(conn, session, idx, job, quoted) {
  const ch = session.chapters[idx - 1];
  const { data } = await retry(
    () => axios.get(CONFIG.API_DL, { params: { url: ch.url }, timeout: 60000 }), 2);

  const pages = data && data.DownloadUrl;
  if (!data || !data.status || !Array.isArray(pages) || !pages.length) throw new Error('API returned no pages');

  const pdf = await buildPdf(pages);
  const fileName = `${job.tag ? `(${job.tag})` : ''}${safeName(`${session.title} - ${ch.title}`)}.pdf`;
  const content = { document: pdf, mimetype: 'application/pdf', fileName };
  if (!CONFIG.PDF_ONLY) {
    content.caption = [
      `🔞 *${session.title}*`,
      `📄 Chapter: ${ch.title}`,
      `📃 Pages: ${pages.length}`,
      '',
      '│ Manhwa PDF Download',
      '',
      `│ ${CONFIG.FOOTER}`,
    ].join('\n');
  }
  try {
    // never quote a message from another chat; PDF_ONLY = bare file, no quote either
    await conn.sendMessage(job.dest, content, job.other || CONFIG.PDF_ONLY ? undefined : { quoted });
  } catch (e) {
    e.sendFail = true; // delivery problem (not a download/PDF problem)
    throw e;
  }
}

async function sendChapters(conn, session, picks, replyMsg, job) {
  const { from, title, chapters } = session;
  const { other, destName, tag } = job;
  const batch = picks.length > 1;
  const done = new Set();
  let sendFails = 0;
  let aborted = '';

  const quiet = CONFIG.PDF_ONLY;
  await react(conn, replyMsg, '⏳');
  if (!quiet && (batch || other)) {
    const info = [`📥 Sending *${picks.length}* chapter${batch ? 's' : ''} of *${title}*`];
    if (other) info.push(`📤 To: *${destName}*`);
    if (tag) info.push(`🏷️ File name prefix: (${tag})`);
    if (job.warn) info.push(job.warn);
    if (batch) info.push('↩️ Reply *stop* to the chapter list to cancel.');
    await say(conn, from, info.join('\n'), replyMsg);
  } else if (quiet && other) {
    // PDF_ONLY: one short line in THIS chat (not in the target group) so you can see where the files go
    const info = [`📤 ${picks.length} chapter${batch ? 's' : ''} → *${destName}*`];
    if (job.warn) info.push(job.warn);
    await say(conn, from, info.join('\n'), replyMsg);
  }

  for (let i = 0; i < picks.length; i++) {
    if (session.cancel) break;
    const idx = picks[i];
    try {
      await sendOne(conn, session, idx, job, replyMsg);
      done.add(idx);
      sendFails = 0;
    } catch (e) {
      console.error(`[manhwa] ${title} / ${chapters[idx - 1].title}:`, e.message);
      sendFails = e.sendFail ? sendFails + 1 : 0;
      if (!batch) await say(conn, from, `❌ *${chapters[idx - 1].title}* failed\n${e.message}`, replyMsg);
      if (sendFails >= 2) { aborted = e.message; break; } // target is clearly not receiving – stop wasting time
    }
    if (batch && i < picks.length - 1 && !session.cancel) await sleep(CONFIG.DELAY_MS);
  }

  const missing = picks.filter((i) => !done.has(i));
  await react(conn, replyMsg, aborted || session.cancel ? '🛑' : missing.length ? '⚠️' : '✅');
  if (batch && (!quiet || missing.length || aborted || session.cancel)) {
    const to = other ? ` to *${destName}*` : '';
    const lines = [aborted
      ? `🛑 Aborted — sending${to || ' here'} keeps failing:\n${aborted}`
      : `${session.cancel ? '🛑 Stopped' : '✅ Done'} — sent *${done.size}/${picks.length}* chapters${to}.`];
    if (missing.length) {
      const retryText = [ranges(missing), other ? job.dest : '', tag ? `(${tag})` : ''].filter(Boolean).join(' ');
      lines.push(`⚠️ Not sent: ${ranges(missing)}`, `↩️ Retry: reply *${retryText}*`);
    }
    await say(conn, from, lines.join('\n'), replyMsg);
  }
}

/* ───────────────────────── REPLY HANDLER ───────────────────────── */
async function onReply(conn, msg) {
  if (!msg || !msg.key || !msg.message) return;
  const m = unwrap(msg.message);
  const ctx = m && m.extendedTextMessage && m.extendedTextMessage.contextInfo;
  const key = ctx && ctx.stanzaId;
  const session = key && sessions.get(key);
  if (!session) return;                                   // not a reply to one of our lists
  if (!once(msg.key.id)) return;                          // duplicate delivery
  if (session.expires < Date.now()) { sessions.delete(key); return; }

  const who = jidNum(msg.key.participant || msg.key.remoteJid);
  if (CONFIG.ONLY_REQUESTER && who !== session.sender) return;

  const from = msg.key.remoteJid;
  const raw = (m.extendedTextMessage.text || '').trim();
  const text = raw.toLowerCase();
  touch(session);

  if (text === '0' || text === 'close') {
    session.cancel = true;
    sessions.delete(key);
    return react(conn, msg, '✅');
  }

  /* ── step 1: user picked a manhwa from the search list ── */
  if (session.type === 'search') {
    const n = /^\d+$/.test(text) ? parseInt(text, 10) : 0;
    if (n < 1 || n > session.results.length) {
      return say(conn, from, `❌ Reply with a number between *1* and *${session.results.length}* (0 = close).`, msg);
    }
    const item = session.results[n - 1];
    const chapters = (item.chapters || []).filter((c) => c && c.url);
    if (!chapters.length) return say(conn, from, `❌ No chapters found for *${item.title}*.`, msg);

    const sent = await sendCard(conn, from, chaptersCard(item.title, chapters), msg);
    prune();
    sessions.set(sent.key.id, touch({
      type: 'chapters', title: item.title, chapters, from,
      sender: session.sender, canTarget: session.canTarget, busy: false, cancel: false,
    }));
    return;
  }

  /* ── step 2: user picked chapter(s) from the chapter list ── */
  if (text === 'stop' || text === 'cancel') {
    if (!session.busy) return;
    session.cancel = true;
    return say(conn, from, '🛑 Stopping after the current chapter…', msg);
  }

  const { sel, target, tag } = parseReply(raw);
  const picks = parseSelection(sel, session.chapters.length);
  if (!picks) {
    return say(conn, from,
      `❌ Invalid. Reply with a chapter number (1-${session.chapters.length}), *all*, a range like *1-10*, or a list like *3,5,8* ` +
      '— optionally plus a group JID (…@g.us) and/or a *(TAG)* file name prefix.', msg);
  }
  if (session.busy) return say(conn, from, '⏳ Still sending… reply *stop* to cancel.', msg);

  const dest = target || from;
  const other = dest !== from;
  if (other) {
    if (!session.canTarget) {
      console.log('[manhwa] blocked: isOwner=false (set TARGET_OWNER_ONLY:false in manhwa.js to allow everyone)');
      return say(conn, from, '❌ Only the bot owner can send to another group.', msg);
    }
    if (who !== session.sender) {
      return say(conn, from, '❌ Only the person who ran this command can send to another group.', msg);
    }
  }

  session.busy = true;
  session.cancel = false;
  try {
    let destName = '';
    let warn = '';
    if (other) {
      let meta;
      try {
        meta = await conn.groupMetadata(dest);
      } catch (e) {
        return await say(conn, from, `❌ Can't reach that group — wrong JID, or the bot is not a member.\n(${e.message})`, msg);
      }
      destName = (meta && meta.subject) || dest;
      warn = adminWarning(conn, meta);
    }
    await sendChapters(conn, session, picks, msg, { dest, other, destName, tag, warn });
  } finally {
    session.busy = false;
  }
}

function ensureListener(conn) {
  if (hooked.has(conn)) return;
  hooked.add(conn);
  conn.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages || []) {
      onReply(conn, msg).catch((e) => console.error('[manhwa] reply error:', e));
    }
  });
}

/* ───────────────────────── COMMAND ───────────────────────── */
cmd({
  pattern: 'manhwa',
  react: '🔞',
  desc: 'Search manhwa and get chapters as PDF',
  category: 'download',
  filename: __filename,
  // [gf-integration] she must not hand this adult-content downloader to ordinary users, so it is NOT offered as one of her tools (owner / sudo type it);
  // and the number the owner replies with is for this plugin, not a chat message for her:
  gf: false,
  claimReplies: true,
}, async (conn, mek, m, { from, q, isOwner }) => {
  try {
    if (!PDFDocument) return await say(conn, from, '❌ The pdf-lib package is not installed.\n\nRun: *npm install*  (it is listed in package.json)', mek);
    const query = (q || '').trim();
    if (!query) return await say(conn, from, '❌ Give a name.\n\nExample: *.manhwa new*', mek);
    ensureListener(conn);

    const { data } = await retry(
      () => axios.get(CONFIG.API_SEARCH, { params: { text: query }, timeout: 30000 }), 2);
    const results = ((data && data.results) || []).filter((r) => r && r.title).slice(0, CONFIG.MAX_RESULTS);
    if (!results.length) return await say(conn, from, `❌ No results for *${query}*`, mek);

    const sent = await sendCard(conn, from, searchCard(query, results), mek);
    prune();
    sessions.set(sent.key.id, touch({
      type: 'search', results, from,
      sender: jidNum(mek.key.participant || mek.key.remoteJid),
      canTarget: !CONFIG.TARGET_OWNER_ONLY || isOwner == null || !!isOwner,
    }));
  } catch (e) {
    console.error('[manhwa]', e);
    await say(conn, from, `❌ ${e.message}`, mek);
  }
});
