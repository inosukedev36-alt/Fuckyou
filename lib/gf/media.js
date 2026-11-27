'use strict';
/**
 * lib/gf/media.js — what he sends her besides text: photo · sticker · video · voice note / audio · document.
 *
 *   describe(mek)  what kind of media is this WhatsApp message? (null = plain text)
 *   tagOf(info)    "[photo]" / "[voice note]" / [document "cv.pdf"]  → how it is written in the 24h log
 *   load(info)     downloads it (size-capped, in memory — never a file in the bot folder) and gets it ready for Gemini
 *                  → { kind, label, caption, file: { buffer, filename, mimeType } | null, why }
 *                  file = null: she cannot open it (too big, too long, a kind of file Gemini cannot read, would not download)
 *
 * She "reads" it through Gemini: lib/gf/ai.js uploads `file` with her question (lib/gemini.js), plugins/girlfriends.js writes the prompt.
 *
 * Switches (env, or the same name in config.GF):  GF_MEDIA=off  (media is ignored, as before)   GF_MEDIA_MAX_MB=20
 * Voice notes are turned into mp3 first when ffmpeg exists (FFMPEG_PATH, ffmpeg-static, @ffmpeg-installer/ffmpeg or the server's ffmpeg).
 */
const { spawn } = require('child_process');

let config = {};
try { config = require('../../config'); } catch { /* the config is optional here */ }
let mimeTypes = null;
try { mimeTypes = require('mime-types'); } catch { /* optional */ }

const gfc = () => (config && config.GF) || {};

function enabled() {
    const v = String(process.env.GF_MEDIA ?? gfc().MEDIA ?? 'on');
    return !/^(off|false|0|no)$/i.test(v);
}
const maxBytes = () => Math.round((Number(process.env.GF_MEDIA_MAX_MB || gfc().MEDIA_MAX_MB) || 20) * 1024 * 1024);
const MAX_AUDIO_SECONDS = 600;
const MAX_VIDEO_SECONDS = 180;

const num = (v) => Number(v && typeof v.toNumber === 'function' ? v.toNumber() : v) || 0;       // protobuf Long or number
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms).unref())]);

// ═════════════════════════ what is this message? ═════════════════════════
const SPEC = {
    imageMessage: { kind: 'photo', dl: 'image' },
    stickerMessage: { kind: 'sticker', dl: 'sticker' },
    videoMessage: { kind: 'video', dl: 'video' },
    audioMessage: { kind: 'audio', dl: 'audio' },
    documentMessage: { kind: 'document', dl: 'document' },
};
// same rule as baileys' getContentType(): the first "...Message" key of the message
const typeOf = (message) => (message
    ? Object.keys(message).find((k) => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage')
    : undefined);

function describe(mek) {
    try {
        const message = mek && mek.message;
        let type = typeOf(message);
        let node = type && message[type];
        if (type === 'documentWithCaptionMessage') {          // a document with a caption is wrapped once more
            node = node && node.message && node.message.documentMessage;
            type = 'documentMessage';
        }
        const spec = SPEC[type];
        if (!spec || !node || typeof node !== 'object') return null;
        const info = {
            type, node, kind: spec.kind, dl: spec.dl,
            caption: String(node.caption || '').trim(),
            mime: String(node.mimetype || '').split(';')[0].trim().toLowerCase(),
            fileName: String(node.fileName || '').trim(),
            seconds: num(node.seconds),
            bytes: num(node.fileLength),
        };
        if (type === 'audioMessage') info.kind = node.ptt ? 'voice' : 'audio';
        return info;
    } catch {
        return null;
    }
}

const LABEL = { photo: 'photo', sticker: 'sticker', video: 'video', voice: 'voice note', audio: 'audio file', document: 'document' };
function labelOf(info) {
    const base = LABEL[info.kind] || 'file';
    return info.kind === 'document' && info.fileName ? `${base} "${info.fileName.replace(/["\r\n]/g, '').slice(0, 60)}"` : base;
}
const tagOf = (info) => `[${labelOf(info)}]`;

// ═════════════════════════ which files can Gemini read? ═════════════════════════
const TEXT_EXT = new Set(['txt', 'md', 'py', 'js', 'mjs', 'ts', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'php', 'rb', 'sh', 'sql', 'yml', 'yaml', 'ini', 'log', 'srt']);
const OFFICE_EXT = new Set(['pdf', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'rtf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);
const FIXED_MIME = { csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html', md: 'text/markdown', pdf: 'application/pdf' };

function extOf(name) { return ((String(name).match(/\.([a-z0-9]{1,8})$/i) || [])[1] || '').toLowerCase(); }
const AUDIO_EXT = { 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac' };
function extFromMime(mime, fallback) {
    if (AUDIO_EXT[mime]) return AUDIO_EXT[mime];
    const e = mimeTypes && mime ? mimeTypes.extension(mime) : '';
    return e || fallback;
}

/** { filename, mimeType } for the upload, or null when Gemini cannot read this kind of file */
function fileSpec(info) {
    const mime = info.mime;
    switch (info.kind) {
        case 'photo':
            return { filename: `photo.${extFromMime(mime, 'jpg')}`, mimeType: mime.startsWith('image/') ? mime : 'image/jpeg' };
        case 'sticker':
            return { filename: 'sticker.webp', mimeType: 'image/webp' };
        case 'video':
            return { filename: `video.${extFromMime(mime, 'mp4')}`, mimeType: mime.startsWith('video/') ? mime : 'video/mp4' };
        case 'voice':
        case 'audio':
            return { filename: `${info.kind === 'voice' ? 'voice' : 'audio'}.${extFromMime(mime, 'ogg')}`, mimeType: mime.startsWith('audio/') ? mime : 'audio/ogg' };
        case 'document': {
            const ext = extOf(info.fileName) || extFromMime(mime, '');           // a document without an extension in its name: take it from its type
            const name = info.fileName || `document${ext ? '.' + ext : ''}`;
            if (/^(image|audio|video)\//.test(mime)) return { filename: name, mimeType: mime };         // a photo / song sent "as a document"
            if (TEXT_EXT.has(ext)) return { filename: name, mimeType: FIXED_MIME[ext] || 'text/plain' };
            if (OFFICE_EXT.has(ext)) return { filename: name, mimeType: FIXED_MIME[ext] || mime || (mimeTypes && mimeTypes.lookup(ext)) || 'application/octet-stream' };
            return null;                                                                                 // zip, apk, exe …
        }
        default:
            return null;
    }
}

// ═════════════════════════ download ═════════════════════════
async function download(info, limit) {
    let b = null;
    try { b = require('@dnuzi/baileys'); } catch { /* handled below */ }
    const fn = b && (b.downloadContentFromMessage || (b.default && b.default.downloadContentFromMessage));
    if (!fn) throw Object.assign(new Error('Baileys downloadContentFromMessage not found'), { code: 'NO_BAILEYS' });
    const stream = await fn(info.node, info.dl);
    const chunks = [];
    let size = 0;
    try {
        for await (const chunk of stream) {
            size += chunk.length;
            if (size > limit) throw Object.assign(new Error('too big'), { code: 'TOO_BIG' });
            chunks.push(chunk);
        }
    } finally {
        try { if (stream && typeof stream.destroy === 'function') stream.destroy(); } catch { /* already closed */ }
    }
    return Buffer.concat(chunks);
}

// ═════════════════════════ voice note → mp3 (best effort) ═════════════════════════
let ffmpegBin;            // undefined = not looked for yet · null = there is none
function findFfmpeg() {
    if (ffmpegBin !== undefined) return ffmpegBin;
    const found = [];
    if (process.env.FFMPEG_PATH) found.push(process.env.FFMPEG_PATH);
    for (const name of ['ffmpeg-static', '@ffmpeg-installer/ffmpeg']) {
        try {
            const m = require(name);
            const p = typeof m === 'string' ? m : m && m.path;
            if (p) found.push(p);
        } catch { /* not installed */ }
    }
    found.push('ffmpeg');
    ffmpegBin = found[0];
    return ffmpegBin;
}

function toMp3(buffer) {
    return new Promise((resolve) => {
        const bin = findFfmpeg();
        if (!bin) return resolve(null);
        let child;
        try {
            child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '24000', '-b:a', '48k', '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
        } catch {
            ffmpegBin = null;
            return resolve(null);
        }
        const out = [];
        let finished = false;
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(null); }, 25_000);
        function finish(v) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            resolve(v);
        }
        child.stdout.on('data', (c) => out.push(c));
        child.on('error', (e) => { if (e && e.code === 'ENOENT') ffmpegBin = null; finish(null); });
        child.on('close', (code) => finish(code === 0 && out.length ? Buffer.concat(out) : null));
        child.stdin.on('error', () => { /* ffmpeg quit early */ });
        child.stdin.end(buffer);
    });
}

// ═════════════════════════ load ═════════════════════════
async function load(info) {
    const out = { kind: info.kind, label: labelOf(info), caption: info.caption, file: null, why: '' };
    const limit = maxBytes();
    if (info.bytes && info.bytes > limit) { out.why = `too big, ${Math.round(info.bytes / 1048576)} MB`; return out; }
    if ((info.kind === 'voice' || info.kind === 'audio') && info.seconds > MAX_AUDIO_SECONDS) { out.why = 'too long'; return out; }
    if (info.kind === 'video' && info.seconds > MAX_VIDEO_SECONDS) { out.why = 'too long'; return out; }

    const spec = fileSpec(info);
    if (!spec) { out.why = 'a kind of file you cannot open'; return out; }

    let buffer;
    try {
        buffer = await withTimeout(download(info, limit), 45_000);
    } catch (e) {
        out.why = e && e.code === 'TOO_BIG' ? 'too big' : 'it did not download';
        return out;
    }
    if (!buffer || !buffer.length) { out.why = 'it did not download'; return out; }

    if (info.kind === 'voice' || info.kind === 'audio') {       // WhatsApp voice notes are ogg/opus; mp3 is what Gemini reads most reliably
        const mp3 = await toMp3(buffer);
        if (mp3) { buffer = mp3; spec.filename = `${info.kind === 'voice' ? 'voice' : 'audio'}.mp3`; spec.mimeType = 'audio/mpeg'; }
    }
    out.file = { buffer, filename: spec.filename, mimeType: spec.mimeType };
    return out;
}

module.exports = { enabled, describe, labelOf, tagOf, load };
