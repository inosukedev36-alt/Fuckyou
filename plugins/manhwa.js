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
 *    CHAPTER_TRIES (default 5): a chapter that fails (API / page download / PDF / sending) is tried again – up to that many
 *      attempts in total, with a growing pause in between (CHAPTER_RETRY_MS).
 *    STOP_ON_FAIL (default true): when a chapter still fails after its last attempt, the WHOLE batch stops right there –
 *      nothing after it is sent – and the message tells you the "Retry: reply …" line to continue from that chapter.
 *
 *    GROUP_THUMBNAIL (default true): the PDF's preview picture is the destination group's profile photo.
 *      It is stored inside the WhatsApp message itself (jpegThumbnail), so forwarding keeps it.
 *    GROUP_NAME_PAGE (default true): every PDF gets a small last page – "Powered by" + the destination group's name –
 *      as wide as the manhwa pages. Wording = NAME_PAGE_LABEL, size = NAME_PAGE_SCALE.
 *      Latin names work out of the box (emoji / unsupported letters are skipped). For Sinhala etc. set FONT_PATH
 *      to a .ttf that contains those letters and run:  npm i @pdf-lib/fontkit regenerator-runtime
 *
 *  Install    npm i axios pdf-lib        (optional: sharp → .webp pages + sharper group-photo thumbnail)
 *  Location   <your-bot>/plugins/manhwa.js
 * ─────────────────────────────────────────────────────────────────
 */

const axios = require('axios');
// [gf-integration] pdf-lib is not installed yet in every project: load it softly so the bot still starts (run:  npm install)
let PDFDocument = null;
let StandardFonts = null;
let rgb = null;
try { ({ PDFDocument, StandardFonts, rgb } = require('pdf-lib')); } catch (_) { /* reported when the command is used */ }
const { cmd } = require('../command'); // ← if your bot exports `cmd` from somewhere else, change this line
const fs = require('fs');
const path = require('path');

let sharp = null;
try { sharp = require('sharp'); } catch (_) { /* optional */ }
let fontkit = null; // optional – only needed for FONT_PATH (npm i @pdf-lib/fontkit regenerator-runtime)
try { if (typeof regeneratorRuntime === 'undefined') global.regeneratorRuntime = require('regenerator-runtime'); } catch (_) { /* fontkit needs it */ }
try { fontkit = require('@pdf-lib/fontkit'); } catch (_) { /* optional */ }

/* ───────────────────────── CONFIG ───────────────────────── */
const CONFIG = {
  API_SEARCH: 'https://poddax-api.dev/manhwa-search',
  API_DL: 'https://poddax-api.dev/manhwa-dl',
  REFERER: 'https://manga18fx.com/',
  BANNER: '',              // image URL / local path for the list cards ('' = text only)
  FOOTER: 'SHIRO-MD',
  MAX_RESULTS: 10,         // how many search results to list
  SESSION_MIN: 30,         // minutes a list stays "replyable"
  DELAY_MS: 4000,          // pause between chapters in batch mode (helps avoid WhatsApp spam limits)
  CHAPTER_TRIES: 5,        // attempts per chapter (API → page downloads → PDF → sending) before it counts as failed
  CHAPTER_RETRY_MS: 3000,  // pause before the next attempt; it grows every time (3 s, 6 s, 9 s, 12 s)
  STOP_ON_FAIL: true,      // true = a chapter that still fails after all its attempts stops the WHOLE batch right there; false = skip it and go on
  IMG_CONCURRENCY: 5,      // parallel page downloads
  ONLY_REQUESTER: true,   // true = only the person who ran .manhwa can reply to the lists
  TARGET_OWNER_ONLY: true, // true = sending to ANOTHER group needs isOwner (if your bot provides it)
  PDF_ONLY: true,          // true = send ONLY the renamed PDFs (no caption / quote / status chatter); false = SS-style captions
  GROUP_THUMBNAIL: true,   // PDF preview picture = the destination group's profile photo (kept when the message is forwarded)
  GROUP_NAME_PAGE: true,   // add a small last page ("Powered by" + the destination group's name) to every PDF
  NAME_PAGE_LABEL: 'Powered by', // the small text above the group name on that page ('' = no label)
  NAME_PAGE_SCALE: 1,      // size of that page and its text: 0.7 = even smaller, 1.3 = bigger
  FONT_PATH: '',           // optional .ttf/.otf for group names in Sinhala/other scripts (abs path, or relative to this file) – also needs: npm i @pdf-lib/fontkit regenerator-runtime
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
  // a missing package is not fixed by trying again – skip the retries for this one
  if (!sharp) throw Object.assign(new Error('page is webp/other format → run: npm i sharp'), { noRetry: true });
  const jpg = await sharp(buf).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
  return pdf.embedJpg(jpg);
}

/* ───────────────────────── GROUP BRANDING ───────────────────────── */
// 1) The destination group's profile photo becomes the PDF's preview picture. It is sent as the message's own
//    jpegThumbnail, so it lives inside the message – forwarding the PDF keeps the very same picture.
// 2) A last page carrying the destination group's name is added to the PDF.
const isGroup = (jid) => String(jid || '').endsWith('@g.us');
const THUMB_PX = 256;
const THUMB_MAX = 30 * 1024;

async function groupThumb(conn, jid) {
  try {
    // with sharp we resize the full photo ourselves; without it we take WhatsApp's own small preview JPEG
    const url = await Promise.race([conn.profilePictureUrl(jid, sharp ? 'image' : 'preview'), sleep(15000).then(() => null)]);
    if (!url) return null;
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    const src = Buffer.from(res.data);
    if (!sharp) return src[0] === 0xff && src[1] === 0xd8 && src.length <= 60 * 1024 ? src : null;
    let out = null;
    for (const px of [THUMB_PX, 160]) { // keep the preview small: lower quality first, then fewer pixels
      for (const q of [72, 55, 40]) {
        out = await sharp(src).resize(px, px, { fit: 'cover' }).jpeg({ quality: q }).toBuffer();
        if (out.length <= THUMB_MAX) return out;
      }
    }
    return out;
  } catch (_) {
    return null; // no photo / hidden by privacy / network problem → just send without a thumbnail
  }
}

// small-caps letters (ᴍᴀɴʜᴡᴀ) are very common in group names but have no NFKC mapping
const SMALL_CAPS = {
  'ᴀ': 'A', 'ʙ': 'B', 'ᴄ': 'C', 'ᴅ': 'D', 'ᴇ': 'E', 'ꜰ': 'F', 'ɢ': 'G', 'ʜ': 'H', 'ɪ': 'I', 'ᴊ': 'J', 'ᴋ': 'K', 'ʟ': 'L', 'ᴍ': 'M',
  'ɴ': 'N', 'ᴏ': 'O', 'ᴘ': 'P', 'ǫ': 'Q', 'ʀ': 'R', 'ꜱ': 'S', 'ᴛ': 'T', 'ᴜ': 'U', 'ᴠ': 'V', 'ᴡ': 'W', 'ʏ': 'Y', 'ᴢ': 'Z',
};
const SMALL_CAPS_RE = new RegExp(`[${Object.keys(SMALL_CAPS).join('')}]`, 'g');

// fancy → plain letters (𝐒𝐋𝐏𝐋, ＳＬＰＬ, Ⓢ, ᴍᴀɴʜᴡᴀ …), then drop what no available font can draw (emoji etc.)
function cleanName(name, canDraw) {
  const norm = Array.from(String(name || '').normalize('NFKC').replace(SMALL_CAPS_RE, (c) => SMALL_CAPS[c]).replace(/\s+/g, ' '));
  const kept = norm.filter((ch) => canDraw(ch.codePointAt(0)));
  return { text: kept.join('').replace(/\s+/g, ' ').trim().slice(0, 100), dropped: norm.length - kept.length };
}

// fonts usable for the name page: Helvetica-Bold, plus your own .ttf (FONT_PATH) for other scripts
let customFont; // undefined = not tried yet, null = unusable
function loadCustomFont() {
  if (customFont !== undefined) return customFont;
  customFont = null;
  if (!CONFIG.FONT_PATH) return null;
  if (!fontkit) {
    console.error('[manhwa] FONT_PATH is set but @pdf-lib/fontkit is missing → run: npm i @pdf-lib/fontkit regenerator-runtime');
    return null;
  }
  try {
    const file = path.isAbsolute(CONFIG.FONT_PATH) ? CONFIG.FONT_PATH : path.join(__dirname, CONFIG.FONT_PATH);
    const fk = fontkit.create(fs.readFileSync(file));
    fk.layout('a'); // fails right here (with a clear hint) if fontkit can't run on this machine
    customFont = { fk, has: new Set(fk.characterSet) };
  } catch (e) {
    console.error('[manhwa] FONT_PATH not usable:', e.message, /regenerator/.test(e.message) ? '→ run: npm i regenerator-runtime' : '');
  }
  return customFont;
}

async function nameFonts(pdf) {
  const latin = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fonts = [{ std: latin, has: new Set(latin.getCharacterSet()) }];
  const custom = loadCustomFont();
  if (custom) fonts.push(custom);
  return fonts;
}

// split a line into runs, each drawn with the first font that has the character (Latin → Helvetica, rest → your font)
function runsOf(text, fonts) {
  const runs = [];
  for (const ch of text) {
    const f = fonts.find((x) => x.has.has(ch.codePointAt(0)));
    if (!f) continue;
    const last = runs[runs.length - 1];
    if (last && last.f === f) last.text += ch; else runs.push({ f, text: ch });
  }
  return runs;
}
const runWidth = (r, size) => (r.f.std
  ? r.f.std.widthOfTextAtSize(r.text, size)
  : (r.f.fk.layout(r.text).positions.reduce((w, p) => w + p.xAdvance, 0) * size) / r.f.fk.unitsPerEm);
const runsWidth = (runs, size) => runs.reduce((w, r) => w + runWidth(r, size), 0);

// Helvetica runs are normal PDF text. Runs in your own font are drawn glyph by glyph as outlines, using the shaper's
// positions – that keeps Sinhala vowel signs & conjuncts exactly where they belong (pdf-lib's drawText ignores those).
function drawRun(page, r, x, y, size, color) {
  if (r.f.std) { page.drawText(r.text, { x, y, size, font: r.f.std, color }); return; }
  const { fk } = r.f;
  const scale = size / fk.unitsPerEm;
  const run = fk.layout(r.text);
  let pen = 0;
  run.glyphs.forEach((g, i) => {
    const pos = run.positions[i];
    const d = g.path.transform(1, 0, 0, -1, 0, 0).toSVG(); // font outlines are y-up, drawSvgPath is y-down
    if (d) page.drawSvgPath(d, { x: x + (pen + pos.xOffset) * scale, y: y + pos.yOffset * scale, scale, color });
    pen += pos.xAdvance;
  });
}

// the name is drawn as large as fits: ≤ 2 lines at 40…22 pt, else ≤ 3 lines at 20…18 pt, else one shrunk line with "…"
const NAME_TIERS = [{ sizes: [40, 34, 30, 26, 22], lines: 2 }, { sizes: [20, 18], lines: 3 }];
function fitText(text, fonts, maxW, unit = 1) {
  const widthOf = (s, size) => runsWidth(runsOf(s, fonts), size);
  for (const { sizes, lines: maxLines } of NAME_TIERS) {
    for (const base of sizes) {
      const size = base * unit;
      const lines = [];
      let cur = '';
      let fits = true;
      for (const word of text.split(' ')) {
        const next = cur ? `${cur} ${word}` : word;
        if (widthOf(next, size) <= maxW) { cur = next; continue; }
        if (cur) lines.push(cur);
        cur = word;
        if (widthOf(cur, size) > maxW) { fits = false; break; }
      }
      if (fits) {
        if (cur) lines.push(cur);
        if (lines.length <= maxLines) return { size, lines };
      }
    }
  }
  const size = 18 * unit;
  const chars = Array.from(text);
  while (chars.length > 1 && widthOf(`${chars.join('')}…`, size) > maxW) chars.pop();
  return { size, lines: [`${chars.join('')}…`] };
}

// the width most manhwa pages have – the name page copies it, so it lines up in any PDF viewer
function commonWidth(pdf) {
  const count = new Map();
  for (const pg of pdf.getPages()) {
    const w = Math.round(pg.getWidth());
    count.set(w, (count.get(w) || 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

// a small "credits strip" as the last page:   ▔▔▔▔▔  Powered by  /  Group Name
async function addNamePage(pdf, text) {
  const fonts = await nameFonts(pdf);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const labelFonts = [{ std: regular, has: fonts[0].has }, ...fonts.slice(1)];
  const label = CONFIG.NAME_PAGE_LABEL
    ? cleanName(CONFIG.NAME_PAGE_LABEL, (cp) => labelFonts.some((f) => f.has.has(cp))).text
    : '';

  const w = Math.max(360, commonWidth(pdf)); // same width as the manhwa pages
  const u = (w / 760) * Math.min(2, Math.max(0.4, Number(CONFIG.NAME_PAGE_SCALE) || 1)); // sizes below are for a 760-wide page
  const { size, lines } = fitText(text, fonts, w * 0.82, u); // lay the text out first – nothing is added if this fails
  const strip = 5 * u;
  const pad = 24 * u;
  const labelSize = 19 * u;
  const labelH = label ? labelSize * 1.2 + 6 * u : 0;
  const lineH = size * 1.2;
  const h = Math.round(strip + pad + labelH + lineH * lines.length + pad);

  const page = pdf.addPage([w, h]);
  page.drawRectangle({ x: 0, y: 0, width: w, height: h, color: rgb(0.06, 0.06, 0.09) });
  page.drawRectangle({ x: 0, y: h - strip, width: w, height: strip, color: rgb(0.55, 0.36, 0.96) });
  const centered = (line, fontList, sz, baseline, color) => {
    const runs = runsOf(line, fontList);
    let x = (w - runsWidth(runs, sz)) / 2;
    for (const r of runs) {
      drawRun(page, r, x, baseline, sz, color);
      x += runWidth(r, sz);
    }
  };
  let top = h - strip - pad;
  if (label) {
    centered(label, labelFonts, labelSize, top - labelSize, rgb(0.62, 0.65, 0.72));
    top -= labelH;
  }
  lines.forEach((line, i) => centered(line, fonts, size, top - size - i * lineH, rgb(1, 1, 1)));
}

// everything the destination group adds to a job: preview picture, name-page text, and notes about what was skipped
async function prepareBranding(conn, dest, meta) {
  const brand = { thumb: null, endText: '', notes: [] };
  if (!isGroup(dest)) return brand;
  try {
    if (CONFIG.GROUP_THUMBNAIL) {
      brand.thumb = await groupThumb(conn, dest);
      if (!brand.thumb) brand.notes.push('🖼️ No group photo found — sending without a thumbnail.');
    }
    if (CONFIG.GROUP_NAME_PAGE && meta && meta.subject) {
      try {
        const tmp = await PDFDocument.create();
        const fonts = await nameFonts(tmp);
        const { text, dropped } = cleanName(meta.subject, (cp) => fonts.some((f) => f.has.has(cp)));
        if (text) fitText(text, fonts, 600); // dry run: a font / shaping problem shows up here, once – not in every chapter
        brand.endText = text;
        if (!text) brand.notes.push('📄 The group name has no letters the PDF font can draw — name page skipped (see FONT_PATH).');
        else if (dropped) brand.notes.push(`📄 Name page prints *${text}* (emoji / unsupported letters skipped).`);
      } catch (e) {
        brand.endText = '';
        brand.notes.push('📄 Name page skipped — the PDF font could not draw the group name (see the bot console).');
        console.error('[manhwa] name page skipped:', e.message, /regenerator/.test(e.message) ? '→ run: npm i regenerator-runtime' : '');
      }
    }
  } catch (e) {
    console.error('[manhwa] group branding skipped:', e.message);
  }
  return brand;
}

async function buildPdf(urls, endText) {
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
  if (endText) {
    const n = pdf.getPageCount();
    try {
      await addNamePage(pdf, endText);
    } catch (e) {
      while (pdf.getPageCount() > n) pdf.removePage(pdf.getPageCount() - 1); // never leave a half-drawn page behind
      console.error('[manhwa] name page skipped:', e.message, /regenerator/.test(e.message) ? '→ run: npm i regenerator-runtime' : '');
    }
  }
  return Buffer.from(await pdf.save());
}

/* ───────────────────────── SENDING CHAPTERS ───────────────────────── */
// job = { dest, other, destName, tag, warn, thumb, endText, notes }   dest = where the PDFs go, other = dest is not this chat
// ONE attempt at a chapter: get it (API → page images → PDF), then send it.
// `keep.built` holds the finished PDF between attempts, so when only the sending failed the chapter is not downloaded again.
async function attemptChapter(conn, session, idx, job, quoted, keep) {
  const ch = session.chapters[idx - 1];
  if (!keep.built) {
    const { data } = await retry(
      () => axios.get(CONFIG.API_DL, { params: { url: ch.url }, timeout: 60000 }), 2);

    const pages = data && data.DownloadUrl;
    if (!data || !data.status || !Array.isArray(pages) || !pages.length) throw new Error('API returned no pages');

    keep.built = { pdf: await buildPdf(pages, job.endText), pageCount: pages.length };
  }
  const { pdf, pageCount } = keep.built;
  const fileName = `${job.tag ? `(${job.tag})` : ''}${safeName(`${session.title} - ${ch.title}`)}.pdf`;
  const content = { document: pdf, mimetype: 'application/pdf', fileName };
  if (job.thumb) content.jpegThumbnail = job.thumb; // group photo – part of the message itself, so forwards keep it
  if (!CONFIG.PDF_ONLY) {
    content.caption = [
      `🔞 *${session.title}*`,
      `📄 Chapter: ${ch.title}`,
      `📃 Pages: ${pageCount}`,
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

// Gets + sends one chapter. A failed attempt (API, page download, PDF, delivery) is repeated, up to CONFIG.CHAPTER_TRIES
// attempts in total. Only when the LAST attempt fails does the error reach sendChapters (e.attempts = how many were made).
async function sendOne(conn, session, idx, job, quoted) {
  const ch = session.chapters[idx - 1];
  const tries = Math.max(1, Math.floor(Number(CONFIG.CHAPTER_TRIES)) || 1);
  const keep = { built: null };
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptChapter(conn, session, idx, job, quoted, keep);
    } catch (e) {
      e.attempts = attempt;
      if (attempt >= tries || e.noRetry || session.cancel) throw e; // out of attempts (or pointless / cancelled) → sendChapters reports it
      console.error(`[manhwa] ${session.title} / ${ch.title} – attempt ${attempt}/${tries} failed (${e.message}) → trying again`);
      await sleep((Number(CONFIG.CHAPTER_RETRY_MS) || 0) * attempt);
      if (session.cancel) throw e; // "stop" arrived while waiting
    }
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
  for (const n of job.notes || []) console.log('[manhwa]', n.replace(/\*/g, ''));
  await react(conn, replyMsg, '⏳');
  if (!quiet && (batch || other)) {
    const info = [`📥 Sending *${picks.length}* chapter${batch ? 's' : ''} of *${title}*`];
    if (other) info.push(`📤 To: *${destName}*`);
    if (tag) info.push(`🏷️ File name prefix: (${tag})`);
    if (job.warn) info.push(job.warn);
    info.push(...(job.notes || []));
    if (batch) info.push('↩️ Reply *stop* to the chapter list to cancel.');
    await say(conn, from, info.join('\n'), replyMsg);
  } else if (quiet && other) {
    // PDF_ONLY: one short line in THIS chat (not in the target group) so you can see where the files go
    const info = [`📤 ${picks.length} chapter${batch ? 's' : ''} → *${destName}*`];
    if (job.warn) info.push(job.warn);
    info.push(...(job.notes || []));
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
      const name = chapters[idx - 1].title;
      console.error(`[manhwa] ${title} / ${name}:`, e.message);
      sendFails = e.sendFail ? sendFails + 1 : 0;
      const after = e.attempts > 1 ? ` after ${e.attempts} attempts` : '';
      if (!batch) await say(conn, from, `❌ *${name}* failed${after}\n${e.message}`, replyMsg);
      // every attempt at this chapter failed → stop the whole batch right here, so nothing after it gets sent.
      // (with STOP_ON_FAIL off, the old rule remains: 2 failed deliveries in a row = the target is clearly not receiving)
      if (batch && !session.cancel && (CONFIG.STOP_ON_FAIL || sendFails >= 2)) {
        aborted = `*${name}* could not be ${e.sendFail ? 'sent' : 'fetched'}${after}:\n${e.message}`;
        break;
      }
    }
    if (batch && i < picks.length - 1 && !session.cancel) await sleep(CONFIG.DELAY_MS);
  }

  const missing = picks.filter((i) => !done.has(i));
  await react(conn, replyMsg, aborted || session.cancel ? '🛑' : missing.length ? '⚠️' : '✅');
  if (batch && (!quiet || missing.length || aborted || session.cancel)) {
    const to = other ? ` to *${destName}*` : '';
    const head = aborted ? '🛑 Aborted' : session.cancel ? '🛑 Stopped' : '✅ Done';
    const lines = [`${head} — sent *${done.size}/${picks.length}* chapters${to}.`];
    if (aborted) lines.push(`❌ ${aborted}`);
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
    let meta = null;
    if (other || (isGroup(dest) && (CONFIG.GROUP_THUMBNAIL || CONFIG.GROUP_NAME_PAGE))) {
      try {
        meta = await conn.groupMetadata(dest);
      } catch (e) {
        // another group we can't reach → stop here; this chat → just go on without the group name
        if (other) return await say(conn, from, `❌ Can't reach that group — wrong JID, or the bot is not a member.\n(${e.message})`, msg);
      }
    }
    if (other) {
      destName = (meta && meta.subject) || dest;
      warn = adminWarning(conn, meta);
    }
    const brand = await prepareBranding(conn, dest, meta);
    await sendChapters(conn, session, picks, msg, { dest, other, destName, tag, warn, ...brand });
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
  gf: true,
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
