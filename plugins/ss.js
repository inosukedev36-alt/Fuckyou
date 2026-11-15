/**
 * ───────────────────────────────────────────────────────────────
 *  Website screenshot — WhatsApp bot command
 * ───────────────────────────────────────────────────────────────
 *  .ss <site link>
 *      → the bot asks: mobile phone or PC?
 *      → reply (quote) that question with 1  → screenshot as on a mobile phone
 *      → reply (quote) that question with 2  → screenshot as on a PC
 *
 *  Owner commands
 *      .ss install     → downloads Chrome into the bot folder and tests it
 *      .ss status      → shows which engine is used and what this server can run
 *      .ss uninstall   → removes the downloaded Chrome
 *
 *  Needs  : nothing to install with npm — only Node's built-in modules
 *  Place  : your bot's plugins/ folder (next to your other commands)
 *  Output : English
 *
 *  How a screenshot is taken (first one that works wins)
 *   1. Local Chrome — a Chrome found on this server, or the one `.ss install` downloads
 *                     (controlled through Chrome's DevTools protocol, like Puppeteer does)
 *   2. Microlink    — a real Chrome run by Microlink (free: 50 per day)
 *   3. PageSpeed    — Google's Chrome (smaller / lower quality picture)
 *
 *  Optional settings (environment variables)
 *   SS_LOCAL_CHROME=off  → never use a local Chrome        CHROME_PATH=/path/to/chrome → use this one
 *   SS_ADMINS=9477...,9471...  → numbers allowed to use the owner commands
 *   MICROLINK_API_KEY / PAGESPEED_API_KEY → keys for the web routes
 * ───────────────────────────────────────────────────────────────
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const stream = require('stream');
const { StringDecoder } = require('string_decoder');
const { spawn, execFile } = require('child_process');
const { cmd } = require('../command'); // ← change this path if your bot's command.js is somewhere else

const pipeline = util.promisify(stream.pipeline);

// ─────────────── settings (edit freely) ───────────────
const PREFIX_HINT       = '.';
const ASK_TIMEOUT_MS    = 10 * 60 * 1000; // how long the "reply 1 or 2" question stays active
const MAX_USES          = 4;              // how many screenshots one question may produce (e.g. mobile, then PC)
const MAX_ACTIVE        = 2;              // screenshots that may be taken at the same time
const MAX_IMAGE_MB      = 15;             // WhatsApp's picture limit is 16 MB
const SHOW_ERROR_REASON = true;           // show the technical reason when a screenshot fails

const MICROLINK_KEY     = process.env.MICROLINK_API_KEY || '';
const PAGESPEED_KEY     = process.env.PAGESPEED_API_KEY || '';

const LOCAL_CHROME      = !/^(off|0|false|no)$/i.test(process.env.SS_LOCAL_CHROME || 'on');
const CHROME_PATH       = process.env.CHROME_PATH || '';
const LOCAL_TIMEOUT_MS  = 60 * 1000;      // a local Chrome that takes longer than this is stopped
const MIN_FREE_RAM_MB   = 350;            // a local Chrome is skipped when less memory than this is free
const MIN_TOTAL_RAM_MB  = 700;            // …or when this server's memory limit is smaller than this
const MIN_FREE_DISK_MB  = 700;            // needed to download and unpack Chrome
const ADMIN_NUMBERS     = (process.env.SS_ADMINS || '').split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean);

// the two choices the user can reply with
const DEVICES = {
    1: {
        name: 'Mobile phone', icon: '📱', microlink: 'iPhone 15 Pro', strategy: 'mobile',
        scale: 2, window: [393, 852], mobile: true, platform: 'Linux armv8l',
        ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{v}.0.0.0 Mobile Safari/537.36',
    },
    2: {
        name: 'PC', icon: '🖥️', microlink: 'Macbook Pro 13', strategy: 'desktop',
        scale: 1, window: [1366, 768], mobile: false, platform: 'Win32',
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{v}.0.0.0 Safari/537.36',
    },
};

// ─────────────── small helpers ───────────────
const MB = 1048576;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cut = (text, max) => Array.from(text).slice(0, max).join('');
const shorten = (text, max) => (Array.from(text).length > max ? `${cut(text, max - 1)}…` : text);
const clean = (value, fallback = '') => String(value ?? '').replace(/\s+/g, ' ').trim() || fallback;
const mb = (bytes) => `${Math.round(bytes / MB)} MB`;
const progressBar = (percent, width = 14) => {
    const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
    return '■'.repeat(filled) + '□'.repeat(width - filled);
};

// never let an API key leak into a chat message
const redact = (text) =>
    [MICROLINK_KEY, PAGESPEED_KEY].filter(Boolean).reduce((t, key) => t.split(key).join('***'), String(text));

const execFileP = (file, args, options) => new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) =>
        (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })));
});

// ─────────────── bot messages (all English) ───────────────
const MSG = {
    usage:
        '❌ *Please provide a website link.*\n\n' +
        '📌 *Examples:*\n' +
        `${PREFIX_HINT}ss https://www.google.com\n` +
        `${PREFIX_HINT}ss example.com`,
    invalid:
        '❌ *That does not look like a valid website link.*\n\n' +
        'Please check the link and try again.',
    ask: (url) =>
        '🖼️ *Website Screenshot*\n\n' +
        `🔗 ${shorten(url, 120)}\n\n` +
        '*Should the screenshot look like it was taken on a mobile phone or on a PC?*\n\n' +
        '1️⃣  📱 Mobile phone\n' +
        '2️⃣  🖥️ PC\n\n' +
        '↩️ *Reply to this message* with *1* or *2*.',
    working: (device, host) =>
        `⏳ Taking the ${device.icon} *${device.name}* screenshot of *${host}*...\n` +
        'This can take up to 30 seconds.',
    failed: (reason) =>
        '❌ *Could not take the screenshot.*' +
        (SHOW_ERROR_REASON && reason ? `\n\n🔎 *Reason:* ${shorten(redact(reason), 450)}` : '') +
        '\n\nThe website may be down, too slow, or blocking screenshot tools.',
    busy: '⏳ The bot is taking other screenshots right now. Please reply again in a moment.',
    usedUp:
        `ℹ️ This question has already been used ${MAX_USES} times.\n` +
        `Send *${PREFIX_HINT}ss <link>* again to start a new one.`,
    adminOnly: '⛔ Only the bot owner can use this command.',
    error: '❌ Something went wrong while processing your request. Please try again later.',
};

// ─────────────── the link ───────────────
const PRIVATE_IP = /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

// "example.com" or "https://example.com/page" → a clean https/http URL, or null when it is not a public website
function normalizeUrl(input) {
    const text = String(input || '').trim().split(/\s+/)[0];
    if (!text || text.length > 2000) return null;

    let url;
    try {
        url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
        return null;
    }

    if (!/^https?:$/.test(url.protocol)) return null;
    const host = url.hostname;
    if (!/^[a-z0-9.-]+$/i.test(host) || !host.includes('.') || host.startsWith('.') || host.endsWith('.')) return null;
    if (PRIVATE_IP.test(host) || /\.(local|localhost|internal|lan)$/i.test(host)) return null;
    return url.href;
}

// "1", "2", "1.", "1️⃣" … → "1" / "2"; anything else → null
function parseChoice(text) {
    const m = /^([12])[\s.)\uFE0F\u20E3]*$/.exec(String(text || '').trim());
    return m ? m[1] : null;
}

// ─────────────── tiny HTTP client (built-in https/http, no packages) ───────────────
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function unzipBuffer(encoding, buffer) {
    switch (String(encoding || '').toLowerCase()) {
        case 'gzip':    return zlib.gunzipSync(buffer);
        case 'deflate': return zlib.inflateSync(buffer);
        case 'br':      return zlib.brotliDecompressSync(buffer);
        default:        return buffer;
    }
}

// resolves with { status, url, headers, body (Buffer), text }
function request(url, { headers = {}, redirects = 5, timeout = 60000 } = {}) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        } catch {
            return reject(new Error('invalid URL'));
        }
        const secure = target.protocol !== 'http:';

        const req = (secure ? https : http).request({
            hostname: target.hostname,
            port: target.port || (secure ? 443 : 80),
            path: target.pathname + target.search,
            method: 'GET',
            timeout,
            headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip', ...headers },
        }, (res) => {
            const status = res.statusCode;

            if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects > 0) {
                res.resume();
                return resolve(request(new URL(res.headers.location, url).toString(), {
                    headers, redirects: redirects - 1, timeout,
                }));
            }

            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('error', (err) => reject(/aborted|ECONNRESET/i.test(String(err && err.message)) ? new Error('the connection was closed early') : err));
            res.on('close', () => {
                if (!res.complete) reject(new Error('the connection was closed early'));
            });
            res.on('end', () => {
                try {
                    const buffer = unzipBuffer(res.headers['content-encoding'], Buffer.concat(chunks));
                    resolve({
                        status,
                        url,
                        headers: res.headers,
                        body: buffer,
                        get text() { return buffer.toString('utf8'); },
                    });
                } catch (err) {
                    reject(err);
                }
            });
        });

        req.on('timeout', () => req.destroy(new Error('the request timed out')));
        req.on('error', reject);
        req.end();
    });
}

// streams a (big) file to disk — onProgress(doneBytes, totalBytes)
function downloadFile(url, dest, { onProgress, redirects = 5, timeout = 60000 } = {}) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        } catch {
            return reject(new Error('invalid URL'));
        }
        const secure = target.protocol !== 'http:';

        const req = (secure ? https : http).request({
            hostname: target.hostname,
            port: target.port || (secure ? 443 : 80),
            path: target.pathname + target.search,
            method: 'GET',
            timeout,
            headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity' },
        }, (res) => {
            const status = res.statusCode;

            if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects > 0) {
                res.resume();
                return resolve(downloadFile(new URL(res.headers.location, url).toString(), dest, {
                    onProgress, redirects: redirects - 1, timeout,
                }));
            }
            if (status !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${status}`));
            }

            const total = Number(res.headers['content-length']) || 0;
            let done = 0;
            const file = fs.createWriteStream(dest);
            const fail = (err) => { file.destroy(); reject(err); };

            res.on('data', (chunk) => {
                done += chunk.length;
                if (onProgress) onProgress(done, total);
            });
            res.on('error', (err) => fail(/aborted|ECONNRESET/i.test(String(err && err.message)) ? new Error('the download was interrupted') : err));
            res.on('close', () => { if (!res.complete) fail(new Error('the connection was closed early')); });
            file.on('error', fail);
            file.on('close', () => {
                if (total && done !== total) reject(new Error('the download was cut short'));
                else resolve(done);
            });
            res.pipe(file);
        });

        req.on('timeout', () => req.destroy(new Error('the download timed out')));
        req.on('error', reject);
        req.end();
    });
}

// one retry for network problems and server errors
async function fetchJson(url, { headers, timeout }) {
    let last;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const res = await request(url, { headers: { Accept: 'application/json', ...headers }, timeout });
            if (res.status >= 500 && attempt < 2) {
                last = new Error(`HTTP ${res.status}`);
                await sleep(1500);
                continue;
            }
            let data = null;
            try { data = JSON.parse(res.text); } catch { /* not JSON */ }
            return { status: res.status, data };
        } catch (err) {
            last = err;
            if (attempt < 2) await sleep(1500);
        }
    }
    throw last;
}

const query = (params) =>
    Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

// ═══════════════ PART 1 — a Chrome on this server ═══════════════

// where the bot keeps its own Chrome: a writable folder next to the bot
const BASE_DIR = [process.cwd(), path.resolve(__dirname, '..'), os.tmpdir()].find((dir) => {
    try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}) || os.tmpdir();
const BROWSER_DIR = path.join(BASE_DIR, 'ss_browser');
const INSTALLED_BIN = path.join(BROWSER_DIR, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
const FONTS_DIR = path.join(BROWSER_DIR, 'fonts');
const FONT_CONF = path.join(BROWSER_DIR, 'fonts.conf');

// ---------- what this server can offer ----------
function memoryState() {
    const read = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; } };
    let limit = os.totalmem();
    let used = null;

    const v2max = read('/sys/fs/cgroup/memory.max');
    const v2cur = read('/sys/fs/cgroup/memory.current');
    const v1max = read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
    const v1cur = read('/sys/fs/cgroup/memory/memory.usage_in_bytes');

    if (v2cur !== null) {
        if (Number.isFinite(Number(v2max))) limit = Math.min(limit, Number(v2max));
        used = Number(v2cur);
    } else if (v1cur !== null) {
        if (Number.isFinite(Number(v1max))) limit = Math.min(limit, Number(v1max));
        used = Number(v1cur);
    }
    return { limit, free: used === null ? os.freemem() : Math.max(0, limit - used) };
}

function freeDisk(dir) {
    try {
        const s = fs.statfsSync(dir);
        return s.bavail * s.bsize;
    } catch {
        return null; // older Node versions cannot tell
    }
}

function glibcVersion() {
    try { return process.report.getReport().header.glibcVersionRuntime || null; } catch { return null; }
}

// system libraries the Chrome headless shell links against (used for the "probably missing" hint)
const NEEDED_LIBS = [
    'libnss3.so', 'libnspr4.so', 'libatk-1.0.so.0', 'libatk-bridge-2.0.so.0', 'libatspi.so.0', 'libdbus-1.so.3',
    'libX11.so.6', 'libXcomposite.so.1', 'libXdamage.so.1', 'libXext.so.6', 'libXfixes.so.3', 'libXrandr.so.2',
    'libgbm.so.1', 'libdrm.so.2', 'libxkbcommon.so.0', 'libasound.so.2', 'libexpat.so.1', 'libxcb.so.1', 'libglib-2.0.so.0',
];
const LIB_DIRS = [
    '/lib', '/lib64', '/usr/lib', '/usr/lib64', '/usr/local/lib',
    '/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib/aarch64-linux-gnu', '/usr/lib/aarch64-linux-gnu',
];
const probablyMissingLibs = () =>
    NEEDED_LIBS.filter((lib) => !LIB_DIRS.some((dir) => fs.existsSync(path.join(dir, lib))));

// libraries a given Chrome file cannot find (exact answer, needs `ldd`) — null when `ldd` is not available
async function missingLibs(file) {
    try {
        const { stdout } = await execFileP('ldd', [file], { timeout: 20000 });
        return stdout.split('\n').filter((l) => /not found/.test(l)).map((l) => l.trim().split(/\s+/)[0]);
    } catch {
        return null;
    }
}

// ---------- finding a Chrome ----------
let browserCache;          // undefined = never looked; null = looked, nothing usable; object = usable
let browserCheckedAt = 0;

function isExecutable(file) {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

// files called `names` somewhere below `root` (shallow search, used for puppeteer / playwright caches)
function findNamed(root, names, depth = 5) {
    const found = [];
    const walk = (dir, level) => {
        if (level > depth) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, level + 1);
            else if (names.includes(entry.name)) found.push(full);
        }
    };
    walk(root, 0);
    return found;
}

function browserCandidates() {
    const list = [];
    if (CHROME_PATH) list.push(CHROME_PATH);
    list.push(INSTALLED_BIN);

    const names = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'chrome', 'chrome-headless-shell', 'headless_shell', 'microsoft-edge', 'brave-browser'];
    for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
        for (const name of names) list.push(path.join(dir, name));
    }
    list.push('/opt/google/chrome/chrome', '/snap/bin/chromium');

    // browsers other tools already downloaded (puppeteer / playwright)
    const home = os.homedir();
    for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(home, '.cache', 'ms-playwright'), path.join(home, '.cache', 'puppeteer'), path.join(BASE_DIR, '.cache', 'puppeteer')]) {
        if (root) list.push(...findNamed(root, ['chrome', 'headless_shell', 'chrome-headless-shell']));
    }
    return [...new Set(list)].filter(isExecutable);
}

// the version a browser file reports, or null when it does not run
async function probe(file) {
    try {
        const { stdout } = await execFileP(file, ['--version'], { timeout: 20000 });
        const m = /(\d+\.\d+\.\d+\.\d+)/.exec(stdout);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

async function findBrowser(refresh = false) {
    if (!LOCAL_CHROME) return null;
    const stale = browserCache === null && Date.now() - browserCheckedAt > 5 * 60 * 1000; // look again now and then
    if (browserCache !== undefined && !refresh && !stale) return browserCache;

    browserCache = null;
    browserCheckedAt = Date.now();
    for (const file of browserCandidates()) {
        const version = await probe(file);
        if (version) {
            browserCache = {
                path: file,
                version,
                kind: /headless/i.test(path.basename(file)) ? 'shell' : 'full',
                installed: file === INSTALLED_BIN,
            };
            break;
        }
    }
    return browserCache;
}

// ---------- taking a screenshot with it ----------
let localBusy = false;   // only one Chrome at a time (it needs a lot of memory)
let installing = false;

// size of a PNG, read from its header
function pngSize(buffer) {
    if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    return { width: null, height: null };
}

// ---------- a very small Chrome DevTools Protocol client (talks to Chrome through a pipe) ----------
class Cdp {
    constructor(child) {
        this.out = child.stdio[3];     // commands go to Chrome here
        this.input = child.stdio[4];   // Chrome's answers and events come back here
        this.nextId = 1;
        this.calls = new Map();
        this.handlers = [];
        this.closed = null;

        const decoder = new StringDecoder('utf8');
        let buffer = '';
        this.input.on('data', (chunk) => {
            buffer += decoder.write(chunk);
            let end;
            while ((end = buffer.indexOf('\0')) !== -1) {       // every message ends with a NUL byte
                const text = buffer.slice(0, end);
                buffer = buffer.slice(end + 1);
                if (!text) continue;
                try { this.dispatch(JSON.parse(text)); } catch { /* ignore a message that cannot be read */ }
            }
        });
        this.input.on('error', () => {});
        this.out.on('error', () => {});
    }

    dispatch(message) {
        if (message.id !== undefined) {
            const call = this.calls.get(message.id);
            if (!call) return;
            this.calls.delete(message.id);
            if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`));
            else call.resolve(message.result || {});
        } else if (message.method) {
            for (const h of this.handlers) {
                if (h.method === message.method && h.sessionId === message.sessionId) h.fn(message.params || {});
            }
        }
    }

    send(method, params = {}, sessionId) {
        if (this.closed) return Promise.reject(this.closed);
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            this.calls.set(id, { method, resolve, reject });
            this.out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
        });
    }

    on(method, sessionId, fn) {
        this.handlers.push({ method, sessionId, fn });
    }

    // Chrome went away (or took too long): everything that is still waiting fails
    fail(error) {
        if (this.closed) return;
        this.closed = error;
        for (const call of this.calls.values()) call.reject(error);
        this.calls.clear();
    }
}

// friendlier words for the most common "page could not be opened" errors
const NAVIGATION_ERRORS = [
    [/ERR_NAME_NOT_RESOLVED/, 'the website address could not be found (DNS lookup failed)'],
    [/ERR_CONNECTION_(REFUSED|RESET|CLOSED|FAILED)|ERR_EMPTY_RESPONSE/, 'the website refused or dropped the connection'],
    [/ERR_(CONNECTION_)?TIMED_OUT/, 'the website did not answer in time'],
    [/ERR_CERT|ERR_SSL/, 'the website has a problem with its security certificate'],
    [/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/, "this server's internet connection is not working"],
];
const navigationProblem = (errorText) => {
    const known = NAVIGATION_ERRORS.find(([re]) => re.test(errorText));
    return known ? `${known[1]} (${errorText})` : `the page could not be opened (${errorText})`;
};

const SETTLE_MS = 1500;   // extra time after the page has loaded, for late scripts and animations

// opens the page like a browser would, waits for it to settle and returns the picture
async function capture(cdp, url, device, major) {
    const [width, height] = device.window;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = (method, params) => cdp.send(method, params, sessionId);

    let loaded = false;
    let inflight = 0;
    let lastActivity = Date.now();
    const requestDone = () => { inflight = Math.max(0, inflight - 1); lastActivity = Date.now(); };
    cdp.on('Page.loadEventFired', sessionId, () => { loaded = true; });
    cdp.on('Network.requestWillBeSent', sessionId, () => { inflight++; lastActivity = Date.now(); });
    cdp.on('Network.loadingFinished', sessionId, requestDone);
    cdp.on('Network.loadingFailed', sessionId, requestDone);
    cdp.on('Page.javascriptDialogOpening', sessionId, () => {      // an alert() must not freeze the page
        page('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });

    await page('Page.enable');
    await page('Network.enable');
    await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: device.scale, mobile: device.mobile });
    if (device.mobile) await page('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page('Emulation.setUserAgentOverride', {
        userAgent: device.ua.replace('{v}', major),
        acceptLanguage: 'en-US,en;q=0.9',
        platform: device.platform,
    });
    await page('Emulation.setDefaultBackgroundColorOverride', { color: { r: 255, g: 255, b: 255, a: 1 } });

    const navigation = await page('Page.navigate', { url });
    if (navigation.errorText) throw new Error(navigationProblem(navigation.errorText));

    // wait for the load event, then until the network has been quiet for a moment, then a short extra pause
    const started = Date.now();
    while (!loaded && Date.now() - started < 30000) await sleep(100);
    const quietFrom = Date.now();
    while (Date.now() - quietFrom < 8000 && !(inflight <= 2 && Date.now() - lastActivity > 700)) await sleep(100);
    await sleep(SETTLE_MS);

    const shot = await page('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(shot.data, 'base64');
}

// the most useful line of Chrome's own error output
function chromeProblem(errors, code) {
    const lib = /error while loading shared libraries: (\S+?):/.exec(errors);
    if (lib) return `Chrome cannot start because the system library ${lib[1]} is missing`;
    const lines = errors.split('\n').map((l) => l.trim()).filter((l) => l && !/dbus|Floss|vaapi|drmGetDevices|InitializeSandbox|bluez/i.test(l));
    return clean(lines[lines.length - 1], `Chrome stopped with exit code ${code}`);
}

let staleCleaned = false;
function cleanStaleRuns() {
    if (staleCleaned) return;
    staleCleaned = true;
    try {
        for (const name of fs.readdirSync(BASE_DIR)) {
            const dir = path.join(BASE_DIR, name);
            if (name.startsWith('ss_run_') && Date.now() - fs.statSync(dir).mtimeMs > 3600000) fs.rmSync(dir, { recursive: true, force: true });
        }
    } catch { /* not important */ }
}

async function chromeShot(browser, url, device, { timeout = LOCAL_TIMEOUT_MS } = {}) {
    cleanStaleRuns();
    const work = fs.mkdtempSync(path.join(BASE_DIR, 'ss_run_'));
    const [width, height] = device.window;
    const major = (/^(\d+)/.exec(browser.version) || [])[1] || '140';

    const args = [
        ...(browser.kind === 'full' ? ['--headless=new'] : []),
        '--remote-debugging-pipe',
        '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio',
        '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
        `--user-data-dir=${path.join(work, 'profile')}`,
        `--window-size=${width},${height}`,
        'about:blank',
    ];
    const env = {
        ...process.env,
        HOME: work,
        TMPDIR: work,
        XDG_CONFIG_HOME: path.join(work, 'config'),
        XDG_CACHE_HOME: path.join(work, 'cache'),
        ...(browser.installed && fs.existsSync(FONT_CONF) ? { FONTCONFIG_FILE: FONT_CONF } : {}),
    };

    // Chrome gets its own process group so that a hang can be cleaned up completely
    const child = spawn(browser.path, args, { env, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    let errors = '';
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-6000); });

    const cdp = new Cdp(child);
    const exited = new Promise((resolve) => {
        child.on('close', (code) => {
            cdp.fail(new Error(chromeProblem(errors, code)));
            resolve();
        });
    });
    child.on('error', (err) => cdp.fail(err));        // e.g. the file cannot be executed

    const timer = setTimeout(() => {
        cdp.fail(new Error(`Chrome did not finish within ${Math.round(timeout / 1000)} seconds`));
        killGroup();
    }, timeout);

    try {
        const buffer = await capture(cdp, url, device, major);
        if (!buffer.length) throw new Error('Chrome returned an empty picture');
        return { buffer, mime: 'image/png', ...pngSize(buffer), via: `Chrome ${browser.version}` };
    } finally {
        clearTimeout(timer);
        cdp.send('Browser.close').catch(() => {});     // ask politely…
        await Promise.race([exited, sleep(1500)]);
        killGroup();                                   // …then make sure nothing is left running
        fs.rmSync(work, { recursive: true, force: true });
    }
}

// route 0: the Chrome on this server — null when there is none (or this is not a good moment to start it)
async function fromChrome(url, device) {
    if (!LOCAL_CHROME || installing || localBusy) return null;

    const browser = await findBrowser();
    if (!browser) return null;

    const memory = memoryState();
    if (memory.limit < MIN_TOTAL_RAM_MB * MB || memory.free < MIN_FREE_RAM_MB * MB) {
        console.error(`[ss] local Chrome skipped: ${mb(memory.free)} free of ${mb(memory.limit)}`);
        return null;
    }

    localBusy = true;
    try {
        return await chromeShot(browser, url, device);
    } finally {
        localBusy = false;
    }
}

// ---------- unpacking a zip (Node has no zip support of its own) ----------
async function unzip(zipPath, destDir, onProgress) {
    const fd = fs.openSync(zipPath, 'r');
    try {
        const size = fs.fstatSync(fd).size;

        // the "end of central directory" record sits in the last bytes of the file
        const tailLength = Math.min(size, 65557);
        const tail = Buffer.alloc(tailLength);
        fs.readSync(fd, tail, 0, tailLength, size - tailLength);
        let eocd = -1;
        for (let i = tailLength - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('this is not a zip file');

        const count = tail.readUInt16LE(eocd + 10);
        const dirSize = tail.readUInt32LE(eocd + 12);
        const dirOffset = tail.readUInt32LE(eocd + 16);
        if (count === 0xffff || dirOffset === 0xffffffff) throw new Error('zip64 archives are not supported');

        const dir = Buffer.alloc(dirSize);
        fs.readSync(fd, dir, 0, dirSize, dirOffset);

        const entries = [];
        for (let i = 0, p = 0; i < count; i++) {
            if (dir.readUInt32LE(p) !== 0x02014b50) throw new Error('the zip directory is damaged');
            const madeBy = dir.readUInt16LE(p + 4);
            const flags = dir.readUInt16LE(p + 8);
            const nameLength = dir.readUInt16LE(p + 28);
            const extraLength = dir.readUInt16LE(p + 30);
            const commentLength = dir.readUInt16LE(p + 32);
            const attributes = dir.readUInt32LE(p + 38);
            entries.push({
                name: dir.toString('utf8', p + 46, p + 46 + nameLength),
                encrypted: (flags & 1) === 1,
                method: dir.readUInt16LE(p + 10),
                packed: dir.readUInt32LE(p + 20),
                size: dir.readUInt32LE(p + 24),
                offset: dir.readUInt32LE(p + 42),
                mode: (madeBy >> 8) === 3 ? (attributes >>> 16) & 0xffff : 0, // unix permissions, when the zip has them
            });
            p += 46 + nameLength + extraLength + commentLength;
        }

        const root = path.resolve(destDir);
        const total = entries.reduce((sum, e) => sum + e.size, 0);
        let done = 0;

        for (const entry of entries) {
            const target = path.resolve(root, entry.name);
            if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`unsafe path in the zip: ${entry.name}`);
            if (entry.encrypted) throw new Error('encrypted zip files are not supported');

            if (entry.name.endsWith('/')) {
                fs.mkdirSync(target, { recursive: true });
                continue;
            }
            fs.mkdirSync(path.dirname(target), { recursive: true });

            // where this file's data starts (the local header repeats the name / extra field lengths)
            const head = Buffer.alloc(30);
            fs.readSync(fd, head, 0, 30, entry.offset);
            if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('a zip entry is damaged');
            const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);

            if ((entry.mode & 0o170000) === 0o120000) {            // a symbolic link: the data is its target
                const raw = Buffer.alloc(entry.packed);
                fs.readSync(fd, raw, 0, entry.packed, start);
                const linkTarget = (entry.method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
                const resolved = path.resolve(path.dirname(target), linkTarget);
                if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`unsafe link in the zip: ${entry.name}`);
                fs.symlinkSync(linkTarget, target);
            } else if (entry.packed === 0) {
                fs.writeFileSync(target, '');
            } else {
                if (entry.method !== 0 && entry.method !== 8) throw new Error(`unsupported zip compression (${entry.method})`);
                await pipeline(
                    fs.createReadStream(zipPath, { start, end: start + entry.packed - 1 }),
                    ...(entry.method === 8 ? [zlib.createInflateRaw()] : []),
                    fs.createWriteStream(target)
                );
                if (fs.statSync(target).size !== entry.size) throw new Error(`${entry.name} was not unpacked completely`);
            }

            if ((entry.mode & 0o170000) !== 0o120000) fs.chmodSync(target, (entry.mode & 0o777) || 0o644);
            done += entry.size;
            if (onProgress) onProgress(done, total);
        }
    } finally {
        fs.closeSync(fd);
    }
}

// ---------- installing Chrome (and some fonts) ----------
const CHROME_VERSIONS_URL = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

// Chrome on a bare server draws no text without fonts, so a few free Noto fonts are downloaded as well
const NOTO = 'https://github.com/notofonts/notofonts.github.io/raw/main/fonts';
const FONT_FILES = [
    ['NotoSans-Regular.ttf',        `${NOTO}/NotoSans/hinted/ttf/NotoSans-Regular.ttf`],
    ['NotoSans-Bold.ttf',           `${NOTO}/NotoSans/hinted/ttf/NotoSans-Bold.ttf`],
    ['NotoSansSinhala-Regular.ttf', `${NOTO}/NotoSansSinhala/hinted/ttf/NotoSansSinhala-Regular.ttf`],
    ['NotoSansTamil-Regular.ttf',   `${NOTO}/NotoSansTamil/hinted/ttf/NotoSansTamil-Regular.ttf`],
    ['NotoColorEmoji.ttf',          'https://github.com/googlefonts/noto-emoji/raw/main/fonts/NotoColorEmoji.ttf'],
];

async function installFonts() {
    fs.mkdirSync(FONTS_DIR, { recursive: true });
    const done = [];
    for (const [name, url] of FONT_FILES) {
        const file = path.join(FONTS_DIR, name);
        try {
            await downloadFile(url, file);
            done.push(name);
        } catch (err) {
            fs.rmSync(file, { force: true });
            console.error(`[ss] font ${name} not installed: ${err.message}`);
        }
    }

    // a tiny fontconfig file so that Chrome finds these fonts even on a server without any font setup
    fs.writeFileSync(FONT_CONF,
        '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n' +
        '  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>\n' +
        `  <dir>${FONTS_DIR}</dir>\n` +
        `  <cachedir>${path.join(BROWSER_DIR, 'fontcache')}</cachedir>\n` +
        '</fontconfig>\n');
    return done;
}

// the page used to check that a freshly installed Chrome can draw text
const TEST_PAGE =
    'data:text/html;charset=utf-8,' +
    encodeURIComponent('<body style="margin:30px;font:48px sans-serif">Chrome is working ✔<br>සිංහල தமிழ் 😀</body>');

// report(text) is called with progress messages; resolves with { version, fonts }
async function installBrowser(report) {
    if (installing) throw new Error('an installation is already running');
    installing = true;
    const staging = path.join(BROWSER_DIR, 'staging');
    const zipFile = path.join(BROWSER_DIR, 'chrome.zip');

    try {
        if (process.platform !== 'linux') throw new Error(`automatic install works on Linux only (this is ${process.platform})`);
        if (process.arch !== 'x64') throw new Error(`Google only offers Chrome downloads for x64 servers (this server is ${process.arch})`);

        const disk = freeDisk(BASE_DIR);
        if (disk !== null && disk < MIN_FREE_DISK_MB * MB) throw new Error(`not enough free disk space (${mb(disk)} free, ${MIN_FREE_DISK_MB} MB needed)`);

        fs.rmSync(BROWSER_DIR, { recursive: true, force: true });
        fs.mkdirSync(staging, { recursive: true });

        // 1) which build to download
        await report('🔎 Looking for the latest Chrome build...');
        const { status, data } = await fetchJson(CHROME_VERSIONS_URL, { headers: {}, timeout: 30000 });
        if (!data) throw new Error(`could not read Google's download list (HTTP ${status})`);
        let build = null;
        for (const channel of ['Stable', 'Beta']) {
            const info = data.channels && data.channels[channel];
            const link = info && info.downloads && (info.downloads['chrome-headless-shell'] || []).find((d) => d.platform === 'linux64');
            if (link) { build = { version: info.version, url: link.url }; break; }
        }
        if (!build) throw new Error("Google's download list has no Linux build of Chrome right now");

        // 2) download
        let last = 0;
        await downloadFile(build.url, zipFile, {
            timeout: 120000,
            onProgress: (done, total) => {
                const percent = total ? Math.floor((done / total) * 100) : 0;
                if (percent >= last + 10) {
                    last = percent;
                    report(`⬇️ Downloading Chrome ${build.version}\n${progressBar(percent)} ${percent}%  (${mb(done)} / ${mb(total)})`).catch(() => {});
                }
            },
        });

        // 3) unpack
        await report(`📦 Unpacking Chrome ${build.version}...`);
        await unzip(zipFile, staging);
        fs.rmSync(zipFile, { force: true });
        const unpacked = path.join(staging, 'chrome-headless-shell-linux64');
        if (!fs.existsSync(path.join(unpacked, 'chrome-headless-shell'))) throw new Error('the download did not contain chrome-headless-shell');
        fs.renameSync(unpacked, path.join(BROWSER_DIR, 'chrome-headless-shell-linux64'));
        fs.rmSync(staging, { recursive: true, force: true });
        fs.chmodSync(INSTALLED_BIN, 0o755);

        // 4) can this server run it?
        await report('🧪 Checking that this server can run Chrome...');
        const missing = await missingLibs(INSTALLED_BIN);
        if (missing && missing.length) {
            throw Object.assign(new Error(`this server is missing ${missing.length} system libraries that Chrome needs`), { missing });
        }
        const version = await probe(INSTALLED_BIN);
        if (!version) throw new Error('Chrome was downloaded but does not start on this server');

        // 5) fonts, then a real test picture
        await report('🔤 Installing fonts...');
        const fonts = await installFonts();

        await report('📸 Taking a test screenshot...');
        const test = await chromeShot({ path: INSTALLED_BIN, version, kind: 'shell', installed: true }, TEST_PAGE, DEVICES[1], { timeout: 45000 });
        if (test.buffer.length < 2000) throw new Error('the test screenshot came out empty');

        fs.writeFileSync(path.join(BROWSER_DIR, 'install.json'), JSON.stringify({ version, fonts, date: new Date().toISOString() }));
        await findBrowser(true);
        return { version, fonts };
    } catch (err) {
        fs.rmSync(BROWSER_DIR, { recursive: true, force: true }); // never leave half an installation behind
        browserCache = undefined;
        throw err;
    } finally {
        installing = false;
    }
}

function uninstallBrowser() {
    const existed = fs.existsSync(BROWSER_DIR);
    fs.rmSync(BROWSER_DIR, { recursive: true, force: true });
    browserCache = undefined;
    return existed;
}

// text for `.ss status`
async function statusText() {
    const browser = await findBrowser(true);
    const memory = memoryState();
    const disk = freeDisk(BASE_DIR);
    const glibc = glibcVersion();
    const lines = ['🧰 *Screenshot engine*', ''];

    if (!LOCAL_CHROME) {
        lines.push('🌐 *Engine:* web API only (local Chrome is switched off with SS_LOCAL_CHROME)');
    } else if (browser) {
        lines.push(`✅ *Local Chrome:* ${browser.version} — ${browser.installed ? 'installed by the bot' : browser.path}`);
        lines.push('🌐 *Backups:* Microlink, then Google PageSpeed');
    } else {
        lines.push('⚠️ *Local Chrome:* not available');
        lines.push('🌐 *Engine in use:* Microlink, then Google PageSpeed');
    }

    lines.push('', `🖥️ *Server:* ${process.platform} ${process.arch} · Node ${process.version}${glibc ? ` · glibc ${glibc}` : ''}`);
    lines.push(`🧠 *Memory:* ${mb(memory.free)} free of ${mb(memory.limit)}${memory.limit < MIN_TOTAL_RAM_MB * MB ? '  ⚠️ too small for Chrome' : ''}`);
    if (disk !== null) lines.push(`💽 *Disk:* ${mb(disk)} free${disk < MIN_FREE_DISK_MB * MB ? '  ⚠️ too little to install Chrome' : ''}`);

    if (LOCAL_CHROME && !browser) {
        const missing = probablyMissingLibs();
        lines.push('');
        if (process.arch !== 'x64') lines.push('❌ Chrome downloads from Google only exist for x64 servers.');
        else if (missing.length) lines.push(`❌ *Probably missing system libraries:* ${missing.join(', ')}\nChrome will most likely not run here. Ask your hosting provider to install them, or keep using the web engine.`);
        else lines.push(`✅ The system libraries Chrome needs look available. Send *${PREFIX_HINT}ss install* to download Chrome.`);
    }
    return lines.join('\n');
}

// ═══════════════ PART 2 — the web engines (used when there is no local Chrome, or it fails) ═══════════════

// ---------- Microlink (real headless Chrome) ----------
async function fromMicrolink(url, device) {
    const endpoint = MICROLINK_KEY ? 'https://pro.microlink.io/' : 'https://api.microlink.io/';
    const { status, data } = await fetchJson(
        `${endpoint}?${query({
            url,
            screenshot: 'true',
            meta: 'false',
            device: device.microlink,                       // viewport + user agent of a real phone / laptop
            'viewport.deviceScaleFactor': String(device.scale),
        })}`,
        { headers: MICROLINK_KEY ? { 'x-api-key': MICROLINK_KEY } : {}, timeout: 90000 }
    );

    if (!data) throw new Error(`the service did not return JSON (HTTP ${status})`);
    if (data.status !== 'success') {
        if (data.code === 'ERATE') throw new Error("today's free screenshot limit has been reached (ERATE)");
        throw new Error(clean(`${data.code || 'error'} — ${data.message || `HTTP ${status}`}`));
    }

    const shot = data.data && data.data.screenshot;
    if (!shot || !shot.url) throw new Error('the service returned no screenshot');

    const image = await request(shot.url, { headers: { Accept: 'image/*' }, timeout: 60000 });
    const mime = String(image.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (image.status !== 200 || !/^image\//.test(mime)) {
        throw new Error(`could not download the screenshot (HTTP ${image.status})`);
    }

    return { buffer: image.body, mime, width: shot.width, height: shot.height, via: 'Microlink' };
}

// ---------- Google PageSpeed (backup) ----------
async function fromPageSpeed(url, device) {
    const { status, data } = await fetchJson(
        'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?' + query({
            url,
            strategy: device.strategy,
            category: 'performance',
            ...(PAGESPEED_KEY ? { key: PAGESPEED_KEY } : {}),
        }),
        { headers: {}, timeout: 120000 }
    );

    if (!data) throw new Error(`the service did not return JSON (HTTP ${status})`);
    if (status !== 200) throw new Error(clean(data.error && data.error.message, `HTTP ${status}`));

    const audit = data.lighthouseResult && data.lighthouseResult.audits && data.lighthouseResult.audits['final-screenshot'];
    const match = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec((audit && audit.details && audit.details.data) || '');
    if (!match) throw new Error('the service returned no screenshot');

    return { buffer: Buffer.from(match[2], 'base64'), mime: match[1], width: null, height: null, via: 'Google PageSpeed' };
}

// tries the engines one after the other
async function takeScreenshot(url, device) {
    const reasons = [];
    for (const [name, route] of [['Chrome', fromChrome], ['Microlink', fromMicrolink], ['PageSpeed', fromPageSpeed]]) {
        try {
            const shot = await route(url, device);
            if (!shot) continue; // this engine is not available right now
            if (!shot.buffer.length) throw new Error('the picture was empty');
            if (shot.buffer.length > MAX_IMAGE_MB * MB) throw new Error('the picture is too large');
            return shot;
        } catch (err) {
            console.error(`[ss] ${name} route failed:`, redact(err.message));
            reasons.push(`${name}: ${err.message}`);
        }
    }
    throw new Error(reasons.join(' | '));
}

// ═══════════════ PART 3 — the chat side ═══════════════
const pending = new Map();   // id of the bot's question → { url, expires, uses, busy }
const seen = new Set();      // ids of replies already handled
const hooked = new WeakSet();
let active = 0;

// the content of a message, without the "disappearing messages" / "view once" wrappers
function unwrap(message) {
    let current = message;
    for (let i = 0; i < 5 && current; i++) {
        const inner =
            (current.ephemeralMessage && current.ephemeralMessage.message) ||
            (current.viewOnceMessage && current.viewOnceMessage.message) ||
            (current.viewOnceMessageV2 && current.viewOnceMessageV2.message) ||
            (current.documentWithCaptionMessage && current.documentWithCaptionMessage.message);
        if (!inner) break;
        current = inner;
    }
    return current;
}

async function editMessage(conn, chat, key, text) {
    try {
        await conn.sendMessage(chat, { text, edit: key });
        return true;
    } catch {
        return false;
    }
}

async function runScreenshot(conn, msg, entry, choice) {
    const chat = msg.key.remoteJid;
    const device = DEVICES[choice];
    let host = entry.url;
    try { host = new URL(entry.url).hostname; } catch { /* keep the full link */ }

    let status = null;
    try {
        status = await conn.sendMessage(chat, { text: MSG.working(device, host) }, { quoted: msg });
    } catch { /* carry on without a status message */ }
    const statusKey = status && status.key;

    try {
        const shot = await takeScreenshot(entry.url, device);

        const caption =
            `${device.icon} *${device.name} view*\n` +
            `🔗 ${shorten(entry.url, 150)}` +
            (shot.width && shot.height ? `\n📐 ${shot.width} × ${shot.height}` : '') +
            (shot.via === 'Google PageSpeed' ? `\nℹ️ Backup renderer (${shot.via}) — lower quality` : '');

        await conn.sendMessage(chat, { image: shot.buffer, mimetype: shot.mime, caption }, { quoted: msg });

        // the "please wait" message is not needed any more
        if (statusKey) await conn.sendMessage(chat, { delete: statusKey }).catch(() => {});
    } catch (err) {
        console.error('[ss] failed:', redact(err.message));
        const text = MSG.failed(err.message);
        const edited = statusKey ? await editMessage(conn, chat, statusKey, text) : false;
        if (!edited) await conn.sendMessage(chat, { text }, { quoted: msg }).catch(() => {});
    }
}

async function handleIncoming(conn, msg) {
    if (!msg || !msg.key || !msg.message) return;

    // only a quoted text reply can answer the question
    const content = unwrap(msg.message);
    const reply = content && content.extendedTextMessage;
    const questionId = reply && reply.contextInfo && reply.contextInfo.stanzaId;
    if (!questionId) return;

    const entry = pending.get(questionId);
    if (!entry) return;
    if (Date.now() > entry.expires) {
        pending.delete(questionId);
        return;
    }

    const choice = parseChoice(reply.text);
    if (!choice) return;

    if (seen.has(msg.key.id)) return; // the same reply can be announced twice
    seen.add(msg.key.id);
    if (seen.size > 300) seen.delete(seen.values().next().value);

    const chat = msg.key.remoteJid;
    const say = (text) => conn.sendMessage(chat, { text }, { quoted: msg });

    if (entry.busy) return;
    if (entry.uses >= MAX_USES) return say(MSG.usedUp);
    if (active >= MAX_ACTIVE) return say(MSG.busy);

    entry.busy = true;
    entry.uses++;
    active++;
    try {
        await runScreenshot(conn, msg, entry, choice);
    } finally {
        entry.busy = false;
        active--;
    }
}

// listens for incoming messages on this connection (once per connection)
function ensureListener(conn) {
    if (!conn || !conn.ev || typeof conn.ev.on !== 'function' || hooked.has(conn)) return;
    hooked.add(conn);
    conn.ev.on('messages.upsert', (upsert) => {
        for (const msg of (upsert && upsert.messages) || []) {
            handleIncoming(conn, msg).catch((err) => console.error('[ss] reply handler error:', redact(err && err.message)));
        }
    });
}

// ---------- owner commands: install / status / uninstall ----------
async function ownerCommand(conn, mek, from, sub) {
    const say = (text) => conn.sendMessage(from, { text }, { quoted: mek });

    if (sub === 'status') return say(await statusText());

    if (sub === 'uninstall') {
        if (localBusy || installing) return say('⏳ Chrome is busy right now. Try again in a moment.');
        return say(uninstallBrowser() ? '🗑️ The downloaded Chrome was removed. Screenshots now use the web engines.' : 'ℹ️ There was no downloaded Chrome to remove.');
    }

    // install
    if (!LOCAL_CHROME) return say('ℹ️ Local Chrome is switched off (SS_LOCAL_CHROME=off).');
    if (installing) return say('⏳ An installation is already running.');
    const existing = await findBrowser(true);
    if (existing && existing.installed) return say(`✅ Chrome ${existing.version} is already installed.\nSend *${PREFIX_HINT}ss status* for details or *${PREFIX_HINT}ss uninstall* to remove it.`);
    if (localBusy) return say('⏳ A screenshot is being taken right now. Try again in a moment.');

    const first = await conn.sendMessage(from, { text: '🌐 *Installing Chrome*\n\n⏳ Starting...' }, { quoted: mek });
    const key = first && first.key;
    let lastEdit = 0;
    const report = async (text) => {
        if (Date.now() - lastEdit < 1500) return;       // do not flood the chat with edits
        lastEdit = Date.now();
        const body = `🌐 *Installing Chrome*\n\n${text}`;
        if (!(key && await editMessage(conn, from, key, body))) await conn.sendMessage(from, { text: body }).catch(() => {});
    };
    const finish = async (text) => {
        if (!(key && await editMessage(conn, from, key, text))) await conn.sendMessage(from, { text }).catch(() => {});
    };

    try {
        const { version, fonts } = await installBrowser(report);
        await finish(
            `✅ *Chrome ${version} is installed and working!*\n\n` +
            `🔤 Fonts: ${fonts.length} of ${FONT_FILES.length} installed\n` +
            (fonts.length ? '' : '⚠️ No font could be downloaded, so text may be missing in screenshots on a server without fonts.\n') +
            `📸 *${PREFIX_HINT}ss <link>* now uses it first. The web engines stay as a backup.`
        );
    } catch (err) {
        console.error('[ss] install failed:', redact(err.message));
        const libs = err.missing && err.missing.length
            ? `\n\n📚 *Missing libraries:* ${err.missing.slice(0, 12).join(', ')}${err.missing.length > 12 ? ` …and ${err.missing.length - 12} more` : ''}\n` +
              'Chrome cannot run on this server until your hosting provider installs them. The downloaded files were removed.'
            : '\n\nThe downloaded files were removed.';
        await finish(`❌ *Could not install Chrome.*\n\n🔎 *Reason:* ${shorten(redact(err.message), 300)}${libs}\n\n🌐 Screenshots keep working through the web engines.`);
    }
}

// ─────────────── the command ───────────────
cmd({
    pattern: 'ss',
    desc: 'Take a screenshot of a website (mobile or PC view)',
    use: '.ss <website link>',
    category: 'tools',
    react: '📸',
    filename: __filename,
    // [gf-integration] she can take screenshots when asked ("take a screenshot of https://example.com").
    // claimReplies: the "1 = mobile / 2 = PC" answer is for this plugin, not a chat message for her.
    claimReplies: true,
    gf: { arg: 'url', req: true, hint: 'website screenshot', keywords: ['screenshot', 'screen shot', 'ස්ක්‍රීන්ෂොට්', 'ස්ක්‍රීන් ෂොට්', 'ස්ක්‍රීන්ශොට්'] },
},
async (conn, mek, m, { from, q, isOwner, senderNumber }) => {
    ensureListener(conn);

    const say = (text) => conn.sendMessage(from, { text }, { quoted: mek });

    try {
        const arg = String(q || '').trim();
        if (!arg) return await say(MSG.usage);

        // .ss install | status | uninstall — owner only
        const sub = arg.toLowerCase().split(/\s+/)[0];
        if (['install', 'status', 'uninstall'].includes(sub)) {
            const admin = isOwner === true || (mek.key && mek.key.fromMe === true) ||
                ADMIN_NUMBERS.some((n) => String(senderNumber || (mek.key && mek.key.participant) || from).includes(n));
            if (!admin) return await say(MSG.adminOnly);
            return await ownerCommand(conn, mek, from, sub);
        }

        const url = normalizeUrl(arg);
        if (!url) return await say(MSG.invalid);

        const question = await say(MSG.ask(url));
        const id = question && question.key && question.key.id;
        if (!id) return await say(MSG.error);

        if (pending.size >= 500) pending.delete(pending.keys().next().value);
        pending.set(id, { url, expires: Date.now() + ASK_TIMEOUT_MS, uses: 0, busy: false });

        const timer = setTimeout(() => pending.delete(id), ASK_TIMEOUT_MS + 1000);
        if (timer.unref) timer.unref();
    } catch (err) {
        console.error('[ss] error:', redact(err && err.message));
        say(MSG.error).catch(() => {});
    }
});

// exported so the same logic can be reused/tested outside the command
module.exports = { normalizeUrl, parseChoice, unzip, chromeShot, findBrowser, installBrowser, DEVICES };
