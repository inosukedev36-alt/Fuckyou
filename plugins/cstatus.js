const { cmd } = require('../command');
const { downloadMediaMessage } = require('@dnuzi/baileys');
const pino = require('pino');
const config = require('../config');

const botFooter = config.FOOTER
    ? config.FOOTER.trim()
    : `> ᴩᴏᴡᴇʀᴇᴅ ʙʏ ﹫ᴋᴄᴇʏ ᴩʀɪᴠᴀᴛᴇ ʙᴏᴛ`;

const logger = pino({ level: 'silent' });
const running = new Set();
const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage'];

function unwrap(message) {
    let current = message;
    for (let i = 0; current && i < 12; i++) {
        const inner =
            current.ephemeralMessage?.message ||
            current.viewOnceMessageV2?.message ||
            current.viewOnceMessage?.message ||
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

cmd({
    pattern: 'cstatus',
    alias: ['channelstatus', 'cs'],
    react: '📢',
    desc: 'Publish channel (newsletter) status',
    category: 'channel',
    use: '.cstatus <channel-jid> <text | reply to media>',
    filename: __filename
},
async (conn, mek, m, { from, q, isOwner, reply }) => {
    if (!isOwner) return reply(`🚫 *Owner only command.*\n\n${botFooter}`);

    const text = String(q || '').trim();
    if (!text) {
        return reply(
            `❎ *Usage:*\n\n` +
            `> *Text status:*\n` +
            `> .cstatus 123456789@newsletter Hello world\n\n` +
            `> *Media status* (reply to image/video/voice):\n` +
            `> .cstatus 123456789@newsletter [caption]\n\n` +
            `${botFooter}`
        );
    }

    const parts = text.split(/\s+/);
    const jid = parts.shift();
    const typedCaption = parts.join(' ').trim();

    if (!/^\d+@newsletter$/.test(jid)) {
        return reply(`⛔ *Invalid Channel JID!*\n\n${botFooter}`);
    }

    if (typeof conn.sendNewsletterStatus !== 'function') {
        return reply(
            `❌ \`sendNewsletterStatus()\` is unavailable in your Baileys version.\n\n${botFooter}`
        );
    }

    const lock = jid;
    if (running.has(lock)) {
        return reply(`⛔ *A request is already running for this channel!*\n\n${botFooter}`);
    }
    running.add(lock);

    let progMsg;

    try {
        // Permission check (silent if method unavailable)
        if (typeof conn.newsletterCanPostStatus === 'function') {
            try {
                const permission = await conn.newsletterCanPostStatus(jid);
                if (permission && permission.canPost === false) {
                    throw new Error('This channel cannot publish statuses.');
                }
            } catch (permErr) {
                if (/cannot publish/i.test(permErr.message)) throw permErr;
                // ignore other errors from permission check
            }
        }

        await conn.sendMessage(from, { react: { text: '⏳', key: mek.key } }).catch(() => {});
        progMsg = await conn.sendMessage(
            from,
            { text: `📢 *𝐏𝐫𝐞𝐩𝐚𝐫𝐢𝐧𝐠 𝐂𝐡𝐚𝐧𝐧𝐞𝐥 𝐒𝐭𝐚𝐭𝐮𝐬...*` },
            { quoted: mek }
        );

        const found = getQuoted(mek);
        let payload;
        let statusType = 'TEXT';
        let finalCaption = typedCaption || '';

        if (!found) {
            if (!typedCaption) {
                throw new Error('No media replied and no text provided.');
            }
            payload = { text: typedCaption };
        } else {
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

            if (!buffer || buffer.length === 0) {
                throw new Error('Failed to download media.');
            }

            if (type === 'image') {
                finalCaption = typedCaption || info.caption || '';
                payload = { image: buffer, caption: finalCaption };
                statusType = 'IMAGE';

            } else if (type === 'video') {
                finalCaption = typedCaption || info.caption || '';
                payload = {
                    video: buffer,
                    caption: finalCaption,
                    mimetype: info.mimetype || 'video/mp4'
                };
                if (info.seconds) payload.seconds = info.seconds;
                statusType = 'VIDEO';

            } else if (type === 'audio' && info.ptt === true) {
                payload = {
                    audio: buffer,
                    mimetype: info.mimetype || 'audio/ogg; codecs=opus',
                    ptt: true
                };
                if (info.seconds) payload.seconds = info.seconds;
                statusType = 'VOICE';

            } else {
                throw new Error('Replied media must be an image, video, or voice note.');
            }
        }

        await conn.sendMessage(from, {
            text: `📤 *𝐔𝐩𝐥𝐨𝐚𝐝𝐢𝐧𝐠 𝐒𝐭𝐚𝐭𝐮𝐬 𝐭𝐨 𝐂𝐡𝐚𝐧𝐧𝐞𝐥...*\n> ⏳ Please wait!`,
            edit: progMsg.key
        }).catch(() => {});

        const result = await conn.sendNewsletterStatus(jid, payload);
        console.log('CSTATUS RESULT:', result);

        const finalCap =
            `✅ *𝐂𝐡𝐚𝐧𝐧𝐞𝐥 𝐒𝐭𝐚𝐭𝐮𝐬 𝐏𝐨𝐬𝐭𝐞𝐝!*\n\n` +
            `- 📢 \`Channel\` ➜ *${jid.split('@')[0]}*\n` +
            `- 📁 \`Type\` ➜ *${statusType}*\n` +
            `- 📝 \`Caption\` ➜ *${finalCaption || 'None'}*\n\n` +
            `${botFooter}`;

        await conn.sendMessage(from, { text: finalCap, edit: progMsg.key }).catch(() => {});
        await conn.sendMessage(from, { react: { text: '✅', key: mek.key } }).catch(() => {});

    } catch (e) {
        console.error('CStatus Error:', e);
        if (progMsg) {
            await conn.sendMessage(from, {
                text: `⛔ *Error:* ${e.message}\n\n${botFooter}`,
                edit: progMsg.key
            }).catch(() => {});
        } else {
            await reply(`⛔ *Error:* ${e.message}\n\n${botFooter}`).catch(() => {});
        }
        await conn.sendMessage(from, { react: { text: '❌', key: mek.key } }).catch(() => {});
    } finally {
        running.delete(lock);
    }
});
