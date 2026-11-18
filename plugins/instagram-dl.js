// Instagram downloader — /ig <instagram link> (or reply to a message that contains a link)
//
// UPDATED: switched to poddax-api.dev endpoint + added interactive buttons.
// No API key needed for this endpoint.
const { cmd } = require('../command');

const API_URL = 'https://poddax-api.dev/instagram';
const IG_REGEX = /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/[^\s]+/i;

// Collect every http(s) link found anywhere inside the API result
function collectUrls(obj, out = new Set()) {
    if (!obj) return out;
    if (typeof obj === 'string') { if (/^https?:\/\//i.test(obj)) out.add(obj); return out; }
    if (Array.isArray(obj)) { obj.forEach((v) => collectUrls(v, out)); return out; }
    if (typeof obj === 'object') Object.values(obj).forEach((v) => collectUrls(v, out));
    return out;
}

cmd({
    pattern: 'ig',
    alias: ['instagram', 'igdl'],
    desc: 'Download an Instagram reel / post / video',
    category: 'download',
    react: '📥',
    filename: __filename,
},
async (conn, mek, m, { from, q, prefix }) => {
    const say = (text) => conn.sendMessage(from, { text }, { quoted: mek });
    try {
        const input = String(q || m.quoted?.text || m.quoted?.msg?.text || m.quoted?.msg?.conversation || '').trim();
        const match = input.match(IG_REGEX);
        if (!match) {
            return await say(`📥 *Instagram Downloader*\n\nUsage:\n${prefix || '/'}ig https://www.instagram.com/reel/xxxxxxxx/\n\nYou can also reply to a message that contains a link.`);
        }

        await say('⏳ Downloading, please wait...');

        const res = await fetch(`${API_URL}?url=${encodeURIComponent(match[0])}`);
        if (!res.ok) throw new Error(`API responded with HTTP ${res.status}`);
        const data = await res.json();

        if (!data.success || !data.url) {
            return await say('❌ Media not found. The account may be private or the link may be invalid.');
        }

        const mediaUrl = data.url;
        const thumbnail = data.thumbnail;
        const owner = data.owner || 'unknown';
        const isVideo = /\.mp4(\?|$)/i.test(mediaUrl) || /video/i.test(mediaUrl) ||
                        !/\.(jpe?g|png|webp)(\?|$)/i.test(mediaUrl); // default assume video if unknown

        // Build interactive buttons
        const buttons = [
            {
                buttonId: 'dl_now',
                buttonText: { displayText: '⬇️ Download Now' },
                type: 1,
            },
            {
                buttonId: 'copy_link',
                buttonText: { displayText: '🔗 Copy Link' },
                type: 1,
            },
        ];

        const caption =
            `✅ *Instagram Media Found*\n\n` +
            `👤 Owner: ${owner}\n` +
            `📦 Type: ${isVideo ? 'Video 🎬' : 'Image 🖼️'}\n\n` +
            `_Tap a button below to get the file or copy the direct link._`;

        // Send thumbnail + buttons first
        const sent = await conn.sendMessage(from, {
            image: thumbnail ? { url: thumbnail } : undefined,
            caption,
            footer: 'Instagram Downloader',
            buttons,
            headerType: 4,
        }, { quoted: mek });

        // Fallback: if buttons aren't supported, send raw link in a follow-up
        if (!sent || !sent.key) {
            await conn.sendMessage(from, {
                text: `📥 *Direct link:*\n${mediaUrl}\n\n_(Buttons not supported on this client — copy the link above.)_`,
            }, { quoted: mek });
        }

        // Handle button replies
        const handler = async (event) => {
            try {
                const btn = event?.messages?.[0]?.message?.buttonsResponseMessage;
                if (!btn) return;
                const id = btn.selectedButtonId;
                if (id === 'dl_now') {
                    if (isVideo) {
                        await conn.sendMessage(from, {
                            video: { url: mediaUrl },
                            caption: '✅ Instagram video downloaded',
                        }, { quoted: mek });
                    } else {
                        await conn.sendMessage(from, {
                            image: { url: mediaUrl },
                            caption: '✅ Instagram image downloaded',
                        }, { quoted: mek });
                    }
                } else if (id === 'copy_link') {
                    await conn.sendMessage(from, {
                        text: `🔗 *Direct download link:*\n${mediaUrl}`,
                    }, { quoted: mek });
                }
            } catch (e) {
                console.error('[ig] button handler error:', e.message);
            }
        };

        if (conn.ev && conn.ev.on) {
            conn.ev.on('messages.upsert', handler);
            // Auto-detach after 5 minutes to avoid listener leak
            setTimeout(() => {
                try { conn.ev.off('messages.upsert', handler); } catch (_) {}
            }, 5 * 60 * 1000);
        }

    } catch (err) {
        console.error('[ig] error:', err.message);
        say(`❌ Error: ${err.message}`).catch(() => {});
    }
});
