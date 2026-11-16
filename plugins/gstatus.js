const { cmd } = require('../command');
const { downloadMediaMessage, generateWAMessage, generateWAMessageContent, generateWAMessageFromContent } = require('@dnuzi/baileys');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const pino = require('pino');
const config = require('../config');

const botFooter = config.FOOTER ? config.FOOTER.trim() : `> ᴩᴏᴡᴇʀᴇᴅ ʙʏ ﹫ᴋᴄᴇʏ ᴩʀɪᴠᴀᴛᴇ ʙᴏᴛ`;
const logger = pino({ level: 'silent' });
const running = new Set();
const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage'];

const COLORS = {
    black: '000000', white: 'FFFFFF', red: 'FF0000', green: '00A859',
    blue: '1E88E5', yellow: 'FFD600', orange: 'FF6D00', purple: '8E24AA',
    pink: 'EC407A', teal: '00897B', grey: '607D8B', gray: '607D8B', brown: '6D4C41'
};

function parseColor(input) {
    const v = String(input || '').trim().toLowerCase().replace('#', '');
    let hex = COLORS[v];
    if (!hex && /^[0-9a-f]{6}$/.test(v)) hex = v;
    if (!hex) hex = '000000';
    return (0xFF000000 | parseInt(hex, 16)) >>> 0;
}

function unwrap(message) {
    let current = message;
    for (let i = 0; current && i < 12; i++) {
        const inner = current.ephemeralMessage?.message ||
            current.viewOnceMessageV2?.message || current.viewOnceMessage?.message ||
            current.viewOnceMessageV2Extension?.message;
        if (!inner) return current;
        current = inner;
    }
    return current || null;
}

function getQuoted(mek) {
    const content = unwrap(mek.message);
    if (!content) return null;
    let ctx;
    for (const value of Object.values(content)) {
        if (value && typeof value === 'object' && value.contextInfo?.quotedMessage) {
            ctx = value.contextInfo;
            break;
        }
    }
    if (!ctx) return null;
    const message = unwrap(ctx.quotedMessage);
    const mediaKey = MEDIA_TYPES.find(key => message?.[key]);
    if (!mediaKey) return null;
    return {
        message,
        mediaKey,
        stanzaId: ctx.stanzaId,
        participant: ctx.participant,
        remoteJid: ctx.remoteJid || mek.key.remoteJid
    };
}

function toOpus(buffer) {
    const id = crypto.randomBytes(6).toString('hex');
    const inp = path.join(os.tmpdir(), `in_${id}`);
    const out = path.join(os.tmpdir(), `out_${id}.ogg`);
    fs.writeFileSync(inp, buffer);
    try {
        execFileSync('ffmpeg', ['-y', '-i', inp, '-vn', '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1', out], { stdio: 'ignore' });
        return fs.readFileSync(out);
    } finally {
        try { fs.unlinkSync(inp); } catch {}
        try { fs.unlinkSync(out); } catch {}
    }
}

function getWaveform(opusBuffer) {
    const pcm = execFileSync(
        'ffmpeg',
        ['-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '8000', 'pipe:1'],
        { input: opusBuffer, stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 * 200 }
    );
    const total = Math.floor(pcm.length / 2);
    const bars = 64;
    const size = Math.max(1, Math.floor(total / bars));
    const values = [];
    for (let i = 0; i < bars; i++) {
        let sum = 0;
        let count = 0;
        const start = i * size;
        const end = Math.min(start + size, total);
        for (let j = start; j < end; j++) {
            const s = pcm.readInt16LE(j * 2);
            sum += s * s;
            count++;
        }
        values.push(count ? Math.sqrt(sum / count) : 0);
    }
    const max = Math.max(...values, 1);
    return Buffer.from(values.map(v => Math.round(Math.pow(v / max, 0.7) * 100)));
}

async function sendAudioStatus(conn, groupJid, buffer, seconds, color) {
    const opus = toOpus(buffer);
    const inside = await generateWAMessageContent(
        {
            audio: opus,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
            seconds: seconds || undefined
        },
        { upload: conn.waUploadToServer }
    );
    inside.audioMessage.backgroundArgb = color;
    inside.audioMessage.waveform = getWaveform(opus);

    const msg = generateWAMessageFromContent(groupJid, {
        groupStatusMessageV2: {
            message: {
                ...inside,
                messageContextInfo: { messageSecret: crypto.randomBytes(32) }
            }
        }
    }, {});

    await conn.relayMessage(groupJid, msg.message, { messageId: msg.key.id });
    return msg;
}

async function makeImageVideo(audioBuffer, imageUrl) {
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error('Failed to download image.');
    const img = Buffer.from(await res.arrayBuffer());

    const id = crypto.randomBytes(6).toString('hex');
    const imgPath = path.join(os.tmpdir(), `img_${id}`);
    const audPath = path.join(os.tmpdir(), `aud_${id}`);
    const outPath = path.join(os.tmpdir(), `vid_${id}.mp4`);
    fs.writeFileSync(imgPath, img);
    fs.writeFileSync(audPath, audioBuffer);
    try {
        execFileSync('ffmpeg', [
            '-y', '-loop', '1', '-i', imgPath, '-i', audPath,
            '-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280',
            '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', '10',
            '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', outPath
        ], { stdio: 'ignore' });
        return fs.readFileSync(outPath);
    } finally {
        try { fs.unlinkSync(imgPath); } catch {}
        try { fs.unlinkSync(audPath); } catch {}
        try { fs.unlinkSync(outPath); } catch {}
    }
}

cmd({
    pattern: 'gstatus',
    alias: ['gs', 'groupstatus'],
    react: '📢',
    desc: 'Post replied media as a group status',
    category: 'owner',
    use: '.gstatus <group-jid>, <caption | color | image-url>',
    filename: __filename
},
async (conn, mek, m, { from, q, isOwner, reply }) => {
    if (!isOwner) return;

    const text = String(q || '').trim();
    const comma = text.indexOf(',');
    const groupJid = (comma < 0 ? text : text.slice(0, comma)).trim();
    const typedCaption = comma < 0 ? '' : text.slice(comma + 1).trim();

    if (!/^\d+(?:-\d+)?@g\.us$/.test(groupJid)) {
        let helpText = `⛔ *Invalid Group JID!*\n\n`;
        helpText += `*Usage:*\n`;
        helpText += `> Reply to an image, video, or audio\n`;
        helpText += `> .gs 1234567890-123@g.us, caption\n`;
        helpText += `> Audio Color: .gs jid, red (or #ff0000)\n`;
        helpText += `> Audio Image: .gs jid, https://link.jpg\n\n`;
        helpText += `${botFooter}`;
        return reply(helpText);
    }

    const found = getQuoted(mek);
    if (!found) return reply(`⛔ *Please reply to an image, video, or audio!*\n\n${botFooter}`);

    const lock = groupJid;
    if (running.has(lock)) return reply(`⛔ *A request is already running for this group!*\n\n${botFooter}`);
    running.add(lock);

    let progMsg;

    try {
        await conn.sendMessage(from, { react: { text: '⏳', key: mek.key } }).catch(() => {});
        progMsg = await conn.sendMessage(from, { text: `📢 *𝐏𝐫𝐞𝐩𝐚𝐫𝐢𝐧𝐠 𝐆𝐫𝐨𝐮𝐩 𝐒𝐭𝐚𝐭𝐮𝐬...*` }, { quoted: mek });

        const info = found.message[found.mediaKey];
        const type = found.mediaKey.replace('Message', '');

        const key = {
            remoteJid: found.remoteJid,
            id: found.stanzaId,
            fromMe: found.participant === conn.user.id
        };
        if (found.participant) key.participant = found.participant;

        const buffer = await downloadMediaMessage(
            { key, message: found.message },
            'buffer',
            {},
            { logger, reuploadRequest: conn.updateMediaMessage }
        );

        if (!buffer || buffer.length === 0) throw new Error('Failed to download media.');

        await conn.sendMessage(from, { text: `📤 *𝐔𝐩𝐥𝐨𝐚𝐝𝐢𝐧𝐠 𝐒𝐭𝐚𝐭𝐮𝐬 𝐭𝐨 𝐆𝐫𝐨𝐮𝐩...*\n> ⏳ Please wait!`, edit: progMsg.key }).catch(() => {});

        let shownType = type.toUpperCase();

        if (type === 'audio' && /^https?:\/\//i.test(typedCaption)) {
            const videoBuffer = await makeImageVideo(buffer, typedCaption);
            const generated = await generateWAMessage(groupJid, {
                groupStatus: true,
                video: videoBuffer,
                mimetype: 'video/mp4',
                caption: ''
            }, {
                userJid: conn.user.id,
                upload: conn.waUploadToServer,
                logger
            });
            if (!generated || !generated.message) throw new Error('Failed to generate status message.');
            await conn.relayMessage(groupJid, generated.message, { messageId: generated.key.id });
            shownType = 'AUDIO + IMAGE';
        } else if (type === 'audio') {
            await sendAudioStatus(conn, groupJid, buffer, info.seconds, parseColor(typedCaption));
        } else {
            const payload = { groupStatus: true };

            if (type === 'image') {
                payload.image = buffer;
                payload.caption = typedCaption || info.caption || '';
            } else if (type === 'video') {
                payload.video = buffer;
                payload.caption = typedCaption || info.caption || '';
                payload.mimetype = info.mimetype || 'video/mp4';
                if (info.seconds) payload.seconds = info.seconds;
                if (info.gifPlayback) payload.gifPlayback = true;
            }

            const generated = await generateWAMessage(groupJid, payload, {
                userJid: conn.user.id,
                upload: conn.waUploadToServer,
                logger
            });

            if (!generated || !generated.message) throw new Error('Failed to generate status message.');

            await conn.relayMessage(groupJid, generated.message, { messageId: generated.key.id });
        }

        let finalCap = `✅ *𝐆𝐫𝐨𝐮𝐩 𝐒𝐭𝐚𝐭𝐮𝐬 𝐏𝐨𝐬𝐭𝐞𝐝!*\n\n`;
        finalCap += `- 👥 \`Group\` ➜ *${groupJid.split('@')[0]}*\n`;
        finalCap += `- 📁 \`Type\` ➜ *${shownType}*\n\n`;
        finalCap += `${botFooter}`;

        await conn.sendMessage(from, { text: finalCap, edit: progMsg.key }).catch(() => {});
        await conn.sendMessage(from, { react: { text: '✅', key: mek.key } }).catch(() => {});

    } catch (e) {
        console.error('GStatus Error:', e);
        if (progMsg) {
            await conn.sendMessage(from, { text: `⛔ *Error:* ${e.message}\n\n${botFooter}`, edit: progMsg.key }).catch(() => {});
        } else {
            reply(`⛔ *Error:* ${e.message}\n\n${botFooter}`);
        }
        await conn.sendMessage(from, { react: { text: '❌', key: mek.key } }).catch(() => {});
    } finally {
        running.delete(lock);
    }
});
