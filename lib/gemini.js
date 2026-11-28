import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_TTL_MS = Number(process.env.GEMINI_TOKEN_TTL_MS) || 20 * 60_000;      // how long the page tokens are reused
const PAGE_TIMEOUT_MS = Number(process.env.GEMINI_PAGE_TIMEOUT_MS) || 20_000;
const GENERATE_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 45_000;

const MIME_MAP = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  tiff: 'image/tiff',
  mp3: 'audio/mp3',
  wav: 'audio/wav',
  m4a: 'audio/m4a',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  md: 'text/markdown',
  html: 'text/html',
  xml: 'application/xml',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  py: 'text/x-python',
  js: 'application/javascript',
  mjs: 'application/javascript',
  ts: 'text/plain',
  java: 'text/plain',
  c: 'text/plain',
  cpp: 'text/plain',
  sh: 'text/plain'
};

/**
 * Every failure carries a `code`, so a caller can tell "the cookies are dead" from "Google was slow":
 *   NO_COOKIES · AUTH (cookies invalid / expired) · RATE_LIMIT · TIMEOUT · NETWORK · HTTP · BAD_INPUT
 */
export class GeminiError extends Error {
  constructor(message, code = 'ERROR', extra = {}) {
    super(message);
    this.name = 'GeminiError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// ───────────────────────────── one HTTPS request, without fetch ─────────────────────────────
// Node's fetch (undici) stops at 16 KB of response headers → UND_ERR_HEADERS_OVERFLOW. Google's answers (CSP, Set-Cookie …) can be
// bigger, so every Gemini request goes through https.request with a big header limit instead (nothing to install, no node flags).
const MAX_HEADER_BYTES = Number(process.env.GEMINI_MAX_HEADER_BYTES) || 256 * 1024;

/** the low-level code of a foreign error, wherever it hides: err.code or err.cause.code (undici: "fetch failed" → UND_ERR_…, ECONNRESET …) */
function sysCode(e) {
  for (let x = e, i = 0; x && i < 5; x = x.cause, i++) {
    if (typeof x.code === 'string' && x.code) return x.code;
  }
  return '';
}

/** any error → a GeminiError that keeps the low-level code in `.sys` (shown by /gcch) */
function netError(e, what = 'Network error') {
  if (e instanceof GeminiError) return e;
  const sys = sysCode(e);
  if (sys === 'ERR_INVALID_CHAR' || sys === 'ERR_HTTP_INVALID_HEADER_VALUE') {
    return new GeminiError('The cookies contain a character that cannot be sent in an HTTP header (check lib/Geminicook.txt)', 'BAD_INPUT', { sys });
  }
  return new GeminiError(`${what}: ${(e && e.cause && e.cause.message) || (e && e.message) || e}`, 'NETWORK', { sys });
}

/** → { status, headers, text }  ·  rejects with a GeminiError: TIMEOUT / NETWORK / BAD_INPUT */
function httpsRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let finished = false;
    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fn(value);
    };
    let req;
    try {
      req = https.request(url, {
        method,
        headers: body == null ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) },
        maxHeaderSize: MAX_HEADER_BYTES
      }, (res) => {
        res.setEncoding('utf8');
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => finish(resolve, { status: res.statusCode, headers: res.headers, text }));
        res.on('error', (e) => finish(reject, netError(e)));
        res.on('close', () => {
          if (!res.complete) finish(reject, netError(Object.assign(new Error('Connection closed before the response was complete'), { code: 'ECONNRESET' })));
        });
      });
    } catch (e) {
      return finish(reject, netError(e));
    }
    timer = setTimeout(() => {
      finish(reject, new GeminiError(`Gemini did not answer within ${Math.round(timeoutMs / 1000)}s`, 'TIMEOUT'));
      req.destroy();
    }, timeoutMs);
    req.on('error', (e) => finish(reject, netError(e)));
    if (body != null) req.write(body);
    req.end();
  });
}

// ───────────────────────────── cookies ─────────────────────────────

function joinCookies(pairs) {
  const seen = new Set();
  const out = [];
  for (const [name, value] of pairs) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(`${name}=${value}`);
  }
  return out.join('; ');
}

/**
 * Turns whatever you pasted into ONE "name=value; name=value" Cookie header. Accepted:
 *   • a Cookie header   "SID=…; HSID=…"   (may be wrapped, start with "Cookie:" or end with a newline)
 *   • Netscape cookies.txt (tab-separated, "#HttpOnly_" lines included)
 *   • a JSON export     [{ "name": "SID", "value": "…" }, …]
 */
export function parseCookies(input) {
  if (!input) return '';
  const text = String(input).replace(/^\uFEFF/, '').trim();
  if (!text) return '';

  if (text[0] === '[' || text[0] === '{') {
    try {
      const json = JSON.parse(text);
      const list = Array.isArray(json) ? json : (json && Array.isArray(json.cookies) ? json.cookies : null);
      if (list) return joinCookies(list.filter((c) => c && c.name).map((c) => [String(c.name), String(c.value ?? '')]));
    } catch { /* not JSON → try the text formats */ }
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Netscape: domain  flag  path  secure  expiry  name  value
  const netscape = [];
  for (const raw of lines) {
    if (raw.startsWith('#') && !raw.startsWith('#HttpOnly_')) continue;
    const line = raw.startsWith('#HttpOnly_') ? raw.slice(10) : raw;
    let cols = line.split('\t');
    if (cols.length < 7) {                       // some tools save the same columns separated by spaces
      const sp = line.split(/\s+/);
      if (sp.length >= 7 && /^(TRUE|FALSE)$/i.test(sp[1]) && /^(TRUE|FALSE)$/i.test(sp[3])) cols = sp;
    }
    if (cols.length >= 7) netscape.push([cols[5].trim(), cols.slice(6).join('\t').trim()]);
  }
  if (netscape.length) return joinCookies(netscape);

  // Cookie header (the old code mistook a header that ended with "\n" for a Netscape file and dropped its first 5 cookies)
  const pairs = lines.join(' ').replace(/^cookie\s*:\s*/i, '').split(';')
    .map((s) => s.trim())
    .filter((s) => s.includes('='))
    .map((s) => {
      const i = s.indexOf('=');
      return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
    });
  return joinCookies(pairs);
}

/**
 * Where the cookies come from:
 *   1) cookies the owner pasted from WhatsApp (/gcset, kept in the cookie store = MongoDB) — only while they are NEWER than the file below
 *   2) env GEMINI_COOKIES → env GEMINI_COOKIE_FILE → /mnt/cloud-storage/Scraper/Geminicook.txt → lib/Geminicook.txt  (first hit wins)
 * locateCookies() → { source, cookies, base, at }  (source = "env GEMINI_COOKIES", the file path or "WhatsApp /gcset (MongoDB)"; '' when there are none)
 */
const PROCESS_START = Date.now();

async function readFileBase(filePath) {
  if (!filePath && process.env.GEMINI_COOKIES) {
    const fromEnv = parseCookies(process.env.GEMINI_COOKIES);
    if (fromEnv) return { source: 'env GEMINI_COOKIES', cookies: fromEnv, mtimeMs: PROCESS_START };
  }
  const candidates = [];
  if (filePath) {
    candidates.push(filePath);
  } else {
    if (process.env.GEMINI_COOKIE_FILE) candidates.push(process.env.GEMINI_COOKIE_FILE);
    candidates.push('/mnt/cloud-storage/Scraper/Geminicook.txt');
  }
  candidates.push(path.join(HERE, 'Geminicook.txt'));
  for (const p of candidates) {
    try {
      const cookies = parseCookies(await fs.readFile(p, 'utf8'));
      if (cookies) {
        let mtimeMs = 0;
        try { mtimeMs = (await fs.stat(p)).mtimeMs; } catch { /* no file date */ }
        return { source: String(p), cookies, mtimeMs };
      }
    } catch { /* try the next place */ }
  }
  return { source: '', cookies: '', mtimeMs: 0 };
}

async function readBase(filePath) {
  const file = await readFileBase(filePath);
  if (filePath) return file;                                 // an explicit path means exactly that file
  const pasted = await currentOverride();
  if (pasted && pasted.cookies && (!file.cookies || pasted.at > file.mtimeMs)) {
    return { source: 'WhatsApp /gcset (MongoDB)', cookies: pasted.cookies, mtimeMs: pasted.at };
  }
  return file;
}

/** → { source, cookies, base, at }: cookies = what is sent to Google (your cookies + the fresher values of the keep-alive below), base = your cookies alone */
export async function locateCookies(filePath) {
  const found = await readBase(filePath);
  if (!found.cookies) return { source: '', cookies: '', base: '', at: 0 };
  const cookies = filePath ? found.cookies : await withRotated(found.cookies);
  return { source: found.source, cookies, base: found.cookies, at: found.mtimeMs || 0 };
}

export async function loadCookiesFromFile(filePath) {
  return (await locateCookies(filePath)).cookies;
}

// ───────────────────────────── a place that survives restarts ─────────────────────────────
// Many hosts forget every file the bot wrote when it restarts or is redeployed — and a rotated cookie that is forgotten is a dead cookie,
// because Google stops accepting the old one. So the bot hands this module a small key-value store (MongoDB, see lib/gf/ai.js):
//   get(key) → value | null (nothing saved) | undefined (not ready yet) · set(key, value) → true · del(key)
// keys: "overlay" = the rotated cookies (below) · "override" = cookies pasted from WhatsApp with /gcset
let cookieStore = null;
let storeWaited = false;
let override = null;           // { cookies, at }
let overrideLoaded = false;
let overlay = null;            // { base: sha1(your cookies), values: { '__Secure-1PSIDTS': '…' }, at }
let overlayLoaded = false;
let onAuthLost = null;

export function setCookieStore(store) {
  cookieStore = store;
  overrideLoaded = false;
  overlayLoaded = false;
  storeWaited = false;
}
/** called when Google stops accepting the cookies (the bot tells the owner) */
export function setAuthLostHandler(fn) {
  onAuthLost = fn;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function storeGet(key) {
  if (!cookieStore) return undefined;
  try { return await cookieStore.get(key); } catch { return undefined; }
}
async function storeSet(key, value) {
  if (!cookieStore) return false;
  try { return !!(await cookieStore.set(key, value)); } catch { return false; }
}
async function storeDel(key) {
  if (!cookieStore) return;
  try { await cookieStore.del(key); } catch { /* nothing to delete */ }
}
/** the first read after a start waits a few seconds at most for the store: MongoDB may still be connecting */
async function storeRead(key) {
  let v = await storeGet(key);
  if (v === undefined && cookieStore && !storeWaited) {
    storeWaited = true;
    for (let i = 0; i < 25 && v === undefined; i++) {
      await sleep(300);
      v = await storeGet(key);
    }
  }
  return v;
}

/** is there a store that survives restarts, and can it be reached right now? (for /gcch) */
export async function storeReady() {
  if (!cookieStore) return false;
  return (await storeGet('__ping')) !== undefined;
}

async function currentOverride() {
  if (overrideLoaded) return override;
  const saved = await storeRead('override');
  if (saved === undefined) return override;                  // store not ready: ask again next time
  override = saved && saved.cookies ? saved : null;
  overrideLoaded = true;
  return override;
}

// ───────────────────────────── keeping the cookies alive ─────────────────────────────
// Google's session cookie __Secure-1PSIDTS goes stale after a few hours unless somebody "rotates" it. A browser does that by itself, a bot
// has to do it too (the open-source gemini-webapi library does the same): POST accounts.google.com/RotateCookies every few minutes and
// keep the new values — in the store above (and in data/gemini-cookie-cache.json). Your own cookies are never touched; the fresher values are
// used only while your cookies are unchanged (paste new ones and they win again).  GEMINI_ROTATE=off switches the rotation off.
const ROTATE_EVERY_MS = (Number(process.env.GEMINI_ROTATE_MINUTES) || 9) * 60_000;
const FIRST_ROTATE_MS = 10_000;
const ROTATE_FILE = path.join(HERE, '..', 'data', 'gemini-cookie-cache.json');
const ROTATING_COOKIES = /^(__Secure-[13]PSID(?:TS|RTS|CC)|SIDCC)$/;
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

const rotation = {
  enabled: !/^(off|false|0|no)$/i.test(process.env.GEMINI_ROTATE || ''),
  timer: null, busy: false, count: 0, lastOk: 0, lastTry: 0, lastNames: [], stored: false, error: null
};

function overlayString(cookies, values) {
  const used = new Set();
  const parts = cookies.split('; ').map((pair) => {
    const i = pair.indexOf('=');
    const name = i > 0 ? pair.slice(0, i) : pair;
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      used.add(name);
      return `${name}=${values[name]}`;
    }
    return pair;
  });
  for (const [name, value] of Object.entries(values)) {
    if (!used.has(name)) parts.push(`${name}=${value}`);
  }
  return parts.join('; ');
}

async function loadOverlay() {
  if (overlayLoaded) return;
  if (cookieStore) {
    const saved = await storeRead('overlay');
    if (saved === undefined) return;                         // store not ready: ask again next time (nothing is applied meanwhile)
    if (saved) {
      overlay = saved;
      overlayLoaded = true;
      return;
    }
  }
  try { overlay = JSON.parse(await fs.readFile(ROTATE_FILE, 'utf8')); } catch { overlay = null; }
  overlayLoaded = true;
}

async function withRotated(cookies) {
  await loadOverlay();
  if (!overlay || !overlay.values || overlay.base !== sha1(cookies)) return cookies;
  return overlayString(cookies, overlay.values);
}

async function saveOverlay(next) {
  overlay = next;
  overlayLoaded = true;
  const stored = await storeSet('overlay', next);
  try {
    await fs.mkdir(path.dirname(ROTATE_FILE), { recursive: true });
    await fs.writeFile(ROTATE_FILE, JSON.stringify(next), { mode: 0o600 });
  } catch { /* a read-only disk is fine when the store has it */ }
  return stored;
}

async function dropOverlay() {
  overlay = null;
  overlayLoaded = true;
  await storeDel('overlay');
  try { await fs.unlink(ROTATE_FILE); } catch { /* there was none */ }
}

/** the cookies Google refreshed in its answer: only the rotating ones, never a deletion */
function parseSetCookies(list) {
  const out = {};
  for (const line of [].concat(list || [])) {
    const text = String(line);
    const first = text.split(';')[0];
    const i = first.indexOf('=');
    if (i < 1) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    if (!ROTATING_COOKIES.test(name) || !value) continue;
    const maxAge = /;\s*max-age\s*=\s*(-?\d+)/i.exec(text);
    if (maxAge && Number(maxAge[1]) <= 0) continue;
    const expires = /;\s*expires\s*=\s*([^;]+)/i.exec(text);
    if (expires && Date.parse(expires[1]) < Date.now()) continue;
    out[name] = value;
  }
  return out;
}

/** one rotation now → { rotated: [names] }; throws a GeminiError (the keep-alive timer ignores it, /gcch shows it) */
export async function rotateCookies() {
  rotation.lastTry = Date.now();
  try {
    const base = await readBase();
    if (!base.cookies) throw new GeminiError('Cookies not found. Please provide cookies or ensure Geminicook.txt exists.', 'NO_COOKIES');
    const current = await withRotated(base.cookies);
    if (overlay && overlay.base === sha1(base.cookies) && Date.now() - (overlay.at || 0) < 60_000) {
      return { rotated: [], skipped: true };                 // rotated a moment ago: a restart loop must not hammer Google
    }
    const r = await httpsRequest('https://accounts.google.com/RotateCookies', {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        'Cookie': current
      },
      body: '[000,"-0000000000000000000"]',
      timeoutMs: PAGE_TIMEOUT_MS
    });
    if (r.status === 401 || r.status === 403) throw new GeminiError(`Google refused to rotate the cookies (HTTP ${r.status}): they are no longer accepted`, 'AUTH', { status: r.status });
    if (r.status === 429) throw new GeminiError('Google is rate limiting the cookie rotation (HTTP 429)', 'RATE_LIMIT', { status: 429 });
    if (r.status < 200 || r.status >= 300) throw new GeminiError(`Cookie rotation failed (HTTP ${r.status})`, 'HTTP', { status: r.status });

    const fresh = parseSetCookies(r.headers['set-cookie']);
    const names = Object.keys(fresh);
    if (names.length) {
      const keep = overlay && overlay.base === sha1(base.cookies) ? overlay.values : {};
      rotation.stored = await saveOverlay({ base: sha1(base.cookies), values: { ...keep, ...fresh }, at: Date.now() });
      const hit = tokenCache.get('default');                 // the very next message already uses the fresh cookies
      if (hit) hit.tokens.cookies = overlayString(base.cookies, overlay.values);
    }
    rotation.count += 1;
    rotation.lastOk = Date.now();
    rotation.lastNames = names;
    rotation.error = null;
    return { rotated: names };
  } catch (e) {
    const err = netError(e, 'Cookie rotation failed');
    rotation.error = { code: err.code, sys: err.sys || '', status: err.status || 0, message: err.message, at: Date.now() };
    if (err.code === 'AUTH' && onAuthLost) {
      try { onAuthLost(err); } catch { /* the alert is optional */ }
    }
    throw err;
  }
}

/** for /gcch */
export function rotationStatus() {
  const ago = (t) => (t ? Math.round((Date.now() - t) / 1000) : null);
  return {
    enabled: rotation.enabled,
    running: !!rotation.timer,
    everyMin: Math.round(ROTATE_EVERY_MS / 60_000),
    count: rotation.count,
    lastOkAgoSec: ago(rotation.lastOk),
    lastNames: rotation.lastNames,
    stored: rotation.stored,
    error: rotation.error ? { ...rotation.error, agoSec: ago(rotation.error.at) } : null
  };
}

/**
 * Around the clock, from the moment the bot starts (lib/gf/ai.js does that) — not only after the first message: an idle bot's cookies
 * would go stale while nobody is chatting.
 */
export function startKeepAlive() {
  if (!rotation.enabled || rotation.timer) return;
  const tick = async (retry = false) => {
    if (rotation.busy) return;
    rotation.busy = true;
    try {
      const base = await readBase();
      if (!base.cookies) return;                             // no cookies (yet): nothing to keep alive
      await rotateCookies();
    } catch (e) {
      // a hiccup (network, Google 5xx): one more try in a minute instead of waiting for the next round
      if (!retry && e && (e.code === 'NETWORK' || e.code === 'TIMEOUT' || e.code === 'HTTP')) setTimeout(() => tick(true), 60_000).unref();
    } finally {
      rotation.busy = false;
    }
  };
  rotation.timer = setInterval(() => tick(), ROTATE_EVERY_MS);
  rotation.timer.unref();
  setTimeout(() => tick(), FIRST_ROTATE_MS).unref();
}

/**
 * Cookies pasted by the owner (/gcset). Google must accept them BEFORE they are saved; then they are kept in the store (and used at once).
 * → { count, stored }   throws a GeminiError when Google does not accept them
 */
export async function setCookies(text) {
  const cookies = parseCookies(text);
  if (!cookies) throw new GeminiError('There are no cookies in that text', 'BAD_INPUT');
  await getSessionTokens(cookies, { force: true });
  const at = Date.now();
  const stored = await storeSet('override', { cookies, at });
  override = { cookies, at };
  overrideLoaded = true;
  await dropOverlay();                                       // the rotated values belonged to the old cookies
  clearSessionCache();
  startKeepAlive();
  return { count: cookies.split('; ').length, stored };
}

/** back to the cookie file / env */
export async function clearCookies() {
  override = null;
  overrideLoaded = true;
  await storeDel('override');
  await dropOverlay();
  clearSessionCache();
}

// ───────────────────────────── session tokens ─────────────────────────────

async function fetchAppHtml(cookie) {
  const r = await httpsRequest('https://gemini.google.com/app', {
    headers: {
      'User-Agent': USER_AGENT,
      'Cookie': cookie
    },
    timeoutMs: PAGE_TIMEOUT_MS
  });
  return { html: r.text, status: r.status, location: r.headers.location || '', setCookies: [].concat(r.headers['set-cookie'] || []).length };
}

function extractTokens(html) {
  const pick = (key) => {
    const m = html.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (!m) return null;
    try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
  };
  let at = pick('SNlM0e');
  let bl = pick('cfb2h');
  let fsid = pick('FdrFJe');
  const hasWiz = /WIZ_global_data/.test(html);
  if (!at) {
    const m = html.match(/window\.WIZ_global_data\s*=\s*(\{[\s\S]*?\});/);
    if (m) {
      try {
        const wiz = JSON.parse(m[1]);
        at = wiz.SNlM0e || null;
        bl = bl || wiz.cfb2h || null;
        fsid = fsid || wiz.FdrFJe || null;
      } catch { /* leave at = null */ }
    }
  }
  return { at, bl, fsid, hasWiz };
}

const tokenCache = new Map();      // cookie source → { tokens, expires }
const tokenInflight = new Map();   // cookie source → Promise (one page load for many callers)

/** forget the cached page tokens (the next call loads gemini.google.com/app again) */
export function clearSessionCache() {
  tokenCache.clear();
}

async function loadTokens(cookieHeader) {
  const page = await fetchAppHtml(cookieHeader);
  if (page.status === 429) throw new GeminiError('Gemini page is rate limited (HTTP 429)', 'RATE_LIMIT', { status: 429 });
  if (page.status >= 500) throw new GeminiError(`Gemini page failed (HTTP ${page.status})`, 'HTTP', { status: page.status });
  const found = extractTokens(page.html);
  // what the page looked like: a signed-out Gemini page still answers HTTP 200 but has a sign-in link and no SNlM0e token
  const facts = `HTTP ${page.status} · page ${Math.round(page.html.length / 1024)} KB · sign-in link: ${/ServiceLogin/.test(page.html) ? 'yes' : 'no'} · Google set ${page.setCookies} cookie(s)`;
  if (!found.hasWiz && !found.at) {
    const where = page.location ? ` → ${page.location.split('?')[0]}` : '';
    throw new GeminiError(`Failed to extract WIZ_global_data. Cookies might be invalid or expired. (${facts}${where})`, 'AUTH', { status: page.status });
  }
  if (!found.at) {
    throw new GeminiError(`Failed to retrieve SNlM0e access token. Session may not be authenticated. (${facts})`, 'AUTH', { status: page.status });
  }
  return {
    at: found.at,
    bl: found.bl,
    fsid: found.fsid,
    cookies: cookieHeader
  };
}

export async function getSessionTokens(customCookies = null, { force = false } = {}) {
  const source = customCookies
    ? `custom:${crypto.createHash('sha1').update(String(customCookies)).digest('hex')}`
    : 'default';

  if (force) tokenCache.delete(source);
  const hit = tokenCache.get(source);
  if (hit && hit.expires > Date.now()) return hit.tokens;
  if (tokenInflight.has(source)) return tokenInflight.get(source);

  const job = (async () => {
    const located = customCookies ? null : await locateCookies();
    const cookieHeader = customCookies ? parseCookies(customCookies) : located.cookies;
    if (!cookieHeader) {
      throw new GeminiError('Cookies not found. Please provide cookies or ensure Geminicook.txt exists.', 'NO_COOKIES');
    }

    let tokens;
    try {
      tokens = await loadTokens(cookieHeader);
    } catch (e) {
      // The rotated values were refused, but the cookies you gave still work? Then the rotation went wrong: forget it and use yours.
      if (located && e.code === 'AUTH' && located.base && located.base !== cookieHeader) {
        try { tokens = await loadTokens(located.base); } catch { throw e; }
        await dropOverlay();
        console.error('[gemini] the rotated cookies were refused but yours work → the rotated values are dropped');
      } else {
        throw e;
      }
    }
    tokenCache.set(source, { tokens, expires: Date.now() + TOKEN_TTL_MS });
    if (!customCookies) startKeepAlive();                    // the cookies work → keep them working
    return tokens;
  })();

  tokenInflight.set(source, job);
  try {
    return await job;
  } finally {
    if (tokenInflight.get(source) === job) tokenInflight.delete(source);
  }
}

// ───────────────────────────── talking to Gemini ─────────────────────────────

function parseFrames(text) {
  const results = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('[["wrb.fr"')) {
      try {
        const parsed = JSON.parse(line);
        for (const item of parsed) {
          if (item[0] === 'wrb.fr' && item[2]) {
            results.push({ rpcid: item[1], data: JSON.parse(item[2]) });
          }
        }
      } catch {}
    }
  }
  return results;
}

export async function uploadMedia(input, options = {}) {
  let buffer;
  let filename = options.filename || 'upload.bin';
  let mimeType = options.mimeType;

  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    buffer = input;
  } else if (typeof input === 'string') {
    if (input.startsWith('http://') || input.startsWith('https://')) {
      const res = await fetch(input, { headers: { 'User-Agent': USER_AGENT } }).catch((e) => { throw netError(e, 'Media download failed'); });
      if (!res.ok) throw new Error(`Failed to fetch media from URL (${res.status})`);
      buffer = Buffer.from(await res.arrayBuffer());
      if (!options.filename) {
        filename = new URL(input).pathname.split('/').pop() || 'upload.bin';
      }
      if (!mimeType && res.headers.get('content-type')) {
        mimeType = res.headers.get('content-type').split(';')[0];
      }
    } else {
      buffer = await fs.readFile(input);
      if (!options.filename) {
        filename = path.basename(input);
      }
    }
  } else {
    throw new Error('Unsupported media input format');
  }

  if (!mimeType) {
    const ext = path.extname(filename).toLowerCase().replace('.', '');
    mimeType = MIME_MAP[ext] || 'application/octet-stream';
  }

  // https.request with a hand-made multipart body instead of fetch/FormData: no 16 KB header limit (UND_ERR_HEADERS_OVERFLOW),
  // a real timeout, and every failure carries its code
  const boundary = `----GeminiForm${crypto.randomBytes(12).toString('hex')}`;
  const safeName = String(filename).replace(/["\\\r\n]/g, '_');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    Buffer.from(buffer),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const res = await httpsRequest('https://content-push.googleapis.com/upload', {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'X-Tenant-Id': 'bard-storage',
      'Push-ID': 'feeds/mcudyrk2a4khkz',
      'Origin': 'https://gemini.google.com',
      'Referer': 'https://gemini.google.com/',
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body,
    timeoutMs: Number(options.timeoutMs) || 90_000
  });

  if (res.status < 200 || res.status >= 300) {
    throw new GeminiError(`Media upload failed (${res.status})`, res.status === 429 ? 'RATE_LIMIT' : 'HTTP', { status: res.status });
  }

  const uploadId = res.text.trim();
  return {
    uploadId,
    filename,
    mimeType
  };
}

export async function askGemini(prompt, options = {}) {
  if (!prompt || typeof prompt !== 'string') {
    throw new GeminiError('Prompt string is required', 'BAD_INPUT');
  }

  const reqId = String(Math.floor(Math.random() * 900000) + 100000);
  const uuidVal = crypto.randomUUID().toUpperCase();
  const lang = options.language || 'id';
  const timeoutMs = Number(options.timeoutMs) || GENERATE_TIMEOUT_MS;

  let session = await getSessionTokens(options.cookies);

  let fileData = null;
  const rawFiles = options.files || (options.file ? [options.file] : null);

  if (Array.isArray(rawFiles) && rawFiles.length > 0) {
    const uploadedList = [];
    for (const f of rawFiles) {
      if (typeof f === 'object' && f.uploadId) {
        uploadedList.push(f);
      } else {
        const up = await uploadMedia(f);
        uploadedList.push(up);
      }
    }
    fileData = uploadedList.map((item) => [[item.uploadId], item.filename]);
  }

  const innerReq = new Array(69).fill(null);
  innerReq[0] = [prompt, 0, null, fileData, null, null, 0];
  innerReq[1] = [lang];
  innerReq[2] = options.conversationId
    ? [options.conversationId, options.responseId || '', options.candidateId || '']
    : ['', '', ''];
  innerReq[4] = crypto.randomBytes(16).toString('hex');
  innerReq[6] = [1];
  innerReq[7] = 1;
  innerReq[10] = 1;
  innerReq[11] = 0;
  innerReq[17] = [[options.turnIndex || 0]];
  innerReq[18] = 0;
  innerReq[27] = 1;
  innerReq[30] = [4];
  innerReq[41] = [1];
  innerReq[53] = 0;
  innerReq[55] = [[1]];
  innerReq[59] = uuidVal;
  innerReq[61] = [];
  innerReq[68] = 2;

  const fReq = JSON.stringify([null, JSON.stringify(innerReq)]);

  const post = (s) => {
    const params = new URLSearchParams();
    if (s.bl) params.set('bl', s.bl);
    if (s.fsid) params.set('f.sid', s.fsid);
    params.set('hl', lang);
    params.set('_reqid', reqId);
    params.set('rt', 'c');
    // https.request, not fetch: see httpsRequest() (UND_ERR_HEADERS_OVERFLOW). The timeout covers the whole answer.
    return httpsRequest(`https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${params.toString()}`, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
        'Cookie': s.cookies,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Origin': 'https://gemini.google.com',
        'Referer': 'https://gemini.google.com/app',
        'x-goog-ext-525005358-jspb': `["${uuidVal}",1]`
      },
      body: new URLSearchParams({
        at: s.at,
        'f.req': fReq
      }).toString(),
      timeoutMs
    });
  };

  const ok = (r) => r.status >= 200 && r.status < 300;
  let res = await post(session);
  if (!ok(res) && (res.status === 400 || res.status === 401 || res.status === 403)) {
    // the cached page token went stale (or the cookies were revoked): load the page once more and try again
    session = await getSessionTokens(options.cookies, { force: true });
    res = await post(session);
  }

  if (!ok(res)) {
    const redirected = res.status >= 300 && res.status < 400;       // Google sends a logged-out request to its sign-in / consent page
    const code = res.status === 429 ? 'RATE_LIMIT' : (res.status === 401 || res.status === 403 || redirected) ? 'AUTH' : 'HTTP';
    const where = redirected && res.headers.location ? ` → ${String(res.headers.location).split('?')[0]}` : '';
    throw new GeminiError(`Failed to generate response (${res.status}${where})`, code, { status: res.status });
  }

  const frames = parseFrames(res.text);

  let finalReply = '';
  let conversationId = null;
  let responseId = null;
  let candidateId = null;

  for (const f of frames) {
    const data = f.data;
    if (Array.isArray(data)) {
      if (data[1] && Array.isArray(data[1])) {
        conversationId = data[1][0] || conversationId;
        responseId = data[1][1] || responseId;
      }
      if (data[4] && Array.isArray(data[4]) && data[4][0]) {
        candidateId = data[4][0][0] || candidateId;
        const candidateText = data[4][0][1]?.[0];
        if (candidateText) {
          finalReply = candidateText;
        }
      }
    }
  }

  return {
    text: finalReply,
    conversationId,
    responseId,
    candidateId
  };
}

export class ChatSession {
  constructor(options = {}) {
    this.cookies = options.cookies || null;
    this.conversationId = options.conversationId || null;
    this.responseId = options.responseId || null;
    this.candidateId = options.candidateId || null;
    this.turnIndex = options.turnIndex || 0;
    this.language = options.language || 'id';
  }

  async send(prompt, options = {}) {
    const res = await askGemini(prompt, {
      ...options,
      cookies: this.cookies || options.cookies,
      conversationId: this.conversationId,
      responseId: this.responseId,
      candidateId: this.candidateId,
      turnIndex: this.turnIndex,
      language: this.language
    });
    this.conversationId = res.conversationId;
    this.responseId = res.responseId;
    this.candidateId = res.candidateId;
    this.turnIndex += 1;
    return res;
  }
}

export function createSession(options = {}) {
  return new ChatSession(options);
}

export default {
  askGemini,
  uploadMedia,
  createSession,
  ChatSession,
  GeminiError,
  getSessionTokens,
  clearSessionCache,
  loadCookiesFromFile,
  locateCookies,
  rotateCookies,
  rotationStatus,
  startKeepAlive,
  setCookies,
  clearCookies,
  setCookieStore,
  setAuthLostHandler,
  storeReady,
  parseCookies
};
