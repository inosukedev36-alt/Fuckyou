// View-once media retrieve කරලා bot inbox (සහ ඔයා දෙන වෙනත් chats) වලට යවන plugin එක (auto + .vv manual)
const { cmd } = require('../command');
// [gf-integration] this project uses the @dnuzi/baileys fork (there is no @whiskeysockets/baileys installed)
const { downloadContentFromMessage, jidNormalizedUser } = require('@dnuzi/baileys');

// ───────────────────────── ⚙️ Settings ─────────────────────────

// false කළොත් auto retrieval නවතිනවා (.vv command එක ඒ විදිහටම වැඩ කරනවා)
const AUTO_VV = true;

// Bot ගේම "Message yourself" chat එකටත් යවනවද? (ඒ account එක ඔයා ළඟ නැත්නම් false කරන්නත් පුළුවන්)
const SEND_TO_SELF = true;

// ඊට අමතරව media යවන්න ඕන තැන් (ඕනෑම ගාණක් දාන්න පුළුවන්):
//   '94771234567'                    → personal number (country code එක්ක)
//   '120363012345678901@g.us'        → group   (bot ඒ group එකේ member වෙන්න ඕනේ)
//   '120363012345678901@newsletter'  → channel (bot ඒ channel එකේ admin/owner වෙන්න ඕනේ)
// ⚠️ Group එකේ members හැමෝටම, channel එකේ followers හැමෝටම මේ media පේනවා.
//    ඒ නිසා ඔයාගේ personal number එක, නැත්නම් ඔයා විතරක් ඉන්න private group එකක් පාවිච්චි කරන්න.
const EXTRA_TARGETS = [
    // '94771234567',
];

// 0771234567 වගේ local number එකක් දුන්නොත් ඉස්සරහ 0 අයින් කරලා මේ code එක දානවා
const COUNTRY_CODE = '94';

const VIEW_ONCE_WRAPPERS = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage'];

// ───────────────────────── Helpers ─────────────────────────

// Message එකක් ඇතුළේ view-once media තියෙනවද බලනවා → { type, media } හෝ null
function extractViewOnce(message) {
    if (!message) return null;

    // Disappearing-messages chat වල තියෙන ephemeral wrapper එක අයින් කරනවා
    if (message.ephemeralMessage?.message) message = message.ephemeralMessage.message;

    // 1) wrapper format: viewOnceMessage / viewOnceMessageV2 / viewOnceMessageV2Extension
    const wrapperKey = VIEW_ONCE_WRAPPERS.find(k => message[k]);
    if (wrapperKey) {
        const inner = message[wrapperKey]?.message;
        // ⚠️ Object.keys(inner)[0] පාවිච්චි කරන්න එපා – පළවෙනි key එක messageContextInfo වෙන්න පුළුවන්
        const type = inner && MEDIA_TYPES.find(t => inner[t]);
        return type ? { type, media: inner[type] } : null;
    }

    // 2) wrapper එකක් නැතුව, media message එක ඇතුළේම viewOnce: true flag එක තියෙන format එක
    const type = MEDIA_TYPES.find(t => message[t]?.viewOnce);
    return type ? { type, media: message[type] } : null;
}

// ඕනෑම message type එකක contextInfo එක ගන්නවා (reply කරපු message එක තියෙන්නේ මේක ඇතුළේ)
function getContextInfo(message) {
    if (!message) return null;
    if (message.ephemeralMessage?.message) message = message.ephemeralMessage.message;
    const key = Object.keys(message).find(k => message[k]?.contextInfo);
    return key ? message[key].contextInfo : null;
}

// Media download කරලා Buffer එකක් දෙනවා
// (chunks එකතු කරලා අන්තිමට එක පාරක් විතරක් concat කරනවා – ලොකු video වලට වේගවත් සහ memory අඩුයි)
async function downloadMedia(media, type) {
    const stream = await downloadContentFromMessage(media, type.replace('Message', ''));
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    if (!buffer.length) throw new Error('Downloaded media is empty');
    return buffer;
}

// Number / JID එකක් WhatsApp JID එකක් බවට හරවනවා
function toJid(target) {
    const t = String(target ?? '').trim();
    if (!t) return null;
    if (t.includes('@')) return t;                       // සම්පූර්ණ JID එකක් (group / channel / user)
    let digits = t.replace(/\D/g, '');                   // "+94 77 123 4567" වගේ දේවල් පිරිසිදු කරනවා
    if (digits.startsWith('0')) digits = COUNTRY_CODE + digits.slice(1);
    return digits ? `${digits}@s.whatsapp.net` : null;
}

// Media යවන්න ඕන JID ලැයිස්තුව: bot ගේම chat එක (SEND_TO_SELF) + EXTRA_TARGETS (duplicate අයින් කරලා)
function getTargets(conn) {
    const list = SEND_TO_SELF ? [jidNormalizedUser(conn.user.id)] : [];
    for (const t of EXTRA_TARGETS) {
        const jid = toJid(t);
        if (jid) list.push(jid);
    }
    return [...new Set(list)];
}

// එක target එකකට media (image / video / audio) යවනවා
async function sendMedia(conn, jid, { type, media, buffer, caption, mentions }) {
    if (type === 'imageMessage') {
        await conn.sendMessage(jid, { image: buffer, caption, mentions });
    } else if (type === 'videoMessage') {
        await conn.sendMessage(jid, { video: buffer, caption, mimetype: media.mimetype || 'video/mp4', mentions });
    } else if (type === 'audioMessage') {
        await conn.sendMessage(jid, { audio: buffer, mimetype: media.mimetype || 'audio/ogg; codecs=opus', ptt: true });
        await conn.sendMessage(jid, { text: caption, mentions });
    }
}

// හැම target එකටම යවනවා – එකක් fail වුණාට අනිත් ඒවා නවතින්නේ නෑ.
// ඔක්කොම fail වුණොත් විතරයි error එකක් throw කරන්නේ; නැත්නම් { total, failed } return කරනවා
async function sendToInbox(conn, { type, media, buffer, title, from, senderId, targets }) {
    const mentions = [senderId];
    const caption = `${title}

◈ *𝚃𝚈𝙿𝙴:* ${type.replace('Message', '').toUpperCase()}
◈ *𝙵𝚁𝙾𝙼:* ${from.split('@')[0]}
◈ *𝚂𝙴𝙽𝙳𝙴𝚁:* @${senderId.split('@')[0]}

> © ᴅᴛᴢ ᴍɪᴢᴜᴋɪ ᴍᴅ`;

    const failed = [];
    for (const jid of targets) {
        try {
            await sendMedia(conn, jid, { type, media, buffer, caption, mentions });
        } catch (e) {
            const why = e?.message || String(e);
            console.log(`VV_SEND_ERROR (${jid}):`, why);
            failed.push(`${jid} (${why})`);
        }
    }
    if (failed.length === targets.length) throw new Error('Could not send to any target: ' + failed.join(', '));
    return { total: targets.length, failed };
}

// ───────────────────── 🟢 AUTO VIEW-ONCE RETRIEVAL ─────────────────────

async function handleAutoViewOnce(conn, mek) {
    if (!AUTO_VV) return;
    if (!mek?.message || mek.key?.fromMe) return;   // bot ගේම messages skip (self-loop වළක්වන්න)

    const found = extractViewOnce(mek.message);
    if (!found) return;                              // View Once message එකක් නෙමෙයි

    const targets = getTargets(conn);
    if (!targets.length) return;                     // යවන්න තැනක් නැත්නම් download කරන්නත් එපා

    const from = mek.key.remoteJid;
    const senderId = mek.key.participant || from;    // group එකේ නම් participant, නැත්නම් chat එකම

    const buffer = await downloadMedia(found.media, found.type);
    await sendToInbox(conn, { ...found, buffer, title: '🔓 *AUTO VIEW-ONCE RETRIEVED*', from, senderId, targets });
}

// එක connection එකකට listener එක සවි කරන්නේ එක පාරයි (reconnect වෙලා අලුත් conn එකක් ආවොත් ආයෙත් සවි වෙනවා)
const hookedConns = new WeakSet();

function hookAutoViewOnce(conn) {
    if (!conn?.ev || hookedConns.has(conn)) return;
    hookedConns.add(conn);

    conn.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;               // history sync වගේ ඒවා skip
        for (const mek of messages) {
            try {
                await handleAutoViewOnce(conn, mek);
            } catch (e) {
                console.log('AUTO_VV_ERROR:', e);
            }
        }
    });
}

// [gf-integration] pair.js calls every function in events.socketHooks for each new WhatsApp connection, so auto retrieval starts at once
// (not only after the first text message arrives).
const _events = require('../command');
(_events.socketHooks = _events.socketHooks || []).push(hookAutoViewOnce);

// ℹ️ View-once message එකට text `body` එකක් නැති නිසා, `if (body && command.on === "body")` වගේ
// check එකක් තියෙන framework වල ඒක මේ handler එකට කවදාවත් එන්නේ නෑ (පරණ code එක වැඩ නොකරපු ප්‍රධාන හේතුව).
// ඒ නිසා මෙතනින් කරන්නේ conn.ev listener එක සවි කරන එක විතරයි –
// bot start වුණාට පස්සේ එන පළවෙනි text message එකෙන් ඒක සවි වෙනවා.
cmd({
    on: "body"
},
async (conn) => {
    hookAutoViewOnce(conn);
});

// ───────────────────── 🟡 Manual retrieval command (backup) ─────────────────────

cmd({
    pattern: "vv",
    alias: ["viewonce", "retrieve"],
    desc: "Retrieve View Once media and send to Bot Inbox.",
    category: "owner",
    react: "🔓",
    filename: __filename
},
async (conn, mek, m, { from, isOwner, reply }) => {
    try {
        if (!isOwner) return reply("❌ 𝗬𝗼𝘂 𝗮𝗿𝗲 𝗻𝗼𝘁 𝘁𝗵𝗲 𝗼𝘄𝗻𝗲𝗿!");

        const targets = getTargets(conn);
        if (!targets.length) return reply("❌ No target set. Turn on SEND_TO_SELF or add a number/JID to EXTRA_TARGETS.");

        const ctx = getContextInfo(mek.message);
        if (!ctx?.stanzaId && !ctx?.quotedMessage) return reply("❌ 𝗣𝗹𝗲𝗮𝘀𝗲 𝗿𝗲𝗽𝗹𝘆 𝘁𝗼 𝗮 𝗩𝗶𝗲𝘄 𝗢𝗻𝗰𝗲 𝗺𝗲𝘀𝘀𝗮𝗴𝗲.");
        if (!ctx.quotedMessage) return reply("❌ 𝗖𝗼𝘂𝗹𝗱 𝗻𝗼𝘁 𝗳𝗶𝗻𝗱 𝘁𝗵𝗲 𝗾𝘂𝗼𝘁𝗲𝗱 𝗺𝗲𝘀𝘀𝗮𝗴𝗲 𝗱𝗮𝘁𝗮.");

        const found = extractViewOnce(ctx.quotedMessage);
        if (!found) {
            return reply("❌ 𝗧𝗵𝗶𝘀 𝗶𝘀 𝗻𝗼𝘁 𝗮 𝗩𝗶𝗲𝘄 𝗢𝗻𝗰𝗲 𝗽𝗵𝗼𝘁𝗼, 𝘃𝗶𝗱𝗲𝗼, 𝗼𝗿 𝘃𝗼𝗶𝗰𝗲 𝗻𝗼𝘁𝗲.");
        }

        let buffer;
        try {
            buffer = await downloadMedia(found.media, found.type);
        } catch (e) {
            console.log("VV_DOWNLOAD_ERROR:", e);
            const msg = e?.message || String(e);
            // media expire වෙලා / quote එකේ media key නැති වෙලාවට පැහැදිලි hint එකක් දෙනවා
            const hint = /media key|\b404\b|\b410\b|expired|not found/i.test(msg)
                ? "\n\n💡 Media expired, or WhatsApp didn't include it in the quote. Auto mode is more reliable."
                : "";
            return reply("❌ 𝗘𝗿𝗿𝗼𝗿 𝗼𝗰𝗰𝘂𝗿𝗿𝗲𝗱: " + msg + hint);
        }

        const senderId = ctx.participant || from;
        const res = await sendToInbox(conn, { ...found, buffer, title: '🔓 *𝗩𝗜𝗘𝗪-𝗢𝗡𝗖𝗘 𝗥𝗘𝗧𝗥𝗜𝗘𝗩𝗘𝗗*', from, senderId, targets });

        // සමහර targets වලට යවන්න බැරි වුණා නම් ඒක කියනවා
        if (res.failed.length) {
            reply(`⚠️ Sent to ${res.total - res.failed.length}/${res.total} targets.\nFailed:\n- ${res.failed.join('\n- ')}`);
        }
    } catch (e) {
        console.log("VV_ERROR:", e);
        reply("❌ 𝗘𝗿𝗿𝗼𝗿 𝗼𝗰𝗰𝘂𝗿𝗿𝗲𝗱: " + (e?.message || String(e)));
    }
});

// ───────────────────── 🔎 JID helper ─────────────────────

// මේ chat එකේ JID එක බලාගන්න (EXTRA_TARGETS වලට දාන්න) – group එකක ගැහුවොත් group JID එක එනවා
cmd({
    pattern: "vvjid",
    desc: "Show the JID of the current chat (for EXTRA_TARGETS).",
    category: "owner",
    filename: __filename
},
async (conn, mek, m, { from, isOwner, reply }) => {
    if (!isOwner) return reply("❌ 𝗬𝗼𝘂 𝗮𝗿𝗲 𝗻𝗼𝘁 𝘁𝗵𝗲 𝗼𝘄𝗻𝗲𝗿!");
    reply(from);
});
