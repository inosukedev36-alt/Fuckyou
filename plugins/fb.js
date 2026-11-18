// Facebook downloader — /fb <facebook video link> (or reply to a message that contains a link)
//
// Uses poddax-api.dev endpoint. No API key needed.
// Supports: facebook.com/watch, /reel, /videos, /share/v, fb.watch short links.
const { cmd } = require('../command');

const API_URL = 'https://poddax-api.dev/fb';
// Match any facebook video-ish URL (incl. fb.watch shortlinks and /share/)
const FB_REGEX = /https?:\/\/(?:www\.|m\.|web\.)?(?:facebook\.com|fb\.watch)\/[^\s]+/i;

cmd({
    pattern: 'fb',
    alias: ['facebook', 'fbdl'],
    desc: 'Download a Facebook video',
    category: 'download',
    react: '📥',
    filename: __filename,
},
async (conn, mek, m, { from, q, prefix }) => {
    const say = (text) => conn.sendMessage(from, { text }, { quoted: mek });
    try {
        const input = String(q || m.quoted?.text || m.quoted?.msg?.text || m.quoted?.msg?.conversation || '').trim();
        const match = input.match(FB_REGEX);
        if (!match) {
            return await say(`📥 *Facebook Video Downloader*\n\nUsage:\n${prefix || '/'}fb https://www.facebook.com/watch/?v=xxxxxxxx\n\nYou can also reply to a message that contains a link.`);
        }

        await say('⏳ Downloading, please wait...');

        const res = await fetch(`${API_URL}?url=${encodeURIComponent(match[0])}`);
        if (!res.ok) throw new Error(`API responded with HTTP ${res.status}`);
        const data = await res.json();

        // API shape: { status: true, data: { owner, title, duration, thumbnail, hdvideo, novideo } }
        const d = data.data;
        if (!data.status || !d) {
            return await say('❌ Video not found. The post may be private or the link may be invalid.');
        }

        const thumbnail = d.thumbnail;
        const hd = d.hdvideo;
        const sd = d.novideo;

        if (!hd && !sd) {
            return await say('❌ Could not find a download link in the response.');
        }

        // Build buttons only for available qualities
        const buttons = [];
        const qualityMap = {};

        if (hd) {
            buttons.push({
                buttonId: 'fb_hd',
                buttonText: { displayText: '⬇️ HD Quality' },
                type: 1,
            });
            qualityMap['fb_hd'] = hd;
        }
        if (sd) {
            buttons.push({
                buttonId: 'fb_sd',
                buttonText: { displayText: '⬇️ SD Quality' },
                type: 1,
            });
            qualityMap['fb_sd'] = sd;
        }

        // Send thumbnail with buttons (no caption text)
        const sent = await conn.sendMessage(from, {
            image: thumbnail ? { url: thumbnail } : undefined,
            caption: '',          // no caption
            footer: 'Facebook Downloader',
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

                await conn.sendMessage(from, {
                    video: { url: chosenUrl },
                    // no caption
                }, { quoted: mek });
            } catch (e) {
                console.error('[fb] button handler error:', e.message);
            }
        };

        if (conn.ev && conn.ev.on) {
            conn.ev.on('messages.upsert', handler);
            setTimeout(() => {
                try { conn.ev.off('messages.upsert', handler); } catch (_) {}
            }, 5 * 60 * 1000);
        }

        if (!sent || !sent.key) {
            await say('❌ Failed to send video preview.');
        }

    } catch (err) {
        console.error('[fb] error:', err.message);
        say(`❌ Error: ${err.message}`).catch(() => {});
    }
});
