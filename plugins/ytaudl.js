/**
 * ───────────────────────────────────────────────────────────────
 *  YouTube downloader — WhatsApp bot
 * ───────────────────────────────────────────────────────────────
 *  Commands:
 *    .ytdl <words | link> [jid/lid]  → search YouTube, pick a result with buttons, then choose
 *                                      Audio / Voice note / Video  (video: quality + Document / Video)
 *    .ytaudl <link> [jid/lid]        → downloads as audio file
 *    .ytvcdl <link> [jid/lid]        → downloads as voice note (ptt)
 *    .ytvdl <link> [jid/lid]         → downloads as video (buttons: quality, then Document / Video)
 *    .ytaudl stop [jid/lid]          → cancel a running download (also .ytvcdl stop / .ytvdl stop)
 *
 *  Links that work:
 *    • a video link                      → that one video
 *    • a playlist link                   → every video of the playlist
 *    • an auto-generated YouTube Mix     → (list=RD…) the videos of the Mix
 *    • a video link that also has a list → only the video, add "all" to get the whole list
 *        .ytaudl "https://www.youtube.com/watch?v=xxxxxxxxxxx&list=RDxxxxxxxxxxx" all
 *
 *  Voice notes need ffmpeg (OGG/Opus). No ffmpeg on your host?  →  npm i ffmpeg-static
 *  Buttons not showing?  →  change BUTTON_STYLE below (every menu can also be answered with a number).
 * ───────────────────────────────────────────────────────────────
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);
const { cmd } = require('../command'); // ← change this path if needed

// ─────────────── settings ───────────────
const API_BASE = process.env.WOLVAREX_API_BASE || 'https://apix.wolvarex.com/api/music/ytmp3-net-download';
const API_PROVIDER = 'ytmp3';
const API_KEY = process.env.WOLVAREX_API_KEY || 'wxa_f_ee1166962c';

const PREFIX_HINT         = '.';
const MAX_PLAYLIST_TRACKS = 100;
const MAX_MIX_PAGES       = 10;  // a Mix never really ends, so this is a safety stop when reading one
const MAX_FILE_MB         = 100;
const AUDIO_MAX_MB        = 15;
const MAX_FAILS_IN_A_ROW  = 5;
const MAX_JOBS_AT_ONCE    = 2;
const CHUNK_BYTES         = 1000000;
const SHOW_ERROR_REASON   = true;
const API_RETRY_DELAY_MS  = 5000;
const API_MAX_RETRIES     = 3; // Attempts increased
const PROGRESS_STEP       = 20;

// ─────────────── video / search / button settings ───────────────
const PODDAX_BASE          = process.env.PODDAX_API_BASE || 'https://poddax-api.dev';
const PODDAX_NAME          = 'Poddax API';
const MAX_VIDEO_MB         = 100;  // biggest video the bot will download and send (qualities above it are not offered)
const MAX_VIDEO_PLAYLIST   = 20;   // .ytvdl with a playlist link: how many videos at most
const MAX_SEARCH_RESULTS   = 10;   // .ytdl: results shown (WhatsApp lists hold 10 rows at most)
const VIDEO_DL_RETRIES     = 3;    // a broken video download is resumed this many times
const SHOW_VIDEO_SIZES     = true; // check the file size of every quality so it can be shown on the button
const SESSION_TTL_MS       = 10 * 60 * 1000; // how long the buttons of a menu stay active

// How the choice menus (buttons) are sent. Whatever you pick, every menu also lists its options as
// 1, 2, 3 … and the person can answer by replying to the menu with the number, so the commands keep
// working even where buttons do not show up.
//   'auto'        → 'native' (when the connection has relayMessage), otherwise 'legacy'
//   'native'      → WhatsApp interactive quick-reply buttons / list, relayed with the biz/bot nodes
//                   (works on a plain @whiskeysockets/baileys, no extra package needed)
//   'native-vo'   → the same, wrapped in a view-once envelope (try this if 'native' shows nothing)
//   'interactive' → conn.sendMessage({ interactiveButtons }) — for Baileys forks / helper packages that
//                   already add interactive-button support themselves
//   'legacy'      → the old buttons / list message (conn.sendMessage({ buttons }) / sections)
//   'text'        → no buttons at all, numbered text menus only
const BUTTON_STYLE = 'auto';
const MENU_FOOTER  = 'YouTube Downloader';

// ─────────────── anti-ban timings ───────────────
const TRACK_DELAY_MIN_MS   = 8000;
const TRACK_DELAY_MAX_MS   = 18000;
const MESSAGE_GAP_MIN_MS   = 700;
const MESSAGE_GAP_MAX_MS   = 1800;
const PRESENCE_ENABLED     = true;

// ─────────────── helpers ───────────────
const VIDEO_ID = /^[\w-]{11}$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min));
const randomDelay = (min, max) => sleep(randomBetween(min, max));
const cut = (text, max) => Array.from(text).slice(0, max).join('');
const shorten = (text, max) => (Array.from(text).length > max ? `${cut(text, max - 1)}…` : text);
const clean = (value, fallback = '') => String(value ?? '').replace(/\s+/g, ' ').trim() || fallback;
const safeFileName = (name) =>
    cut(String(name).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '').replace(/\s+/g, ' ').trim(), 80) || 'audio';
const formatBytes = (n) =>
    n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const redact = (text) => (API_KEY ? String(text).split(API_KEY).join('***') : String(text));
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

// ─────────────── visual helpers ───────────────
const progressBar = (percent, width = 14) => {
    const p = Math.max(0, Math.min(100, percent));
    const filled = Math.round((p / 100) * width);
    return '■'.repeat(filled) + '□'.repeat(width - filled);
};

async function interruptibleDelay(ms, isCancelled) {
    const step = 500;
    let left = Math.max(0, ms);
    while (left > 0) {
        if (isCancelled && isCancelled()) return;
        const chunk = Math.min(step, left);
        await sleep(chunk);
        left -= chunk;
    }
}

async function humanPresence(conn, targetJid, minMs = MESSAGE_GAP_MIN_MS, maxMs = MESSAGE_GAP_MAX_MS) {
    if (!PRESENCE_ENABLED) {
        await randomDelay(minMs, maxMs);
        return;
    }
    try {
        if (conn.sendPresenceUpdate) {
            await conn.sendPresenceUpdate('composing', targetJid).catch(() => {});
        }
    } catch { /* ignore */ }
    await randomDelay(minMs, maxMs);
    try {
        if (conn.sendPresenceUpdate) {
            await conn.sendPresenceUpdate('paused', targetJid).catch(() => {});
        }
    } catch { /* ignore */ }
}

async function editMessage(conn, targetJid, key, text) {
    if (!key) return false;
    try {
        await conn.sendMessage(targetJid, { text, edit: key });
        return true;
    } catch {
        return false;
    }
}

async function withRetry(fn, attempts = 3) {
    let lastError;
    for (let i = 1; i <= attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const permanent = err.status && err.status < 500 && err.status !== 429;
            if (permanent || i === attempts) break;
            await sleep(800 * i);
        }
    }
    throw lastError;
}

// ─────────────── bot messages ───────────────
const MSG = {
    usage: (cmdName) => '❌ *Please provide a YouTube video or playlist link.*\n\n' +
        '📌 *Examples:*\n' +
        `${PREFIX_HINT}${cmdName} https://youtu.be/xxxxxxxxxxx\n` +
        `${PREFIX_HINT}${cmdName} https://www.youtube.com/playlist?list=PLxxxxxxxxxxxxxxxx\n` +
        `${PREFIX_HINT}${cmdName} <link> 12345@g.us  (send to another chat)\n\n` +
        `ℹ️ A video link that also contains a playlist/Mix downloads only the video — add *all* to get the whole list:\n` +
        `${PREFIX_HINT}${cmdName} <link> all\n\n` +
        (cmdName === 'ytvdl' ? '🎞️ You will get buttons to choose the *quality* and *Document / Video*.\n\n' : '') +
        `🛑 Send *${PREFIX_HINT}${cmdName} stop* to cancel a running download.`,
    searchUsage: '❌ *Please type what you want to search for.*\n\n' +
        '📌 *Examples:*\n' +
        `${PREFIX_HINT}ytdl suzume\n` +
        `${PREFIX_HINT}ytdl https://youtu.be/xxxxxxxxxxx\n` +
        `${PREFIX_HINT}ytdl <words> 12345@g.us  (send to another chat)\n\n` +
        'ℹ️ You will get buttons to pick the video and to choose *Audio / Voice note / Video*.',
    searchPlaylistLink: `ℹ️ ${PREFIX_HINT}ytdl is for single videos. For a playlist link use *${PREFIX_HINT}ytaudl*, *${PREFIX_HINT}ytvcdl* or *${PREFIX_HINT}ytvdl*.`,
    searching: (q) => `🔎 Searching YouTube for *${shorten(q, 60)}*...`,
    noResults: (q) => `⚠️ No videos were found for *${shorten(q, 60)}*.`,
    searchFailed: (r) => `❌ *YouTube search failed.*${MSG.reason(r)}`,
    qualityFetching: '⏳ Getting the available video qualities...',
    qualitiesFailed: (r) => `❌ *Could not get the video qualities.*${MSG.reason(r)}`,
    allTooLarge: `⚠️ Every quality of this video is bigger than ${MAX_VIDEO_MB} MB, so it cannot be sent.`,
    expired: '⌛ This menu has expired. Please send the command again.',
    noButtons: '❌ Menus are not available here (the bot connection has no event listener).',
    invalid: '❌ *That does not look like a valid YouTube video or playlist link.*\n\nPlease check the link and try again.',
    busy: (cmdName = 'ytaudl') => '⏳ A download is already running in the target chat.\n\n' +
        `Please wait for it to finish, or send *${PREFIX_HINT}${cmdName} stop* to cancel it.`,
    tooManyJobs: '⏳ The bot is busy with other downloads right now. Please try again in a few minutes.',
    nothingRunning: 'ℹ️ There is no running download in the target chat.',
    stopping: '🛑 Stopping... the current track will finish first.',
    playlistFetching: '⏳ Reading the playlist, please wait...',
    playlistEmpty: '⚠️ No available videos were found in this playlist.',
    error: '❌ Something went wrong while processing your request. Please try again later.',
    reason: (r) => (SHOW_ERROR_REASON && r ? `\n\n🔎 *Reason:* ${shorten(redact(r), 350)}` : ''),
    videoFailed: (r, mode) => `❌ *Could not download this ${mode === 'video' ? 'video' : 'audio'}.*${MSG.reason(r)}`,
    playlistFailed: (r) => `❌ *Could not read this playlist.*${MSG.reason(r)}\n\n` +
        'It may be private or deleted.',
};

// ─────────────── link parsing ───────────────
function extractVideoId(input) {
    const text = String(input || '').trim().split(/\s+/)[0];
    if (!text) return null;
    try {
        const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
        const host = url.hostname.replace(/^(www|m|music)\./, '');
        let id = null;
        if (host === 'youtu.be') {
            id = url.pathname.split('/')[1];
        } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
            if (url.pathname === '/watch') {
                id = url.searchParams.get('v');
            } else {
                const m = /^\/(?:shorts|live|embed|v)\/([\w-]{11})/.exec(url.pathname);
                id = m && m[1];
            }
        }
        return id && VIDEO_ID.test(id) ? id : null;
    } catch {
        return null;
    }
}

function extractPlaylistId(input) {
    const text = String(input || '').trim().split(/\s+/)[0];
    if (!text) return null;
    if (/^(PL|UU|FL|OLAK5uy_)[\w-]{10,}$/.test(text)) return text;
    try {
        const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
        const host = url.hostname.replace(/^(www|m|music)\./, '');
        if (!['youtube.com', 'youtu.be'].includes(host)) return null;
        const list = url.searchParams.get('list');
        return list && /^[\w-]{10,}$/.test(list) ? list : null;
    } catch {
        return null;
    }
}

// ─────────────── tiny HTTP client ───────────────
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const COOKIES = 'SOCS=CAI; CONSENT=YES+1';

function unzip(encoding, buffer) {
    switch (String(encoding || '').toLowerCase()) {
        case 'gzip':    return zlib.gunzipSync(buffer);
        case 'deflate': return zlib.inflateSync(buffer);
        case 'br':      return zlib.brotliDecompressSync(buffer);
        default:        return buffer;
    }
}

// Timeout default increased to 60 seconds to prevent "request timed out" error
function request(url, { method = 'GET', headers = {}, body = null, redirects = 5, timeout = 60000 } = {}) {
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
            method,
            timeout,
            headers: {
                'User-Agent': USER_AGENT,
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip',
                ...(/(^|\.)youtube\.com$/.test(target.hostname) ? { Cookie: COOKIES } : {}),
                ...headers,
                ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
            },
        }, (res) => {
            const status = res.statusCode;
            if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects > 0) {
                res.resume();
                const keep = status === 307 || status === 308;
                return resolve(request(new URL(res.headers.location, url).toString(), {
                    method: keep ? method : 'GET',
                    headers,
                    body: keep ? body : null,
                    redirects: redirects - 1,
                    timeout,
                }));
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('error', reject);
            res.on('close', () => {
                if (!res.complete) reject(new Error('the connection was closed early'));
            });
            res.on('end', () => {
                try {
                    const buffer = unzip(res.headers['content-encoding'], Buffer.concat(chunks));
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
        if (body) req.write(body);
        req.end();
    });
}

// ═══════════════ PART 1 — reading a YouTube playlist ═══════════════
const DEFAULT_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

function defaultConfig() {
    const d = new Date(Date.now() - 10 * 86400000);
    const pad = (n) => String(n).padStart(2, '0');
    return {
        apiKey: DEFAULT_API_KEY,
        clientVersion: `2.${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}.00.00`,
        visitorData: '',
    };
}

function readConfig(html) {
    const pick = (re) => (re.exec(html) || [])[1];
    const found = {
        apiKey: pick(/"INNERTUBE_API_KEY":"([^"]+)"/),
        clientVersion:
            pick(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/) ||
            pick(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/),
        visitorData: pick(/"VISITOR_DATA":"([^"]+)"/) || pick(/"visitorData":"([^"]+)"/),
    };
    return Object.fromEntries(Object.entries(found).filter(([, value]) => value));
}

function extractInitialData(html) {
    const match = /ytInitialData"?\]?\s*=\s*\{/.exec(html);
    if (!match) return null;
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < html.length; i++) {
        const ch = html[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
        } else if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            depth++;
        } else if (ch === '}' && --depth === 0) {
            return JSON.parse(html.slice(start, i + 1));
        }
    }
    return null;
}

// calls one of YouTube's own API endpoints: "browse" = playlist pages, "next" = the up-next panel of a watch page
async function callApi(endpoint, cfg, payload) {
    const res = await request(
        `https://www.youtube.com/youtubei/v1/${endpoint}?key=${encodeURIComponent(cfg.apiKey)}&prettyPrint=false`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: '*/*',
                Origin: 'https://www.youtube.com',
                Referer: 'https://www.youtube.com/',
                'X-YouTube-Client-Name': '1',
                'X-YouTube-Client-Version': cfg.clientVersion,
            },
            body: JSON.stringify({
                context: {
                    client: {
                        clientName: 'WEB',
                        clientVersion: cfg.clientVersion,
                        hl: 'en',
                        gl: 'US',
                        ...(cfg.visitorData ? { visitorData: cfg.visitorData } : {}),
                    },
                },
                ...payload,
            }),
        }
    );
    if (res.status !== 200) throw new Error(`YouTube API returned HTTP ${res.status}`);
    return JSON.parse(res.text);
}

const browse = (cfg, payload) => callApi('browse', cfg, payload);

const runsText = (t) => {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (t.simpleText) return t.simpleText;
    if (Array.isArray(t.runs)) return t.runs.map((run) => run.text).join('');
    return t.content || '';
};

function findFirst(node, key) {
    if (!node || typeof node !== 'object') return undefined;
    if (!Array.isArray(node) && key in node) return node[key];
    for (const k of Object.keys(node)) {
        const found = findFirst(node[k], key);
        if (found !== undefined) return found;
    }
    return undefined;
}

const isVideoNode = (n) =>
    !!(n && (
        n.playlistVideoRenderer ||
        n.reelItemRenderer ||
        (n.lockupViewModel && n.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO')
    ));

function toVideo(node) {
    let id;
    let title = '';
    let unavailable = false;
    let entryId = null;

    if (node.playlistVideoRenderer) {
        const r = node.playlistVideoRenderer;
        id = r.videoId;
        title = runsText(r.title);
        unavailable = r.isPlayable === false;
        entryId = r.setVideoId || null;
    } else if (node.reelItemRenderer) {
        const r = node.reelItemRenderer;
        id = r.videoId;
        title = runsText(r.headline);
    } else {
        const l = node.lockupViewModel;
        id = l.contentId;
        title = runsText(l.metadata && l.metadata.lockupMetadataViewModel && l.metadata.lockupMetadataViewModel.title);
    }

    if (!VIDEO_ID.test(id || '')) return null;
    title = clean(title, 'Untitled video');
    if (/^\[(deleted|private|unavailable)[^\]]*\]$/i.test(title)) unavailable = true;
    return { id, title, unavailable, entryId };
}

function scan(root) {
    const videos = [];
    let listToken = null;
    let anyToken = null;

    const tokenOf = (n) => {
        const item = n && n.continuationItemRenderer;
        const command = item && findFirst(item, 'continuationCommand');
        return (command && command.token) || null;
    };

    const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            const holdsVideos = node.some(isVideoNode);
            for (const item of node) {
                if (holdsVideos) listToken = tokenOf(item) || listToken;
                visit(item);
            }
            return;
        }
        if (isVideoNode(node)) {
            const video = toVideo(node);
            if (video) videos.push(video);
            return;
        }
        anyToken = tokenOf(node) || anyToken;
        for (const key of Object.keys(node)) visit(node[key]);
    };

    visit(root);
    return { videos, token: listToken || anyToken };
}

function readInfo(data) {
    return {
        title: clean(
            (data.metadata && data.metadata.playlistMetadataRenderer && data.metadata.playlistMetadataRenderer.title) ||
            runsText(data.header && data.header.playlistHeaderRenderer && data.header.playlistHeaderRenderer.title) ||
            (data.microformat && data.microformat.microformatDataRenderer && data.microformat.microformatDataRenderer.title)
        ),
        alert: clean(runsText(findFirst(data.alerts, 'text'))),
    };
}

async function loadFirstPage(listId) {
    let cfg = defaultConfig();
    const errors = [];
    const candidates = [];

    const usable = (data) => {
        const candidate = { data, first: scan(data), info: readInfo(data) };
        candidates.push(candidate);
        const { first, info } = candidate;
        return first.videos.length || first.token || info.alert ? candidate : null;
    };

    try {
        const res = await request(
            `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}&hl=en&gl=US`,
            { headers: { Accept: 'text/html,application/xhtml+xml' } }
        );
        cfg = { ...cfg, ...readConfig(res.text) };
        if (/consent\.(youtube|google)\.com/.test(res.url)) {
            throw new Error('YouTube showed a cookie-consent page to this server');
        }
        if (res.status === 429 || /google\.com\/sorry/.test(res.url)) {
            throw new Error('YouTube is rate-limiting this server (HTTP 429)');
        }
        const data = extractInitialData(res.text);
        if (!data) throw new Error(`playlist data not found in the page (HTTP ${res.status})`);
        const hit = usable(data);
        if (hit) return { ...hit, cfg };
        errors.push('web page had no video list');
    } catch (err) {
        errors.push(`web page: ${err.message}`);
    }

    try {
        const hit = usable(await browse(cfg, { browseId: `VL${listId}` }));
        if (hit) return { ...hit, cfg };
        errors.push('API had no video list');
    } catch (err) {
        errors.push(`API: ${err.message}`);
    }

    const titled = candidates.find((c) => c.info.title);
    if (titled) return { ...titled, cfg };
    throw new Error(errors.join(' | ') || 'YouTube returned no playlist data');
}

// a normal playlist (list=PL…, UU…, FL…, OLAK5uy_…)
async function fetchStandardPlaylist(listId, limit = MAX_PLAYLIST_TRACKS) {
    const { first, info, cfg } = await loadFirstPage(listId);
    if (!first.videos.length && info.alert) throw new Error(info.alert);

    const playlist = {
        title: info.title || 'Untitled playlist',
        videos: [],
        skipped: 0,
        truncated: false,
    };

    const seen = new Set();
    const add = (list) => {
        let fresh = 0;
        for (const video of list) {
            if (video.entryId) {
                if (seen.has(video.entryId)) continue;
                seen.add(video.entryId);
            }
            fresh++;
            if (video.unavailable) playlist.skipped++;
            else if (playlist.videos.length < limit) playlist.videos.push(video);
            else playlist.truncated = true;
        }
        return fresh;
    };

    add(first.videos);

    let token = first.token;
    const usedTokens = new Set();
    try {
        while (token && !usedTokens.has(token)) {
            if (playlist.videos.length >= limit) {
                playlist.truncated = true;
                break;
            }
            usedTokens.add(token);
            const page = scan(await browse(cfg, { continuation: token }));
            if (add(page.videos) === 0) break;
            token = page.token;
        }
    } catch (err) {
        console.error('[ytaudl] loading a later playlist page failed:', redact(err.message));
    }
    return playlist;
}

// ═══════════════ PART 1b — YouTube Mix (auto-generated "RD…" playlists) ═══════════════
// A Mix cannot be opened as a playlist page ("This playlist type is unviewable").
// Its videos live in the "up next" panel of the watch page, so we read that panel and
// then keep asking YouTube for the next batch (the same way yt-dlp does).

const isMixId = (listId) => /^RD/.test(listId);

// RD<videoId> and RDAMVM<videoId> are built from one video; other Mix types have no seed video
function mixSeed(listId, hintVideoId) {
    const m = /^RD(?:AMVM)?([\w-]{11})$/.exec(listId);
    return (m && m[1]) || hintVideoId || null;
}

// reads the "up next" panel of a watch page / of a "next" API answer
function readPanel(data) {
    const watch = data && data.contents && data.contents.twoColumnWatchNextResults;
    const panel = watch && watch.playlist && watch.playlist.playlist;
    if (!panel) return null;

    const videos = [];
    let lastEndpoint = null;
    for (const item of panel.contents || []) {
        const wrapper = item && item.playlistPanelVideoWrapperRenderer;
        const r = (item && item.playlistPanelVideoRenderer) ||
            (wrapper && wrapper.primaryRenderer && wrapper.primaryRenderer.playlistPanelVideoRenderer);
        if (!r || !VIDEO_ID.test(r.videoId || '')) continue;

        const title = clean(runsText(r.title), 'Untitled video');
        videos.push({
            id: r.videoId,
            title,
            unavailable: !!r.unplayableText || /^\[(deleted|private|unavailable)[^\]]*\]$/i.test(title),
            entryId: null,
        });
        lastEndpoint = (r.navigationEndpoint && r.navigationEndpoint.watchEndpoint) || lastEndpoint;
    }
    return { title: clean(runsText(panel.title)), videos, lastEndpoint };
}

// first batch of a Mix: the watch page of the seed video, then the "next" API as a backup
async function loadMixStart(listId, seed) {
    let cfg = defaultConfig();
    const errors = [];

    if (seed) {
        try {
            const res = await request(
                `https://www.youtube.com/watch?v=${encodeURIComponent(seed)}&list=${encodeURIComponent(listId)}&hl=en&gl=US`,
                { headers: { Accept: 'text/html,application/xhtml+xml' } }
            );
            cfg = { ...cfg, ...readConfig(res.text) };
            if (/consent\.(youtube|google)\.com/.test(res.url)) {
                throw new Error('YouTube showed a cookie-consent page to this server');
            }
            if (res.status === 429 || /google\.com\/sorry/.test(res.url)) {
                throw new Error('YouTube is rate-limiting this server (HTTP 429)');
            }
            const data = extractInitialData(res.text);
            const panel = data && readPanel(data);
            if (panel && panel.videos.length) return { panel, cfg };
            errors.push('watch page had no Mix list');
        } catch (err) {
            errors.push(`watch page: ${err.message}`);
        }
    }

    try {
        const payload = seed
            ? { videoId: seed, playlistId: listId, params: 'OAE%3D' }
            : { playlistId: listId };
        const panel = readPanel(await callApi('next', cfg, payload));
        if (panel && panel.videos.length) return { panel, cfg };
        errors.push('API had no Mix list');
    } catch (err) {
        errors.push(`API: ${err.message}`);
    }

    throw new Error(errors.join(' | '));
}

async function fetchMix(listId, seed, limit = MAX_PLAYLIST_TRACKS) {
    const { panel: firstPanel, cfg } = await loadMixStart(listId, seed);

    const playlist = {
        title: firstPanel.title || 'YouTube Mix',
        videos: [],
        skipped: 0,
        truncated: false,
    };

    const seen = new Set();
    const add = (list) => {
        let fresh = 0;
        for (const video of list) {
            if (seen.has(video.id)) continue;
            seen.add(video.id);
            fresh++;
            if (video.unavailable) playlist.skipped++;
            else if (playlist.videos.length < limit) playlist.videos.push(video);
            else playlist.truncated = true;
        }
        return fresh;
    };

    add(firstPanel.videos);

    // keep asking for the next batch (each answer repeats the last video, then continues)
    let panel = firstPanel;
    try {
        for (let page = 1; page <= MAX_MIX_PAGES; page++) {
            if (playlist.videos.length >= limit) {
                playlist.truncated = true;
                break;
            }
            const last = panel.videos[panel.videos.length - 1];
            if (!last) break;

            const end = panel.lastEndpoint || {};
            const next = readPanel(await callApi('next', cfg, {
                playlistId: listId,
                videoId: end.videoId || last.id,
                index: end.index || panel.videos.length,
                params: end.params || 'OAE%3D',
            }));
            if (!next || !next.videos.length || add(next.videos) === 0) break; // nothing new → ended or looped
            panel = next;
        }
    } catch (err) {
        console.error('[ytaudl] loading the next batch of the Mix failed:', redact(err.message));
    }

    return playlist;
}

// any playlist: normal ones are read as a page, auto-generated Mixes through the watch page
async function fetchPlaylist(listId, limit = MAX_PLAYLIST_TRACKS, hintVideoId = null) {
    if (isMixId(listId)) return fetchMix(listId, mixSeed(listId, hintVideoId), limit);

    try {
        return await fetchStandardPlaylist(listId, limit);
    } catch (err) {
        // other auto-generated playlist types are "unviewable" as a page too → try the Mix way
        if (/unviewable/i.test(err.message)) {
            try {
                return await fetchMix(listId, mixSeed(listId, hintVideoId), limit);
            } catch (mixErr) {
                throw new Error(`${err.message} | Mix: ${mixErr.message}`);
            }
        }
        throw err;
    }
}

// ═══════════════ PART 2 — Wolvarex API ═══════════════

const urlParam = (url, name) => {
    try { return new URL(url).searchParams.get(name) || ''; } catch { return ''; }
};

async function fetchTitle(videoId) {
    try {
        const res = await request(
            `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://youtu.be/${videoId}`)}`,
            { headers: { Accept: 'application/json' }, timeout: 15000 }
        );
        if (res.status !== 200) return null;
        return clean(JSON.parse(res.text).title) || null;
    } catch {
        return null;
    }
}

// Timeouts and connection resets treated as temporary (triggering retry)
function isTemporary(err) {
    const s = err && err.status;
    const msg = String(err && err.message || '').toLowerCase();
    return s === 403 || s === 429 || (s >= 500 && s < 600) || 
           msg.includes('timed out') || msg.includes('timeout') || 
           msg.includes('etimedout') || msg.includes('econnreset');
}

async function fetchAudioInfo(videoId, { onRetry, onInfo } = {}) {
    const apiUrl =
        `${API_BASE}?id=${encodeURIComponent(videoId)}` +
        `&provider=${encodeURIComponent(API_PROVIDER)}` +
        `&key=${encodeURIComponent(API_KEY)}`;

    const titlePromise = fetchTitle(videoId);

    let lastErr;
    for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            if (onRetry) await onRetry(attempt).catch(() => {});
            await sleep(API_RETRY_DELAY_MS * attempt);
        }

        try {
            // Increased timeout here to prevent API timeouts
            const r = await request(apiUrl, {
                headers: { Accept: 'application/json' },
                timeout: 45000, 
            });

            if (r.status === 403 || r.status === 429) {
                lastErr = httpError(r.status);
                continue;
            }
            if (r.status >= 500) {
                lastErr = httpError(r.status);
                continue;
            }

            let data;
            try {
                data = JSON.parse(r.text);
            } catch {
                throw new Error(`the API did not return JSON (HTTP ${r.status})`);
            }

            if (r.status !== 200 || data.success === false) {
                throw new Error(clean(
                    data.message || data.error || data.msg,
                    `the API refused the request (HTTP ${r.status})`
                ));
            }

            const links = [];
            const seen = new Set();
            const pushLink = (u) => {
                if (typeof u === 'string' && /^https?:\/\//i.test(u) && !seen.has(u)) {
                    seen.add(u);
                    links.push({ url: u });
                }
            };

            if (data.downloadURL) pushLink(data.downloadURL);
            if (data.proxyURL) pushLink(data.proxyURL);
            if (Array.isArray(data.formats)) {
                for (const f of data.formats) {
                    if (f && (f.url || f.downloadUrl)) pushLink(f.url || f.downloadUrl);
                }
            }

            if (!links.length) throw new Error('the API returned no download link');

            const title = (await titlePromise) || null;
            const meta = {
                title: title || `YouTube audio ${videoId}`,
                size: clean(data.size) || '',
                type: clean(data.format) || 'MP3',
                creator: clean(data.powered_by) || 'Wolvarex API',
                thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            };

            if (onInfo) await onInfo(meta).catch(() => {});
            return { links, meta };

        } catch (err) {
            if (isTemporary(err)) {
                lastErr = err;
                continue;
            }
            throw err;
        }
    }

    if (lastErr && lastErr.status === 403) {
        throw new Error(
            `the API returned HTTP 403 (rate-limited or blocked). ` +
            `Please wait a few minutes and try again, or try a different song.`
        );
    }
    throw lastErr || new Error('the API returned no usable audio link');
}

// ─────────────── downloading ───────────────
const EXTENSIONS = { 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/aac': 'aac' };

// some servers say "audio/mp3" or "audio/x-m4a" — WhatsApp wants the standard names
function normalizeAudioMime(mime) {
    const m = String(mime || '').toLowerCase().trim();
    if (m === 'audio/mp3' || m === 'audio/x-mp3' || m === 'audio/x-mpeg') return 'audio/mpeg';
    if (m === 'audio/x-m4a' || m === 'audio/m4a') return 'audio/mp4';
    return m;
}

function mimeOf(headers, url) {
    const header = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (/^(audio|video)\//.test(header)) return normalizeAudioMime(header.replace(/^video\//, 'audio/'));
    return normalizeAudioMime(urlParam(url, 'mime')) || 'audio/mpeg';
}

async function fetchPiece(url, start, headers) {
    return withRetry(async () => {
        const r = await request(url, { headers: { ...headers, Range: `bytes=${start}-${start + CHUNK_BYTES - 1}` } });
        if (r.status !== 200 && r.status !== 206) throw httpError(r.status);

        if (r.status === 206) {
            const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(r.headers['content-range'] || '').trim());
            if (!m || Number(m[1]) !== start || Number(m[2]) - Number(m[1]) + 1 !== r.body.length) {
                throw new Error('the server sent a damaged piece of the file');
            }
            r.total = m[3] === '*' ? null : Number(m[3]);
        } else {
            if (start !== 0) throw new Error('the server ignored the byte range');
            r.total = r.body.length;
        }
        return r;
    });
}

async function downloadToFile(url, dest, { userAgent = USER_AGENT, onProgress } = {}) {
    const maxBytes = MAX_FILE_MB * 1048576;
    const headers = {
        'User-Agent': userAgent,
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        Referer: 'https://apix.wolvarex.com/',
    };

    await fs.promises.writeFile(dest, '');

    let current = url;
    let written = 0;
    let total = null;
    let mime = 'audio/mpeg';

    while (total === null || written < total) {
        const piece = await fetchPiece(current, written, headers);
        current = piece.url;

        if (total === null) {
            const type = String(piece.headers['content-type'] || '').toLowerCase();
            const first = piece.body.slice(0, 1).toString();
            if (/^text\/|json/.test(type) || first === '<' || first === '{') {
                throw new Error('the server sent text instead of audio');
            }
            mime = mimeOf(piece.headers, url);
            total = piece.total || Number(urlParam(url, 'clen')) || null;
            if (!total) throw new Error('could not work out the file size');
            if (total > maxBytes) {
                throw Object.assign(new Error(`the file is too large (${formatBytes(total)})`), { tooLarge: true });
            }
        }

        if (!piece.body.length) throw new Error('received an empty piece of the file');
        await fs.promises.appendFile(dest, piece.body);
        written += piece.body.length;

        if (onProgress && total) {
            const percent = Math.round((written / total) * 100);
            try { await onProgress(written, total, percent); } catch { /* ignore */ }
        }
    }

    if (written !== total) throw new Error('the download ended with the wrong size');
    return { path: dest, bytes: written, mime, ext: EXTENSIONS[mime] || 'mp3' };
}

async function obtainAudio(videoId, dest, { onRetry, onInfo, onProgress } = {}) {
    const { links, meta } = await fetchAudioInfo(videoId, { onRetry, onInfo });
    let lastError;

    for (const link of links) {
        try {
            const file = await downloadToFile(link.url, dest, { onProgress });
            return { ...file, meta };
        } catch (err) {
            if (err.tooLarge) throw err;
            lastError = err;
        }
    }
    throw lastError || new Error('the API returned no usable audio link');
}

// ═══════════════ PART 3 — Poddax API (YouTube search + video qualities) ═══════════════
//   GET {PODDAX_BASE}/ytsearch?url=<words>   → { status, result: [{ title, url, duration, seconds, views, ago, author, thumbnail }] }
//   GET {PODDAX_BASE}/ytmp4?url=<video link> → { status, title, author, thumbnail, downloads: [{ quality: "720", downloadUrl }] }

// small JSON helper with retries (timeouts, HTTP 5xx / 429 / 403 are treated as temporary)
async function getJson(url, { timeout = 30000, retries = 2, delay = 2000, onRetry } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
            if (onRetry) await Promise.resolve(onRetry(attempt)).catch(() => {});
            await sleep(delay * attempt);
        }
        try {
            const r = await request(url, { headers: { Accept: 'application/json' }, timeout });
            if (r.status === 403 || r.status === 429 || r.status >= 500) {
                lastErr = httpError(r.status);
                continue;
            }
            let data;
            try {
                data = JSON.parse(r.text);
            } catch {
                throw new Error(`the API did not return JSON (HTTP ${r.status})`);
            }
            if (r.status !== 200 || data.status === false || data.success === false) {
                throw new Error(clean(
                    data.message || data.error || data.msg,
                    `the API refused the request (HTTP ${r.status})`
                ));
            }
            return data;
        } catch (err) {
            if (isTemporary(err)) {
                lastErr = err;
                continue;
            }
            throw err;
        }
    }
    if (lastErr && lastErr.status === 403) {
        throw new Error('the API returned HTTP 403 (rate-limited or blocked). Please wait a few minutes and try again.');
    }
    throw lastErr || new Error('the API did not answer');
}

// YouTube search → [{ id, title, author, duration, seconds, views, ago, thumbnail }]
async function searchYouTube(query) {
    const data = await getJson(`${PODDAX_BASE}/ytsearch?url=${encodeURIComponent(query)}`, { retries: 2, delay: 2000 });
    const list = Array.isArray(data.result) ? data.result : [];

    const seen = new Set();
    const results = [];
    for (const r of list) {
        const id = extractVideoId(r && r.url);
        if (!id || seen.has(id)) continue; // channels / playlists / broken entries
        seen.add(id);
        results.push({
            id,
            title: clean(r.title, 'Untitled video'),
            author: clean(r.author),
            duration: clean(r.duration),
            seconds: Number(r.seconds) || 0,
            views: Number(r.views) || 0,
            ago: clean(r.ago),
            thumbnail: r.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        });
        if (results.length >= MAX_SEARCH_RESULTS) break;
    }
    return results;
}

// available video qualities of one video → { title, author, thumbnail, downloads: [{ num, label, url, size }] } (low → high)
async function fetchVideoInfo(videoId, { onRetry } = {}) {
    const data = await getJson(
        `${PODDAX_BASE}/ytmp4?url=${encodeURIComponent(`https://youtu.be/${videoId}`)}`,
        { timeout: 60000, retries: API_MAX_RETRIES, delay: API_RETRY_DELAY_MS, onRetry }
    );
    const src = data.result && typeof data.result === 'object' && !Array.isArray(data.result) ? data.result : data;
    const raw = Array.isArray(src.downloads) ? src.downloads : Array.isArray(src.formats) ? src.formats : [];

    const downloads = [];
    const seen = new Set();
    for (const d of raw) {
        const url = d && (d.downloadUrl || d.download_url || d.url);
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
        const num = parseInt(String(d.quality || d.label || '').replace(/[^\d]/g, ''), 10) || 0;
        const key = num || url;
        if (seen.has(key)) continue;
        seen.add(key);
        downloads.push({ num, label: num ? `${num}p` : clean(d.quality, 'video'), url, size: null });
    }
    if (!downloads.length) throw new Error('the API returned no video links');
    downloads.sort((a, b) => a.num - b.num);

    return {
        title: clean(src.title),
        author: clean(src.author),
        thumbnail: src.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        downloads,
    };
}

// the best quality that is not above `wanted`; if everything is above it, the lowest one
function pickDownload(downloads, wanted) {
    const sorted = downloads.slice().sort((a, b) => a.num - b.num);
    const fitting = sorted.filter((d) => d.num && d.num <= wanted);
    return fitting.length ? fitting[fitting.length - 1] : sorted[0];
}

// ─────────────── video downloading (streaming) ───────────────
const STREAM_IDLE_MS = 30000;

// sends a GET request and resolves as soon as the headers arrive (follows redirects); the body is not read yet
function openStream(url, headers = {}, redirects = 5, timeout = STREAM_IDLE_MS) {
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
            headers: {
                'User-Agent': USER_AGENT,
                Accept: '*/*',
                'Accept-Encoding': 'identity',
                ...headers,
            },
        }, (res) => {
            const status = res.statusCode;
            if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects > 0) {
                res.resume();
                return resolve(openStream(new URL(res.headers.location, url).toString(), headers, redirects - 1, timeout));
            }
            resolve({ res, url, status });
        });

        req.on('timeout', () => req.destroy(new Error('the request timed out')));
        req.on('error', reject);
        req.end();
    });
}

// asks the server how big a file is without downloading it (a 1-byte ranged request); null if unknown
async function probeSize(url) {
    try {
        const { res, status } = await openStream(url, { Range: 'bytes=0-0' }, 3, 7000);
        res.on('error', () => {});
        const range = /\/(\d+)\s*$/.exec(String(res.headers['content-range'] || ''));
        const length = Number(res.headers['content-length']);
        res.destroy();
        if (range) return Number(range[1]);
        if (status === 200 && length > 0) return length;
        return null;
    } catch {
        return null;
    }
}

async function attachSizes(downloads) {
    await Promise.all(downloads.map(async (d) => { d.size = await probeSize(d.url); }));
}

// writes the body of a response to a file (appending); resolves when the file is closed
function pipeBody(res, dest, onBytes) {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest, { flags: 'a' });
        let error = null;

        const fail = (err) => {
            if (error) return;
            error = err;
            res.unpipe(out);
            res.destroy();
            out.end();
        };

        res.on('data', (chunk) => {
            const stop = onBytes(chunk.length);
            if (stop) fail(stop);
        });
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('the connection was closed early')));
        res.on('close', () => {
            if (!res.complete) fail(new Error('the connection was closed early'));
        });
        out.on('error', fail);
        out.on('close', () => (error ? reject(error) : resolve()));
        res.pipe(out);
    });
}

// downloads a video with one streaming request; if the connection drops half-way it continues
// from where it stopped (Range request) instead of starting again
async function downloadVideoToFile(url, dest, { onProgress } = {}) {
    const maxBytes = MAX_VIDEO_MB * 1048576;
    await fs.promises.writeFile(dest, '');

    let current = url;
    let lastError;

    for (let attempt = 0; attempt <= VIDEO_DL_RETRIES; attempt++) {
        if (attempt > 0) await sleep(1500 * attempt);
        try {
            let have = (await fs.promises.stat(dest)).size; // what is really on disk
            const { res, url: finalUrl, status } = await openStream(current, have ? { Range: `bytes=${have}-` } : {});
            current = finalUrl;

            if (status === 416) { // our resume offset was refused → start over
                res.resume();
                await fs.promises.writeFile(dest, '');
                throw new Error('the server refused to resume the download');
            }
            if (status !== 200 && status !== 206) {
                res.resume();
                throw httpError(status);
            }
            const type = String(res.headers['content-type'] || '').toLowerCase();
            if (/^text\/|json|html/.test(type)) {
                res.resume();
                throw Object.assign(new Error('the server sent text instead of a video'), { fatal: true });
            }

            let total = null;
            if (status === 206) {
                const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(res.headers['content-range'] || '').trim());
                if (!m || Number(m[1]) !== have) {
                    res.resume();
                    throw new Error('the server sent a damaged piece of the file');
                }
                total = m[3] === '*' ? null : Number(m[3]);
            } else {
                if (have) { // the server ignored our Range header and sent everything again
                    await fs.promises.writeFile(dest, '');
                    have = 0;
                }
                total = Number(res.headers['content-length']) || null;
            }
            if (total && total > maxBytes) {
                res.resume();
                throw Object.assign(new Error(`the file is too large (${formatBytes(total)})`), { tooLarge: true });
            }

            let received = have;
            let reporting = false;
            await pipeBody(res, dest, (n) => {
                received += n;
                if (received > maxBytes) {
                    return Object.assign(new Error(`the file is too large (over ${MAX_VIDEO_MB} MB)`), { tooLarge: true });
                }
                if (onProgress && total && !reporting) {
                    reporting = true;
                    const percent = Math.min(100, Math.round((received / total) * 100));
                    Promise.resolve(onProgress(received, total, percent))
                        .catch(() => {})
                        .finally(() => { reporting = false; });
                }
                return null;
            });

            const size = (await fs.promises.stat(dest)).size;
            if (total && size !== total) throw new Error('the download ended with the wrong size');
            if (!size) throw new Error('received an empty file');
            return { path: dest, bytes: size, mime: 'video/mp4', ext: 'mp4' };
        } catch (err) {
            if (err.tooLarge || err.fatal) throw err;
            // 403 / 404 / 410 …: the link itself is bad → give up here (the caller may ask the API for a fresh one)
            if (err.status && err.status < 500 && err.status !== 429) throw err;
            lastError = err;
        }
    }
    throw lastError || new Error('the video download failed');
}

// get the video link (+ qualities) and download it. `download` = the quality the person picked,
// `wanted` = a number like 720 (playlists: the closest quality the video has is used)
async function obtainVideo(videoId, dest, { info, download, wanted, titleHint, onRetry, onInfo, onProgress } = {}) {
    let data = info || null;
    let chosen = download || null;
    const want = (download && download.num) || wanted || 720;

    for (let round = 0; ; round++) {
        if (!data) data = await fetchVideoInfo(videoId, { onRetry });
        if (!chosen) chosen = pickDownload(data.downloads, want);

        const meta = {
            title: data.title || titleHint || `YouTube video ${videoId}`,
            size: chosen.size ? formatBytes(chosen.size) : '',
            type: `MP4 ${chosen.label}`,
            quality: chosen.label,
            creator: PODDAX_NAME,
        };
        if (round === 0 && onInfo) await Promise.resolve(onInfo(meta)).catch(() => {});

        try {
            const file = await downloadVideoToFile(chosen.url, dest, { onProgress });
            return { ...file, meta };
        } catch (err) {
            // the link may have expired while the person was choosing → ask the API once more
            if (round === 0 && [403, 404, 410].includes(err.status)) {
                data = null;
                chosen = null;
                continue;
            }
            throw err;
        }
    }
}

// ─────────────── temp files ───────────────
let tempDirCache = null;

function tempDir() {
    if (tempDirCache) return tempDirCache;
    for (const base of [os.tmpdir(), process.cwd()]) {
        try {
            const dir = path.join(base, 'ytaudl_tmp');
            fs.mkdirSync(dir, { recursive: true });
            fs.accessSync(dir, fs.constants.W_OK);
            for (const name of fs.readdirSync(dir)) {
                const file = path.join(dir, name);
                try {
                    if (Date.now() - fs.statSync(file).mtimeMs > 3600000) fs.unlinkSync(file);
                } catch { /* ignore */ }
            }
            tempDirCache = dir;
            return dir;
        } catch { /* try next */ }
    }
    throw new Error('no writable temp folder is available');
}

const tempPath = (videoId) =>
    path.join(tempDir(), `${videoId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.part`);

const removeFile = (file) => fs.promises.unlink(file).catch(() => {});

// ─────────────── ffmpeg (needed for real voice notes) ───────────────
// WhatsApp only shows an audio file as a *voice note* when it is OGG/Opus, so the downloaded file has to be
// converted. ffmpeg is looked for in this order: the FFMPEG_PATH env variable, the "ffmpeg-static" and
// "@ffmpeg-installer/ffmpeg" npm packages, and finally the ffmpeg installed on the server.
// If your host has no ffmpeg, run this once in the bot folder:   npm i ffmpeg-static
let ffmpegState = null; // { bin, checkedAt }

async function findFfmpeg() {
    if (ffmpegState && (ffmpegState.bin || Date.now() - ffmpegState.checkedAt < 600000)) return ffmpegState.bin;

    const candidates = [];
    if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
    for (const name of ['ffmpeg-static', '@ffmpeg-installer/ffmpeg']) {
        try {
            const mod = require(name);
            const bin = typeof mod === 'string' ? mod : mod && mod.path;
            if (bin) candidates.push(bin);
        } catch { /* package not installed */ }
    }
    candidates.push('ffmpeg');

    for (const bin of candidates) {
        try {
            await execFilePromise(bin, ['-version'], { timeout: 15000 });
            ffmpegState = { bin, checkedAt: Date.now() };
            console.log(`[ytaudl] ffmpeg found: ${bin}`);
            return bin;
        } catch { /* try the next one */ }
    }
    ffmpegState = { bin: null, checkedAt: Date.now() };
    return null;
}

const warned = new Set();
function warnOnce(text) {
    if (warned.has(text)) return;
    warned.add(text);
    console.error(text);
}

// any audio/video file → mono OGG/Opus (the format WhatsApp uses for voice notes)
async function convertToOpus(inputPath) {
    const ffmpeg = await findFfmpeg();
    if (!ffmpeg) throw new Error('ffmpeg is not installed on this server (run: npm i ffmpeg-static)');

    const outPath = `${inputPath.replace(/\.[^./\\]+$/, '')}.voice.ogg`;
    let lastError;
    for (const encoder of ['libopus', 'opus']) {
        try {
            await execFilePromise(ffmpeg, [
                '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                '-i', inputPath,
                '-vn', '-map_metadata', '-1',
                '-c:a', encoder,
                ...(encoder === 'opus' ? ['-strict', '-2'] : []),
                '-b:a', '64k', '-ar', '48000', '-ac', '1',
                '-f', 'ogg', outPath,
            ], { timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
            const { size } = await fs.promises.stat(outPath);
            if (!size) throw new Error('ffmpeg produced an empty file');
            return { path: outPath, bytes: size };
        } catch (err) {
            lastError = err;
            await removeFile(outPath);
        }
    }
    throw new Error(clean(lastError && (lastError.stderr || lastError.message), 'ffmpeg failed').slice(0, 300));
}

// ─────────────── send audio / voice note ───────────────
// sends with a reply (quote); if the reply fails it is sent normally
async function sendWithQuote(conn, targetJid, payload, quotedMsg) {
    if (quotedMsg) {
        try {
            return await conn.sendMessage(targetJid, payload, { quoted: quotedMsg });
        } catch (err) {
            console.error('[ytaudl] reply failed, sending normally:', err.message);
        }
    }
    return conn.sendMessage(targetJid, payload);
}

// builds the voice-note message: converted to OGG/Opus when possible, otherwise the original file flagged as
// a voice note. Returns null when the file can only be sent as a document (too long / unsuitable format).
async function buildVoicePayload(file, cleanup) {
    const limit = AUDIO_MAX_MB * 1048576;

    let ogg = null;
    try {
        ogg = await convertToOpus(file.path);
        cleanup.push(ogg.path);
    } catch (err) {
        warnOnce(
            `[ytaudl] voice-note conversion failed: ${redact(err.message)}\n` +
            '[ytaudl] → falling back to sending the original file flagged as a voice note. ' +
            'For proper voice notes install ffmpeg on the server, or run: npm i ffmpeg-static'
        );
    }

    if (ogg) {
        if (ogg.bytes > limit) return null;
        return { audio: { url: ogg.path }, mimetype: 'audio/ogg; codecs=opus', ptt: true };
    }
    if (file.bytes <= limit && /^audio\/(mpeg|mp4|aac|ogg)/.test(file.mime)) {
        return { audio: { url: file.path }, mimetype: file.mime, ptt: true };
    }
    return null;
}

async function sendAudioFile(conn, targetJid, file, title, quotedMsg, voiceMode = false) {
    const cleanup = [];
    const asDocument = () => ({
        document: { url: file.path },
        mimetype: file.mime,
        fileName: `${safeFileName(title)}.${file.ext}`,
    });

    try {
        let payload;
        if (voiceMode) {
            payload = (await buildVoicePayload(file, cleanup)) || asDocument();
        } else {
            const fitsAudio = file.bytes <= AUDIO_MAX_MB * 1048576 && /^audio\//.test(file.mime);
            payload = fitsAudio ? { audio: { url: file.path }, mimetype: file.mime, ptt: false } : asDocument();
        }
        await sendWithQuote(conn, targetJid, payload, quotedMsg);
    } finally {
        for (const tmp of cleanup) await removeFile(tmp);
    }
}

// ─────────────── send video / document ───────────────
async function sendVideoFile(conn, targetJid, file, meta, quotedMsg, asDocument) {
    const quality = meta.quality ? ` • ${meta.quality}` : '';
    const caption = `🎬 *${shorten(meta.title, 150)}*\n📺 MP4${quality} • 📦 ${formatBytes(file.bytes)}`;
    const documentPayload = {
        document: { url: file.path },
        mimetype: 'video/mp4',
        fileName: `${safeFileName(meta.title)}${meta.quality ? ` (${meta.quality})` : ''}.mp4`,
        caption,
    };

    if (asDocument) return sendWithQuote(conn, targetJid, documentPayload, quotedMsg);
    try {
        return await sendWithQuote(conn, targetJid, { video: { url: file.path }, mimetype: 'video/mp4', caption }, quotedMsg);
    } catch (err) {
        console.error('[ytaudl] sending as a video failed, sending as a document instead:', err.message);
        return sendWithQuote(conn, targetJid, documentPayload, quotedMsg);
    }
}

// ─────────────── what a job downloads and how it is sent ───────────────
const COMMAND_NAME = { audio: 'ytaudl', voice: 'ytvcdl', video: 'ytvdl' };

function makeWorker(conn, targetJid, mode, options = {}) {
    if (mode === 'video') {
        return {
            icon: '🎬',
            slowUpload: true, // big files take a while to upload → show an "uploading" status
            infoLine: (info) => `📺 ${info.type || 'MP4'}${info.size ? ` | 📦 Size: ${info.size}` : ''}`,
            obtain: (videoId, dest, hooks) => obtainVideo(videoId, dest, {
                info: options.info,
                download: options.download,
                wanted: options.wanted,
                titleHint: options.title,
                ...hooks,
            }),
            send: (file, quoted) => sendVideoFile(conn, targetJid, file, file.meta, quoted, !!options.asDocument),
        };
    }
    const voice = mode === 'voice';
    return {
        icon: voice ? '🎤' : '🎵',
        slowUpload: false,
        infoLine: (info, compact) => (compact
            ? `📦 ${info.size || 'unknown'} | 🎧 ${info.type || 'MP3'}`
            : `📦 Size: ${info.size || 'unknown'} | 🎧 ${info.type || 'MP3'}`),
        obtain: (videoId, dest, hooks) => obtainAudio(videoId, dest, hooks),
        send: (file, quoted) => sendAudioFile(conn, targetJid, file, file.meta.title, quoted, voice),
    };
}

// ─────────────── header builder (playlist) ───────────────
function buildPlaylistHeader(playlistTitle, total, sent, extraLine, cmdName = 'ytaudl') {
    const pct = total ? Math.round((sent / total) * 100) : 0;
    const bar = progressBar(pct, 14);
    const parts = [
        `📋 *Playlist:* ${playlistTitle}`,
        `🔢 *Videos:* ${total}`,
        '',
        `${bar} *${sent}/${total} sent* (${pct}%)`,
    ];
    if (extraLine) parts.push(extraLine);
    parts.push(`🛑 Send *${PREFIX_HINT}${cmdName} stop* to cancel.`);
    return parts.join('\n');
}

// ─────────────── single video job ───────────────
// mode: 'audio' | 'voice' | 'video'
// options (video only): { info, download, wanted, asDocument, title }
async function downloadOne(conn, targetJid, mek, videoId, say, mode, options = {}) {
    const worker = makeWorker(conn, targetJid, mode, options);
    const icon = worker.icon;

    let statusMsg = null;
    try {
        // Same as playlist: sending an initial processing message and editing it later
        statusMsg = await conn.sendMessage(targetJid, { text: '⏳ Processing your request, please wait...' }, mek ? { quoted: mek } : undefined);
    } catch {
        return say(MSG.error);
    }
    const statusKey = statusMsg && statusMsg.key;

    const dest = tempPath(videoId);
    let meta = null;
    let lastPercent = -PROGRESS_STEP;
    const fallbackTitle = options.title || `YouTube ${mode === 'video' ? 'video' : 'audio'} ${videoId}`;

    const update = async (text) => {
        const ok = await editMessage(conn, targetJid, statusKey, text);
        if (!ok) await say(text).catch(() => {});
    };

    try {
        const file = await worker.obtain(videoId, dest, {
            onRetry: async (attempt) => {
                await update(
                    `🔄 *API is busy or timed out.*\n` +
                    `Retrying (${attempt}/${API_MAX_RETRIES})...`
                );
            },
            onInfo: async (info) => {
                meta = info;
                lastPercent = 0;
                await update(
                    `${icon} *${shorten(info.title, 100)}*\n\n` +
                    `${worker.infoLine(info)}\n` +
                    `👤 Source: ${info.creator || 'API'}\n\n` +
                    `${progressBar(0)} 0%`
                );
            },
            onProgress: async (written, total, percent) => {
                if (percent < 100 && percent - lastPercent < PROGRESS_STEP) return;
                lastPercent = percent;
                await update(
                    `${icon} *${shorten(meta?.title || fallbackTitle, 100)}*\n\n` +
                    `${progressBar(percent)} ${percent}%\n` +
                    `📥 ${formatBytes(written)} / ${formatBytes(total)}`
                );
            },
        });

        const doneText =
            `✅ ${icon} *${shorten(file.meta.title, 100)}*\n` +
            `📦 ${formatBytes(file.bytes)}`;

        if (worker.slowUpload) {
            await update(`📤 *Uploading to WhatsApp...*\n${icon} ${shorten(file.meta.title, 100)}\n📦 ${formatBytes(file.bytes)}`);
        } else {
            await update(doneText);
        }

        await humanPresence(conn, targetJid);

        // Reply to the same status message we edited
        await worker.send(file, statusMsg);
        if (worker.slowUpload) await update(doneText);
    } catch (err) {
        console.error('[ytaudl] video job failed:', redact(err.message));
        await update(MSG.videoFailed(err.message, mode));
    } finally {
        await removeFile(dest);
    }
}

// ─────────────── playlist job ───────────────
// options: { playlist (already read → skip reading), wanted, asDocument }  (the last two are for video mode)
async function downloadPlaylist(conn, targetJid, mek, listId, job, say, mode, hintVideoId, options = {}) {
    const worker = makeWorker(conn, targetJid, mode, options);
    const icon = worker.icon;
    const cmdName = COMMAND_NAME[mode];
    const limit = mode === 'video' ? MAX_VIDEO_PLAYLIST : MAX_PLAYLIST_TRACKS;

    let headerMsg = null;
    try {
        headerMsg = await conn.sendMessage(
            targetJid,
            { text: options.playlist ? '⏳ Starting...' : MSG.playlistFetching },
            mek ? { quoted: mek } : undefined
        );
    } catch {
        return say(MSG.error);
    }
    const headerKey = headerMsg && headerMsg.key;

    const updateHeader = async (text) => {
        const ok = await editMessage(conn, targetJid, headerKey, text);
        if (!ok) await say(text).catch(() => {});
    };

    // 1) read the playlist (normal playlists and auto-generated Mixes)
    let playlist = options.playlist || null;
    if (!playlist) {
        try {
            playlist = await fetchPlaylist(listId, limit, hintVideoId);
        } catch (err) {
            console.error('[ytaudl] playlist failed:', redact(err.message));
            return updateHeader(MSG.playlistFailed(err.message));
        }
    }

    const tracks = playlist.videos;
    if (!tracks.length) return updateHeader(MSG.playlistEmpty);

    // 2) header → playlist info + 0/N bar
    await updateHeader(buildPlaylistHeader(playlist.title, tracks.length, 0, '⏳ Starting...', cmdName));

    let sent = 0;
    let streak = 0;
    let aborted = false;
    const failed = [];

    // 3) process tracks one by one
    for (let i = 0; i < tracks.length; i++) {
        if (job.cancelled) break;

        const track = tracks[i];
        const tag = `[${i + 1}/${tracks.length}]`;
        const dest = tempPath(track.id);

        // per-track status message
        let trackMsg = null;
        try {
            trackMsg = await conn.sendMessage(targetJid, {
                text: `${tag} ${icon} *${shorten(track.title, 80)}*\n\n⏳ Starting...`
            });
        } catch { /* ignore */ }
        const trackKey = trackMsg && trackMsg.key;

        const updateTrack = async (text) => {
            if (trackKey) {
                const ok = await editMessage(conn, targetJid, trackKey, text);
                if (ok) return;
            }
            await say(text).catch(() => {});
        };

        let meta = null;
        let lastPercent = -PROGRESS_STEP;

        try {
            const file = await worker.obtain(track.id, dest, {
                titleHint: track.title,
                onRetry: async (attempt) => {
                    await updateTrack(
                        `${tag} ${icon} *${shorten(track.title, 80)}*\n\n` +
                        `🔄 API busy or timed out. Retrying (${attempt}/${API_MAX_RETRIES})...`
                    );
                },
                onInfo: async (info) => {
                    meta = info;
                    lastPercent = 0;
                    await updateTrack(
                        `${tag} ${icon} *${shorten(info.title, 80)}*\n\n` +
                        `${worker.infoLine(info, true)}\n\n` +
                        `${progressBar(0)} 0%`
                    );
                },
                onProgress: async (written, total, percent) => {
                    if (percent < 100 && percent - lastPercent < PROGRESS_STEP) return;
                    lastPercent = percent;
                    await updateTrack(
                        `${tag} ${icon} *${shorten(meta?.title || track.title, 80)}*\n\n` +
                        `${progressBar(percent)} ${percent}%\n` +
                        `📥 ${formatBytes(written)} / ${formatBytes(total)}`
                    );
                },
            });

            await updateTrack(
                `✅ ${tag} ${icon} *${shorten(file.meta.title, 80)}*\n` +
                `📦 ${formatBytes(file.bytes)}`
            );

            await humanPresence(conn, targetJid, 600, 1500);

            // Pass the whole message object for replying
            await worker.send(file, trackMsg);

            sent++;
            streak = 0;

            const extra = sent >= tracks.length
                ? '✅ *All tracks sent!*'
                : `⏳ Next: track ${i + 2}...`;
            await updateHeader(buildPlaylistHeader(playlist.title, tracks.length, sent, extra, cmdName));

        } catch (err) {
            failed.push(track.title);
            streak++;
            await updateTrack(
                `❌ ${tag} ${shorten(track.title, 60)}` +
                (SHOW_ERROR_REASON ? `\n🔎 ${shorten(redact(err.message), 200)}` : '')
            );
            if (streak >= MAX_FAILS_IN_A_ROW) {
                aborted = true;
                break;
            }
        } finally {
            await removeFile(dest);
        }

        if (i < tracks.length - 1 && !job.cancelled) {
            await interruptibleDelay(
                randomBetween(TRACK_DELAY_MIN_MS, TRACK_DELAY_MAX_MS),
                () => job.cancelled
            );
        }
    }

    // 4) final summary → edit header
    const lines = [
        job.cancelled ? '🛑 *Download stopped.*'
            : aborted ? `⚠️ *Stopped early — ${MAX_FAILS_IN_A_ROW} failed in a row.*`
            : '✅ *Playlist finished!*',
        '',
        `📋 *Playlist:* ${playlist.title}`,
        `📥 *Sent:* ${sent} of ${tracks.length}`,
    ];
    if (failed.length) lines.push(`❌ *Failed:* ${failed.length}`);
    if (playlist.skipped) lines.push(`🚫 *Skipped (deleted/private):* ${playlist.skipped}`);
    if (failed.length) {
        lines.push('', '*Failed tracks:*', ...failed.slice(0, 10).map((t) => `• ${shorten(t, 60)}`));
        if (failed.length > 10) lines.push(`…and ${failed.length - 10} more`);
    }
    await updateHeader(lines.join('\n'));
}

// ═══════════════ PART 4 — buttons / menus ═══════════════
// menu = { title, text, options: [{ id, label, desc }], listLabel, listTitle, numbered }
//   • up to 3 options → quick-reply buttons, more → a list ("Select …" button)
//   • every menu also lists its options as 1, 2, 3 … so the person can simply reply with the number

const PLAYLIST_QUALITIES = [144, 360, 720, 1080];

function formatViews(n) {
    if (!n) return '';
    const trim = (x) => x.toFixed(1).replace(/\.0$/, '');
    if (n >= 1e9) return `${trim(n / 1e9)}B`;
    if (n >= 1e6) return `${trim(n / 1e6)}M`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
    return String(n);
}

const videoLine = (v) => [
    v.duration && `⏱ ${v.duration}`,
    v.views && `👁 ${formatViews(v.views)}`,
    v.author && `📺 ${shorten(v.author, 22)}`,
].filter(Boolean).join(' · ');

function menuBody(menu, withButtons) {
    const lines = [menu.text];
    if (menu.numbered !== false) lines.push('', ...menu.options.map((o, i) => `*${i + 1}.* ${o.label}`));
    lines.push('', withButtons
        ? '👇 Tap a button below — or reply to this message with a number.'
        : '↩️ Reply to this message with a number.');
    return lines.join('\n');
}

// quick-reply buttons (≤ 3 options) or one list button, in WhatsApp's "native flow" format
function nativeButtons(menu) {
    if (menu.options.length <= 3) {
        return menu.options.map((o) => ({
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({ display_text: shorten(o.label, 20), id: o.id }),
        }));
    }
    return [{
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
            title: shorten(menu.listLabel || 'Select', 24),
            sections: [{
                title: shorten(menu.listTitle || 'Options', 24),
                rows: menu.options.map((o) => ({
                    id: o.id,
                    title: shorten(o.label, 24),
                    description: shorten(o.desc || '', 72),
                })),
            }],
        }),
    }];
}

function quoteContext(conn, quoted) {
    if (!quoted || !quoted.key || !quoted.message) return null;
    const me = conn.user && conn.user.id ? String(conn.user.id).replace(/:\d+(?=@)/, '') : undefined;
    return {
        stanzaId: quoted.key.id,
        participant: quoted.key.fromMe ? me : (quoted.key.participant || quoted.key.remoteJid),
        quotedMessage: quoted.message,
    };
}

// style "native": works on a plain @whiskeysockets/baileys — the message is relayed together with the
// binary nodes WhatsApp needs to show interactive buttons (private chat: biz + bot, group: biz)
async function sendNativeMenu(conn, jid, menu, quoted, viewOnce = false) {
    if (typeof conn.relayMessage !== 'function') throw new Error('this connection has no relayMessage');

    const messageId = `3EB0${crypto.randomBytes(9).toString('hex').toUpperCase()}`;
    const interactiveMessage = {
        header: { title: menu.title || '', hasMediaAttachment: false },
        body: { text: menuBody(menu, true) },
        footer: { text: MENU_FOOTER },
        nativeFlowMessage: { buttons: nativeButtons(menu), messageParamsJson: '' },
    };
    const context = quoteContext(conn, quoted);
    if (context) interactiveMessage.contextInfo = context;

    const inner = {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage,
    };
    const message = viewOnce ? { viewOnceMessage: { message: inner } } : inner;
    const additionalNodes = [{
        tag: 'biz',
        attrs: {},
        content: [{
            tag: 'interactive',
            attrs: { type: 'native_flow', v: '1' },
            content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }],
        }],
    }];
    if (!String(jid).endsWith('@g.us')) additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });

    await conn.relayMessage(jid, message, { messageId, additionalNodes });
    return { key: { remoteJid: jid, fromMe: true, id: messageId }, message };
}

// style "interactive": Baileys forks / helpers that understand `interactiveButtons` in sendMessage
function sendInteractiveMenu(conn, jid, menu, quoted) {
    return conn.sendMessage(jid, {
        text: menuBody(menu, true),
        title: menu.title,
        footer: MENU_FOOTER,
        interactiveButtons: nativeButtons(menu),
    }, quoted ? { quoted } : undefined);
}

// style "legacy": the old buttons / list message
function sendLegacyMenu(conn, jid, menu, quoted) {
    const opts = quoted ? { quoted } : undefined;
    if (menu.options.length <= 3) {
        return conn.sendMessage(jid, {
            text: menuBody(menu, true),
            footer: MENU_FOOTER,
            buttons: menu.options.map((o) => ({
                buttonId: o.id,
                buttonText: { displayText: shorten(o.label, 20) },
                type: 1,
            })),
            headerType: 1,
        }, opts);
    }
    return conn.sendMessage(jid, {
        text: menuBody(menu, true),
        footer: MENU_FOOTER,
        title: menu.title,
        buttonText: shorten(menu.listLabel || 'Select', 24),
        sections: [{
            title: menu.listTitle || 'Options',
            rows: menu.options.map((o) => ({
                title: shorten(o.label, 24),
                description: shorten(o.desc || '', 72),
                rowId: o.id,
            })),
        }],
    }, opts);
}

const MENU_SENDERS = {
    native: (conn, jid, menu, quoted) => sendNativeMenu(conn, jid, menu, quoted, false),
    'native-vo': (conn, jid, menu, quoted) => sendNativeMenu(conn, jid, menu, quoted, true),
    interactive: sendInteractiveMenu,
    legacy: sendLegacyMenu,
};

function resolveStyle(conn) {
    if (BUTTON_STYLE !== 'auto') return BUTTON_STYLE;
    return typeof conn.relayMessage === 'function' ? 'native' : 'legacy';
}

// sends a menu; if the chosen button style fails it falls back to a numbered text menu
async function sendMenu(conn, jid, menu, quoted) {
    const style = resolveStyle(conn);
    const sender = MENU_SENDERS[style];
    let sent = null;

    if (sender) {
        try {
            sent = await sender(conn, jid, menu, quoted);
        } catch (err) {
            warnOnce(`[ytaudl] "${style}" buttons failed (${redact(err && err.message)}) → using numbered text menus. Try another BUTTON_STYLE.`);
        }
    }
    if (!sent) {
        sent = await conn.sendMessage(jid, { text: menuBody(menu, false) }, quoted ? { quoted } : undefined);
    }
    return sent;
}

// ═══════════════ PART 5 — interactive sessions (one per menu conversation) ═══════════════
const sessions = new Map();
const ID_RE = /^ytdl:([a-z0-9]+):([a-z]+):([\w-]*)$/;
const seenReplies = new Set();

function pruneSessions() {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.touched > SESSION_TTL_MS) sessions.delete(id);
}

function createSession(data) {
    pruneSessions();
    let id;
    do { id = Math.random().toString(36).slice(2, 8); } while (!id || sessions.has(id));
    const session = { id, step: null, touched: Date.now(), busy: false, menu: null, ...data };
    sessions.set(id, session);
    return session;
}

const endSession = (session) => sessions.delete(session.id);

// shows a menu and remembers which step the session is waiting for
async function showMenu(conn, session, step, menu) {
    session.step = step;
    session.touched = Date.now();
    const options = menu.options.map((o) => ({ ...o, id: `ytdl:${session.id}:${step}:${o.value}` }));
    const sent = await sendMenu(conn, session.promptJid, { ...menu, options }, session.quoted);
    session.menu = { msgId: sent && sent.key && sent.key.id, options };
    return sent;
}

const findSessionByMenu = (msgId) => {
    for (const s of sessions.values()) if (s.menu && s.menu.msgId === msgId) return s;
    return null;
};

const jidNumber = (jid) => String(jid || '').split('@')[0].split(':')[0];
const jidDomain = (jid) => String(jid || '').split('@')[1] || '';
function sameUser(a, b) {
    if (!a || !b) return true;                         // cannot tell → do not block
    if (jidDomain(a) !== jidDomain(b)) return true;    // phone-number JID vs LID → cannot compare
    return jidNumber(a) === jidNumber(b);
}
const senderOf = (opts, mek) =>
    (opts && opts.sender) || (mek && mek.key && (mek.key.participant || mek.key.remoteJid)) || '';

// ─────────────── reading the answers ───────────────
function unwrapMessage(message) {
    let m = message;
    for (let i = 0; i < 5 && m; i++) {
        const inner =
            (m.ephemeralMessage && m.ephemeralMessage.message) ||
            (m.viewOnceMessage && m.viewOnceMessage.message) ||
            (m.viewOnceMessageV2 && m.viewOnceMessageV2.message) ||
            (m.viewOnceMessageV2Extension && m.viewOnceMessageV2Extension.message) ||
            (m.documentWithCaptionMessage && m.documentWithCaptionMessage.message);
        if (!inner) break;
        m = inner;
    }
    return m || {};
}

// → { id: id of the pressed button / list row (or null), text: typed text, quotedId: id of the message replied to }
function readReply(message) {
    const m = unwrapMessage(message);
    let id = null;

    if (m.buttonsResponseMessage) {
        id = m.buttonsResponseMessage.selectedButtonId;
    } else if (m.templateButtonReplyMessage) {
        id = m.templateButtonReplyMessage.selectedId;
    } else if (m.listResponseMessage) {
        id = m.listResponseMessage.singleSelectReply && m.listResponseMessage.singleSelectReply.selectedRowId;
    } else if (m.interactiveResponseMessage) {
        const flow = m.interactiveResponseMessage.nativeFlowResponseMessage;
        if (flow && flow.paramsJson) {
            try {
                const p = JSON.parse(flow.paramsJson);
                id = p.id || p.selectedId || p.row_id || p.rowId || null;
            } catch { /* not JSON */ }
        }
    }
    const ext = m.extendedTextMessage;
    return {
        id: id || null,
        text: String(m.conversation || (ext && ext.text) || '').trim(),
        quotedId: ext && ext.contextInfo ? ext.contextInfo.stanzaId : null,
    };
}

async function onIncoming(conn, msg) {
    if (!msg || !msg.message || !msg.key) return;
    const { id, text, quotedId } = readReply(msg.message);

    let choice = id && ID_RE.exec(id);                           // a button / list row of ours
    if (!choice && ID_RE.test(text)) choice = ID_RE.exec(text);  // some libraries hand the id back as plain text
    let session = null;
    let byNumber = false;

    if (!choice && quotedId && /^\d{1,2}$/.test(text)) {         // "2" typed as a reply to a menu
        session = findSessionByMenu(quotedId);
        const option = session && session.menu && session.menu.options[Number(text) - 1];
        if (!option) return;
        choice = ID_RE.exec(option.id);
        byNumber = true;
    }
    if (!choice) return;

    const dedupe = `${msg.key.remoteJid}|${msg.key.id}`;
    if (seenReplies.has(dedupe)) return;
    seenReplies.add(dedupe);
    if (seenReplies.size > 500) seenReplies.delete(seenReplies.values().next().value);

    const [, sid, step, value] = choice;
    session = session || sessions.get(sid);
    const chat = msg.key.remoteJid;

    if (!session || Date.now() - session.touched > SESSION_TTL_MS) {
        if (session) endSession(session);
        if (!byNumber) await conn.sendMessage(chat, { text: MSG.expired }).catch(() => {});
        return;
    }

    // in a group only the person who started the menu may use it
    if (String(session.promptJid).endsWith('@g.us')) {
        const who = msg.key.fromMe ? (conn.user && conn.user.id) : (msg.key.participant || msg.key.remoteJid);
        if (!sameUser(who, session.owner)) return;
    }
    if (!STEP_HANDLERS[step] || session.step !== step || session.busy) return; // an old menu or a double tap

    session.busy = true;
    try {
        await STEP_HANDLERS[step](conn, session, value);
    } catch (err) {
        console.error(`[ytaudl] "${step}" step failed:`, redact(err && err.message));
        endSession(session);
        await conn.sendMessage(session.promptJid, { text: MSG.error }).catch(() => {});
    } finally {
        session.busy = false;
    }
}

// one listener per connection (the bot may create a new connection when it reconnects)
const listening = new WeakSet();
function ensureListener(conn) {
    if (listening.has(conn)) return true;
    if (!conn.ev || typeof conn.ev.on !== 'function') return false;
    conn.ev.on('messages.upsert', (upsert) => {
        for (const msg of (upsert && upsert.messages) || []) {
            onIncoming(conn, msg).catch((err) => console.error('[ytaudl] button handler error:', redact(err && err.message)));
        }
    });
    listening.add(conn);
    return true;
}

// ─────────────── the menus ───────────────
function searchMenu(query, results) {
    const build = (titleMax, compact) => {
        const lines = [`🔎 *YouTube results for:* ${shorten(query, 40)}`, ''];
        results.forEach((v, i) => {
            lines.push(`*${i + 1}.* ${shorten(v.title, titleMax)}`);
            const meta = compact
                ? [v.duration && `⏱ ${v.duration}`, v.author && `📺 ${shorten(v.author, 14)}`].filter(Boolean).join(' · ')
                : videoLine(v);
            if (meta) lines.push(`      ${meta}`);
        });
        return lines.join('\n');
    };
    // keep the message short enough for a button message (≈ 1000 characters with the hint line)
    let max = 60;
    let text = build(max, false);
    while (text.length > 700 && max > 24) {
        max -= 6;
        text = build(max, false);
    }
    if (text.length > 800) text = build(28, true);
    return {
        title: '🔎 YouTube Search',
        text,
        numbered: false,
        listLabel: 'Select video',
        listTitle: 'Search results',
        options: results.map((v, i) => ({
            value: String(i),
            label: `${i + 1}. ${shorten(v.title, 20)}`,
            desc: [v.duration, v.author].filter(Boolean).join(' • '),
        })),
    };
}

function formatMenu(video) {
    const meta = videoLine(video);
    return {
        title: '🎬 Choose format',
        text: `🎬 *${shorten(video.title, 100)}*${meta ? `\n${meta}` : ''}\n\n*What do you want?*`,
        options: [
            { value: 'audio', label: '🎧 Audio' },
            { value: 'voice', label: '🎤 Voice note' },
            { value: 'video', label: '🎬 Video' },
        ],
    };
}

// null when every quality is bigger than MAX_VIDEO_MB
function qualityMenu(session) {
    const { info, video } = session;
    const limit = MAX_VIDEO_MB * 1048576;
    const options = [];
    const hidden = [];

    info.downloads.forEach((d, i) => {
        if (d.size && d.size > limit) {
            hidden.push(d.label);
            return;
        }
        options.push({
            value: String(i),
            label: d.size ? `${d.label} • ${formatBytes(d.size)}` : d.label,
            desc: d.size ? `MP4 • ${formatBytes(d.size)}` : 'MP4 video',
        });
    });
    if (!options.length) return null;

    const lines = [`🎞️ *${shorten(video.title || info.title || 'Video', 100)}*`];
    if (info.author) lines.push(`📺 ${shorten(info.author, 40)}`);
    lines.push('', '*Choose the video quality:*');
    if (hidden.length) lines.push(`⚠️ Not offered (over ${MAX_VIDEO_MB} MB): ${hidden.join(', ')}`);
    return { title: '🎞️ Video quality', text: lines.join('\n'), options, listLabel: 'Select quality', listTitle: 'Qualities' };
}

function playlistQualityMenu(playlist) {
    return {
        title: '🎞️ Video quality',
        text:
            `📋 *${shorten(playlist.title, 80)}*\n🔢 ${playlist.videos.length} videos\n\n` +
            '*Choose the quality for all videos* (a video without it gets the closest lower quality):',
        options: PLAYLIST_QUALITIES.map((n) => ({ value: String(n), label: `${n}p` })),
        listLabel: 'Select quality',
        listTitle: 'Qualities',
    };
}

function sendAsMenu(session) {
    const lines = [];
    if (session.kind === 'plist') {
        lines.push(
            `📋 *${shorten(session.playlist.title, 80)}*`,
            `🔢 ${session.playlist.videos.length} videos • ${session.wanted}p (or the closest quality each video has)`
        );
    } else {
        const { video, info, download } = session;
        lines.push(
            `🎞️ *${shorten(video.title || info.title || 'Video', 100)}*`,
            `📺 MP4 ${download.label}${download.size ? ` • 📦 ${formatBytes(download.size)}` : ''}`
        );
    }
    lines.push('', '*How should it be sent?*', 'ℹ️ Document keeps the original file; Video plays inside the chat.');
    return {
        title: '📤 Send as',
        text: lines.join('\n'),
        options: [
            { value: 'doc', label: '📄 Document' },
            { value: 'vid', label: '🎬 Video' },
        ],
    };
}

// ─────────────── the steps of a menu conversation ───────────────
// reserves the download slot of the target chat, closes the session and runs the job
// (returns false — and keeps the menu usable — when the chat is busy)
async function launch(conn, session, mode, run) {
    const { promptJid, targetJid } = session;
    const note = (text) => conn.sendMessage(promptJid, { text }).catch(() => {});

    if (jobs.has(targetJid)) {
        await note(MSG.busy(COMMAND_NAME[mode]));
        return false;
    }
    if (jobs.size >= MAX_JOBS_AT_ONCE) {
        await note(MSG.tooManyJobs);
        return false;
    }

    const job = { cancelled: false };
    jobs.set(targetJid, job);
    endSession(session);

    const quoted = targetJid === promptJid ? session.quoted : undefined;
    const sayTarget = (text, quote = false) =>
        conn.sendMessage(targetJid, { text }, quote && quoted ? { quoted } : undefined);

    try {
        if (targetJid !== promptJid) await note(`✅ Forwarding download to: ${targetJid}`);
        await run(job, sayTarget, quoted);
    } finally {
        jobs.delete(targetJid);
    }
    return true;
}

// asks the API for the qualities of session.video, then shows the quality menu
async function askQuality(conn, session) {
    const { promptJid } = session;
    const status = await conn
        .sendMessage(promptJid, { text: MSG.qualityFetching }, { quoted: session.quoted })
        .catch(() => null);
    const statusKey = status && status.key;
    const edit = async (text) => {
        if (!(await editMessage(conn, promptJid, statusKey, text))) {
            await conn.sendMessage(promptJid, { text }).catch(() => {});
        }
    };

    let info;
    try {
        info = await fetchVideoInfo(session.video.id, {
            onRetry: (attempt) => editMessage(
                conn, promptJid, statusKey,
                `🔄 *API is busy or timed out.*\nRetrying (${attempt}/${API_MAX_RETRIES})...`
            ),
        });
        if (SHOW_VIDEO_SIZES) await attachSizes(info.downloads);
    } catch (err) {
        console.error('[ytaudl] could not get the qualities:', redact(err.message));
        endSession(session);
        return edit(MSG.qualitiesFailed(err.message));
    }

    session.info = info;
    if (!session.video.title && info.title) session.video.title = info.title;

    const menu = qualityMenu(session);
    if (!menu) {
        endSession(session);
        return edit(MSG.allTooLarge);
    }
    await showMenu(conn, session, 'qual', menu);
    // cosmetic only → do not make the menu wait for it
    edit(`🎞️ *${shorten(session.video.title || session.video.id, 100)}*\n✅ Qualities found ⬇️`).catch(() => {});
}

const STEP_HANDLERS = {
    // a search result was chosen → what should it become?
    async pick(conn, session, value) {
        const video = session.results && session.results[Number(value)];
        if (!video) return;
        session.video = video;
        await showMenu(conn, session, 'fmt', formatMenu(video));
    },

    // audio / voice note start right away, video continues with the quality
    async fmt(conn, session, value) {
        if (value === 'video') return askQuality(conn, session);
        const mode = value === 'voice' ? 'voice' : 'audio';
        const { video, targetJid } = session;
        await launch(conn, session, mode, (job, sayTarget, quoted) =>
            downloadOne(conn, targetJid, quoted, video.id, sayTarget, mode, { title: video.title }));
    },

    // video quality (single video)
    async qual(conn, session, value) {
        const download = session.info && session.info.downloads[Number(value)];
        if (!download) return;
        session.download = download;
        await showMenu(conn, session, 'as', sendAsMenu(session));
    },

    // video quality (playlist: one choice for all videos)
    async pq(conn, session, value) {
        session.wanted = Number(value) || 720;
        await showMenu(conn, session, 'as', sendAsMenu(session));
    },

    // document or video → download and send
    async as(conn, session, value) {
        const asDocument = value === 'doc';
        const { targetJid } = session;

        if (session.kind === 'plist') {
            const { playlist, wanted } = session;
            await launch(conn, session, 'video', (job, sayTarget, quoted) =>
                downloadPlaylist(conn, targetJid, quoted, null, job, sayTarget, 'video', null, { playlist, wanted, asDocument }));
            return;
        }
        const { video, info, download } = session;
        await launch(conn, session, 'video', (job, sayTarget, quoted) =>
            downloadOne(conn, targetJid, quoted, video.id, sayTarget, 'video', {
                info, download, asDocument, title: video.title,
            }));
    },
};

// ═══════════════ command handlers ═══════════════
const jobs = new Map();

// .ytaudl / .ytvcdl / .ytvdl  (mode: 'audio' | 'voice' | 'video')
async function handleCommand(conn, mek, m, opts, mode) {
    const { from, q } = opts;
    const cmdName = COMMAND_NAME[mode];
    const say = (text, quote = false) =>
        conn.sendMessage(from, { text }, quote ? { quoted: mek } : undefined);

    try {
        const rawArgs = String(q || '').trim().split(/\s+/);
        const arg = rawArgs[0];
        const extras = rawArgs.slice(1);
        const possibleJid = extras.find((a) => /@(g\.us|s\.whatsapp\.net|lid)$/.test(a));
        const wantsAll = extras.some((a) => /^(all|mix|playlist)$/i.test(a));

        if (!arg) return await say(MSG.usage(cmdName), true);

        let targetJid = from;
        if (possibleJid) {
            targetJid = possibleJid;
        }

        if (/^stop$/i.test(arg)) {
            const running = jobs.get(targetJid);
            if (!running) return await say(MSG.nothingRunning, true);
            running.cancelled = true;
            return await say(MSG.stopping, true);
        }

        const linkVideoId = extractVideoId(arg);
        let videoId = linkVideoId;
        let listId = extractPlaylistId(arg);

        // a video link that also carries a playlist / Mix: only the video, unless "all" was added
        if (videoId && listId) {
            if (wantsAll) videoId = null;
            else listId = null;
        }
        if (!videoId && !listId) return await say(MSG.invalid, true);

        if (jobs.has(targetJid)) return await say(MSG.busy(cmdName), true);
        if (jobs.size >= MAX_JOBS_AT_ONCE) return await say(MSG.tooManyJobs, true);

        // video: the quality / document-or-video buttons come first, the download starts after the last choice
        if (mode === 'video') {
            return await startVideoMenu(conn, mek, opts, { videoId, listId, linkVideoId, targetJid });
        }

        const job = { cancelled: false };
        jobs.set(targetJid, job);

        const mekTarget = (targetJid === from) ? mek : undefined;
        const sayTarget = (text, quote = false) =>
            conn.sendMessage(targetJid, { text }, (quote && mekTarget) ? { quoted: mekTarget } : undefined);

        if (targetJid !== from) {
            await say(`✅ Forwarding download to: ${targetJid}`);
        }

        try {
            if (videoId) await downloadOne(conn, targetJid, mekTarget, videoId, sayTarget, mode);
            else await downloadPlaylist(conn, targetJid, mekTarget, listId, job, sayTarget, mode, linkVideoId);
        } finally {
            jobs.delete(targetJid);
        }
    } catch (err) {
        console.error('[ytaudl] error:', redact(err && err.message));
        say(MSG.error).catch(() => {});
    }
}

// .ytvdl: single video → quality buttons; playlist / Mix → one quality for all videos
async function startVideoMenu(conn, mek, opts, { videoId, listId, linkVideoId, targetJid }) {
    const { from } = opts;
    if (!ensureListener(conn)) return conn.sendMessage(from, { text: MSG.noButtons }, { quoted: mek });
    const base = { promptJid: from, targetJid, owner: senderOf(opts, mek), quoted: mek };

    if (videoId) {
        const session = createSession({ ...base, kind: 'single', video: { id: videoId, title: '' } });
        return askQuality(conn, session);
    }

    const status = await conn.sendMessage(from, { text: MSG.playlistFetching }, { quoted: mek }).catch(() => null);
    const edit = async (text) => {
        if (!(await editMessage(conn, from, status && status.key, text))) {
            await conn.sendMessage(from, { text }).catch(() => {});
        }
    };

    let playlist;
    try {
        playlist = await fetchPlaylist(listId, MAX_VIDEO_PLAYLIST, linkVideoId);
    } catch (err) {
        console.error('[ytaudl] playlist failed:', redact(err.message));
        return edit(MSG.playlistFailed(err.message));
    }
    if (!playlist.videos.length) return edit(MSG.playlistEmpty);

    const session = createSession({ ...base, kind: 'plist', playlist });
    await showMenu(conn, session, 'pq', playlistQualityMenu(playlist));
    await edit(`📋 *${shorten(playlist.title, 80)}* — ${playlist.videos.length} videos ✅`);
}

// .ytdl <words | link> [jid]: search → pick a video → Audio / Voice note / Video
async function handleSearchCommand(conn, mek, m, opts) {
    const { from } = opts;
    const say = (text, quote = false) =>
        conn.sendMessage(from, { text }, quote ? { quoted: mek } : undefined);

    try {
        const words = String(opts.q || '').trim().split(/\s+/).filter(Boolean);
        let targetJid = from;
        if (words.length && /@(g\.us|s\.whatsapp\.net|lid)$/.test(words[words.length - 1])) {
            targetJid = words.pop();
        }
        const query = words.join(' ');

        if (!query) return await say(MSG.searchUsage, true);
        if (!ensureListener(conn)) return await say(MSG.noButtons, true);

        const base = { promptJid: from, targetJid, owner: senderOf(opts, mek), quoted: mek };

        // a YouTube link needs no search → straight to the format buttons
        const linkId = extractVideoId(query);
        if (linkId) {
            const title = await fetchTitle(linkId);
            const video = { id: linkId, title: title || `YouTube video ${linkId}`, author: '', duration: '', views: 0 };
            const session = createSession({ ...base, kind: 'single', video });
            return await showMenu(conn, session, 'fmt', formatMenu(video));
        }
        if (/^(https?:\/\/)?((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(query)) {
            return await say(MSG.searchPlaylistLink, true);
        }

        const status = await conn.sendMessage(from, { text: MSG.searching(query) }, { quoted: mek }).catch(() => null);
        const edit = async (text) => {
            if (!(await editMessage(conn, from, status && status.key, text))) await say(text).catch(() => {});
        };

        let results;
        try {
            results = await searchYouTube(query);
        } catch (err) {
            console.error('[ytaudl] search failed:', redact(err.message));
            return await edit(MSG.searchFailed(err.message));
        }
        if (!results.length) return await edit(MSG.noResults(query));

        const session = createSession({ ...base, kind: 'search', results });
        await showMenu(conn, session, 'pick', searchMenu(query, results));
        await edit(`🔎 *${shorten(query, 60)}* — ${results.length} results found ⬇️`);
    } catch (err) {
        console.error('[ytaudl] error:', redact(err && err.message));
        say(MSG.error).catch(() => {});
    }
}

// ─────────────── commands ───────────────
cmd({
    pattern: 'ytdl',
    desc: 'Search YouTube, pick a video with buttons and download it as audio / voice note / video',
    category: 'download',
    react: '🔎',
    filename: __filename,
},
(conn, mek, m, opts) => handleSearchCommand(conn, mek, m, opts));

cmd({
    pattern: 'ytaudl',
    desc: 'Download a YouTube video or playlist as audio',
    category: 'download',
    react: '🎧',
    filename: __filename,
},
(conn, mek, m, opts) => handleCommand(conn, mek, m, opts, 'audio'));

cmd({
    pattern: 'ytvcdl',
    desc: 'Download a YouTube video or playlist as a voice note',
    category: 'download',
    react: '🎤',
    filename: __filename,
},
(conn, mek, m, opts) => handleCommand(conn, mek, m, opts, 'voice'));

cmd({
    pattern: 'ytvdl',
    desc: 'Download a YouTube video or playlist as a video (choose quality + document / video)',
    category: 'download',
    react: '🎬',
    filename: __filename,
},
(conn, mek, m, opts) => handleCommand(conn, mek, m, opts, 'video'));

module.exports = {
    extractVideoId,
    extractPlaylistId,
    fetchPlaylist,
    downloadToFile,
    searchYouTube,
    fetchVideoInfo,
    downloadVideoToFile,
};
