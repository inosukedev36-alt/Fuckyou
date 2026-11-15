/**
 * ───────────────────────────────────────────────────────────────
 *  YouTube → Audio / Voice Note downloader — WhatsApp bot
 * ───────────────────────────────────────────────────────────────
 *  Commands:
 *    .ytaudl <link> [jid/lid]     → downloads as audio file
 *    .ytvcdl <link> [jid/lid]     → downloads as voice note (ptt)
 *    .ytaudl stop [jid/lid]       → cancel a running download
 *
 *  Links that work:
 *    • a video link                      → that one song
 *    • a playlist link                   → every video of the playlist
 *    • an auto-generated YouTube Mix     → (list=RD…) the videos of the Mix
 *    • a video link that also has a list → only the video, add "all" to get the whole list
 *        .ytaudl "https://www.youtube.com/watch?v=xxxxxxxxxxx&list=RDxxxxxxxxxxx" all
 * ───────────────────────────────────────────────────────────────
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);
const { cmd } = require('../command'); // ← change this path if needed

// ─────────────── settings ───────────────
const API_BASE = 'https://apix.wolvarex.com/api/music/ytmp3-net-download';
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
    usage: '❌ *Please provide a YouTube video or playlist link.*\n\n' +
        '📌 *Examples:*\n' +
        `${PREFIX_HINT}ytaudl https://youtu.be/xxxxxxxxxxx\n` +
        `${PREFIX_HINT}ytaudl https://www.youtube.com/playlist?list=PLxxxxxxxxxxxxxxxx\n` +
        `${PREFIX_HINT}ytaudl <link> 12345@g.us  (send to another chat)\n\n` +
        `ℹ️ A video link that also contains a playlist/Mix downloads only the video — add *all* to get the whole list:\n` +
        `${PREFIX_HINT}ytaudl <link> all\n\n` +
        `🛑 Send *${PREFIX_HINT}ytaudl stop* to cancel a running download.`,
    invalid: '❌ *That does not look like a valid YouTube video or playlist link.*\n\nPlease check the link and try again.',
    busy: '⏳ A download is already running in the target chat.\n\n' +
        `Please wait for it to finish, or send *${PREFIX_HINT}ytaudl stop* to cancel it.`,
    tooManyJobs: '⏳ The bot is busy with other downloads right now. Please try again in a few minutes.',
    nothingRunning: 'ℹ️ There is no running download in the target chat.',
    stopping: '🛑 Stopping... the current track will finish first.',
    playlistFetching: '⏳ Reading the playlist, please wait...',
    playlistEmpty: '⚠️ No available videos were found in this playlist.',
    error: '❌ Something went wrong while processing your request. Please try again later.',
    reason: (r) => (SHOW_ERROR_REASON && r ? `\n\n🔎 *Reason:* ${shorten(redact(r), 350)}` : ''),
    videoFailed: (r) => `❌ *Could not download this audio.*${MSG.reason(r)}`,
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

function mimeOf(headers, url) {
    const header = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (/^(audio|video)\//.test(header)) return header.replace(/^video\//, 'audio/');
    return urlParam(url, 'mime').toLowerCase() || 'audio/mpeg';
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

// ─────────────── send audio / voice note ───────────────
async function sendAudioFile(conn, targetJid, file, title, quotedMsg, voiceMode = false) {
    const fitsAudio = file.bytes <= AUDIO_MAX_MB * 1048576 && /^audio\/(mp4|mpeg|ogg|aac|webm)/.test(file.mime);
    let audioPath = file.path;
    let audioMime = file.mime;

    if (voiceMode && fitsAudio) {
        const oggPath = file.path.replace(/\.[^.]+$/, '.ogg');
        try {
            await execFilePromise('ffmpeg', [
                '-i', file.path,
                '-c:a', 'libopus',
                '-b:a', '64k',
                '-ar', '48000',
                '-ac', '1',
                '-y',
                oggPath
            ], { timeout: 60000 });

            audioPath = oggPath;
            audioMime = 'audio/ogg; codecs=opus';
        } catch (err) {
            console.error('[ytaudl] ffmpeg conversion failed:', err.message);
            voiceMode = false;
        }
    }

    const payload = fitsAudio
        ? { audio: { url: audioPath }, mimetype: audioMime, ptt: voiceMode }
        : { document: { url: file.path }, mimetype: file.mime, fileName: `${safeFileName(title)}.${file.ext}` };

    let sent = false;
    if (quotedMsg) {
        try {
            await conn.sendMessage(targetJid, payload, { quoted: quotedMsg });
            sent = true;
        } catch (err) {
            console.error('[ytaudl] reply failed, sending normally:', err.message);
        }
    }
    if (!sent) {
        await conn.sendMessage(targetJid, payload);
    }

    if (audioPath !== file.path) {
        await removeFile(audioPath);
    }
}

// ─────────────── header builder (playlist) ───────────────
function buildPlaylistHeader(playlistTitle, total, sent, extraLine) {
    const pct = total ? Math.round((sent / total) * 100) : 0;
    const bar = progressBar(pct, 14);
    const parts = [
        `📋 *Playlist:* ${playlistTitle}`,
        `🔢 *Videos:* ${total}`,
        '',
        `${bar} *${sent}/${total} sent* (${pct}%)`,
    ];
    if (extraLine) parts.push(extraLine);
    parts.push(`🛑 Send *${PREFIX_HINT}ytaudl stop* to cancel.`);
    return parts.join('\n');
}

// ─────────────── single video job ───────────────
async function downloadOne(conn, targetJid, mek, videoId, say, mode) {
    const icon = mode === 'voice' ? '🎤' : '🎵';

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

    const update = async (text) => {
        const ok = await editMessage(conn, targetJid, statusKey, text);
        if (!ok) await say(text).catch(() => {});
    };

    try {
        const file = await obtainAudio(videoId, dest, {
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
                    `📦 Size: ${info.size || 'unknown'} | 🎧 ${info.type || 'MP3'}\n` +
                    `👤 Source: ${info.creator || 'Wolvarex API'}\n\n` +
                    `${progressBar(0)} 0%`
                );
            },
            onProgress: async (written, total, percent) => {
                if (percent < 100 && percent - lastPercent < PROGRESS_STEP) return;
                lastPercent = percent;
                await update(
                    `${icon} *${shorten(meta?.title || `YouTube audio ${videoId}`, 100)}*\n\n` +
                    `${progressBar(percent)} ${percent}%\n` +
                    `📥 ${formatBytes(written)} / ${formatBytes(total)}`
                );
            },
        });

        await update(
            `✅ ${icon} *${shorten(file.meta.title, 100)}*\n` +
            `📦 ${formatBytes(file.bytes)}`
        );

        await humanPresence(conn, targetJid);

        // Reply to the same status message we edited
        await sendAudioFile(conn, targetJid, file, file.meta.title, statusMsg, mode === 'voice');
    } catch (err) {
        console.error('[ytaudl] video job failed:', redact(err.message));
        await update(MSG.videoFailed(err.message));
    } finally {
        await removeFile(dest);
    }
}

// ─────────────── playlist job ───────────────
async function downloadPlaylist(conn, targetJid, mek, listId, job, say, mode, hintVideoId) {
    const icon = mode === 'voice' ? '🎤' : '🎵';

    let headerMsg = null;
    try {
        headerMsg = await conn.sendMessage(targetJid, { text: MSG.playlistFetching }, mek ? { quoted: mek } : undefined);
    } catch {
        return say(MSG.error);
    }
    const headerKey = headerMsg && headerMsg.key;

    const updateHeader = async (text) => {
        const ok = await editMessage(conn, targetJid, headerKey, text);
        if (!ok) await say(text).catch(() => {});
    };

    // 1) read the playlist (normal playlists and auto-generated Mixes)
    let playlist;
    try {
        playlist = await fetchPlaylist(listId, MAX_PLAYLIST_TRACKS, hintVideoId);
    } catch (err) {
        console.error('[ytaudl] playlist failed:', redact(err.message));
        return updateHeader(MSG.playlistFailed(err.message));
    }

    const tracks = playlist.videos;
    if (!tracks.length) return updateHeader(MSG.playlistEmpty);

    // 2) header → playlist info + 0/N bar
    await updateHeader(buildPlaylistHeader(playlist.title, tracks.length, 0, '⏳ Starting...'));

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
            const file = await obtainAudio(track.id, dest, {
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
                        `📦 ${info.size || 'unknown'} | 🎧 ${info.type || 'MP3'}\n\n` +
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
            await sendAudioFile(conn, targetJid, file, file.meta.title, trackMsg, mode === 'voice');

            sent++;
            streak = 0;

            const extra = sent >= tracks.length
                ? '✅ *All tracks sent!*'
                : `⏳ Next: track ${i + 2}...`;
            await updateHeader(buildPlaylistHeader(playlist.title, tracks.length, sent, extra));

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

// ─────────────── shared command handler ───────────────
const jobs = new Map();

async function handleCommand(conn, mek, m, { from, q }, mode) {
    const say = (text, quote = false) =>
        conn.sendMessage(from, { text }, quote ? { quoted: mek } : undefined);

    try {
        const rawArgs = String(q || '').trim().split(/\s+/);
        const arg = rawArgs[0];
        const extras = rawArgs.slice(1);
        const possibleJid = extras.find((a) => /@(g\.us|s\.whatsapp\.net|lid)$/.test(a));
        const wantsAll = extras.some((a) => /^(all|mix|playlist)$/i.test(a));

        if (!arg) return await say(MSG.usage, true);

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

        if (jobs.has(targetJid)) return await say(MSG.busy, true);
        if (jobs.size >= MAX_JOBS_AT_ONCE) return await say(MSG.tooManyJobs, true);

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

// ─────────────── commands ───────────────
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

module.exports = { extractVideoId, extractPlaylistId, fetchPlaylist, downloadToFile };
