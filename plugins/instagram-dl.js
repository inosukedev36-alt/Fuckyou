// Instagram downloader — /ig <instagram link> (or reply to a message that contains a link)
//
// UPDATED: switched to poddax-api.dev endpoint + interactive buttons.
// No API key needed for this endpoint.
const { cmd } = require('../command');

const API_URL = 'https://poddax-api.dev/instagram';
const IG_REGEX = /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/[^\s]+/i;

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
        const isVideo = /\.mp4(\?|$)/i.test(mediaUrl) || /video/i.test(mediaUrl) ||
                        !/\.(jpe?g|png|webp)(\?|$)/i.test(mediaUrl);

        // Quality options — only if API actually provides them
        const qualities = Array.isArray(data.qualities) ? data.qualities
                        : Array.isArray(data.links) ? data.links
                        : [];

        let buttons = [];
        let qualityMap = {};

        if (qualities.length > 0) {
            // Build one button per available quality
            qualities.slice(0, 4).forEach((item, idx) => {
                const label = item.quality || item.label || item.resolution || `Option ${idx + 1}`;
                const url = item.url || item.link || item.download_url;
                if (!url) return;
                const id = `dl_${idx}`;
                qualityMap[id] = url;
                buttons.push({
                    buttonId: id,
                    buttonText: { displayText: `⬇️ ${label}` },
                    type: 1,
                });
            });
        }

        // Fallback: no quality info → just a single Download button
        if (buttons.length === 0) {
            buttons = [{
                buttonId: 'dl_default',
                buttonText: { displayText: '⬇️ Download' },
                type: 1,
            }];
            qualityMap['dl_default'] = mediaUrl;
        }

        const caption =
            `✅ *Instagram Media Found*\n\n` +
            `📦 Type: ${isVideo ? 'Video 🎬' : 'Image 🖼️'}\n\n` +
            `_Tap the button below to download._`;

        const sent = await conn.sendMessage(from, {
            image: thumbnail ? { url: thumbnail } : undefined,
            caption,
            footer: 'Instagram Downloader',
            buttons,
            headerType: 4,
        }, { quoted: mek });

        // Handle button replies
        const handler = async (event) => {
            try {
                const btn = event?.messages?.[0]?.message?.buttonsResponseMessage;
                if (!btn) return;
                const id = btn.selectedButtonId;
                const chosenUrl = qualityMap[id];
                if (!chosenUrl) return;

                const videoLike = /\.mp4(\?|$)/i.test(chosenUrl) || isVideo;
                if (videoLike) {
                    await conn.sendMessage(from, {
                        video: { url: chosenUrl },
                        caption: '✅ Instagram video downloaded',
                    }, { quoted: mek });
                } else {
                    await conn.sendMessage(from, {
                        image: { url: chosenUrl },
                        caption: '✅ Instagram image downloaded',
                    }, { quoted: mek });
                }
            } catch (e) {
                console.error('[ig] button handler error:', e.message);
            }
        };

        if (conn.ev && conn.ev.on) {
            conn.ev.on('messages.upsert', handler);
            setTimeout(() => {
                try { conn.ev.off('messages.upsert', handler); } catch (_) {}
            }, 5 * 60 * 1000);
        }

        if (!sent || !sent.key) {
            await say('❌ Failed to send media preview.');
        }

    } catch (err) {
        console.error('[ig] error:', err.message);
        say(`❌ Error: ${err.message}`).catch(() => {});
    }
});
