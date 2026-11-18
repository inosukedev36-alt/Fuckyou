const axios = require('axios');
const { cmd } = require('../command');
const { generateWAMessageFromContent, proto, prepareWAMessageMedia } = require('@dnuzi/baileys');

// ============================================================
// Global Variables & Sessions
// ============================================================
let globalConn = null;
const animeSessions = {};
global._animeSessions = animeSessions;

const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================
// Antiban Helper Functions
// ============================================================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

async function simulateTyping(conn, from, durationMs) {
  try {
    await conn.sendPresenceUpdate('composing', from);
    await sleep(durationMs);
    await conn.sendPresenceUpdate('paused', from);
  } catch (e) {}
}

function resetSessionTimeout(from) {
  const s = animeSessions[from];
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  s.timeout = setTimeout(() => {
    if (animeSessions[from]) {
      delete animeSessions[from];
      console.log(`[ANIME] Session expired for ${from}`);
    }
  }, SESSION_TIMEOUT_MS);
}

// ============================================================
// Interactive List & Button Helpers
// ============================================================
async function sendInteractiveList(conn, from, mek, headerTitle, bodyText, footerText, sections, imageUrl = null) {
  try {
    let media = {};
    if (imageUrl) {
      try {
        media = await prepareWAMessageMedia({ image: { url: imageUrl } }, { upload: conn.waUploadToServer });
      } catch (imgErr) { media = {}; }
    }
    const listParams = { title: headerTitle, sections };
    const msg = generateWAMessageFromContent(from, {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        header: proto.Message.InteractiveMessage.Header.fromObject({
          title: headerTitle, hasMediaAttachment: !!imageUrl && Object.keys(media).length > 0, ...media
        }),
        body: { text: bodyText },
        footer: { text: footerText },
        nativeFlowMessage: { buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify(listParams) }] }
      })
    }, { quoted: mek });
    await conn.relayMessage(from, msg.message, { messageId: msg.key.id });
    return true;
  } catch (e) {
    await conn.sendMessage(from, { text: bodyText + '\n\n' + footerText }, { quoted: mek });
    return false;
  }
}

async function sendQuickButtons(conn, from, mek, bodyText, footerText, buttons) {
  try {
    const msg = generateWAMessageFromContent(from, {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        body: { text: bodyText },
        footer: { text: footerText },
        nativeFlowMessage: {
          buttons: buttons.map(b => ({
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id })
          }))
        }
      })
    }, { quoted: mek });
    await conn.relayMessage(from, msg.message, { messageId: msg.key.id });
    return true;
  } catch (e) {
    let fallback = bodyText + '\n\n';
    buttons.forEach((b, i) => { fallback += `${i + 1} | ${b.text}\n`; });
    fallback += '\n' + footerText;
    await conn.sendMessage(from, { text: fallback }, { quoted: mek });
    return false;
  }
}

// ============================================================
// Send Poster (only if user says yes)
// ============================================================
async function sendPoster(conn, from, session, quotedMsg) {
  const { posterUrl, mediaTitle } = session;
  if (!posterUrl) {
    await conn.sendMessage(from, { text: '❌ No poster available for this title.' }, { quoted: quotedMsg });
    delete animeSessions[from];
    return;
  }
  try {
    await conn.sendMessage(from, {
      image: { url: posterUrl },
      caption: `🖼️ *${mediaTitle}* Poster`
    }, { quoted: quotedMsg });
  } catch (e) {
    console.error('Poster send error:', e.message);
    await conn.sendMessage(from, { text: '❌ Failed to send poster.' }, { quoted: quotedMsg });
  }
  delete animeSessions[from];
}

// ============================================================
// Main Command
// ============================================================
cmd({
  pattern: "anime",
  alias: ["mal", "animeinfo"],
  desc: "Get anime/hentai information from MAL (Jikan API)",
  category: "download",
  react: "🎌"
}, async (conn, mek, m, { from, reply, q }) => {
  globalConn = conn;
  const query = q;
  if (!query) return reply('Please provide an anime name.\nExample: .anime Naruto');

  try {
    if (animeSessions[from]) {
      if (animeSessions[from].timeout) clearTimeout(animeSessions[from].timeout);
      delete animeSessions[from];
    }
    animeSessions[from] = { step: 'search' };
    resetSessionTimeout(from);

    await simulateTyping(conn, from, randomDelay(1500, 2500));

    // Jikan API - sfw=false ලෙස යැවීමෙන් Hentai/Adult ඒවත් එනවා
    const searchUrl = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&sfw=false&limit=10`;
    const searchRes = await axios.get(searchUrl);

    if (!searchRes.data.data || searchRes.data.data.length === 0) {
      delete animeSessions[from];
      return reply('❌ No results found.');
    }

    const results = searchRes.data.data;
    animeSessions[from].results = results;
    animeSessions[from].step = 'select_anime';
    resetSessionTimeout(from);

    let body = `🔍 Search Results for: ${query}\n\n`;
    results.forEach((item, i) => {
      const title = item.title_english || item.title;
      const year = item.year || 'Unknown';
      const type = item.type || 'N/A';
      body += `${i + 1} | ${title} (${year}) - ${type}\n`;
    });
    body += `0 | ❌ Close\n\nSelect the correct one.`;

    const sections = [{
      title: 'Search Results',
      rows: results.map((item, i) => {
        const title = item.title_english || item.title;
        const year = item.year || 'Unknown';
        const type = item.type || 'Anime';
        return { title: `${i + 1} | ${title} (${year})`, description: type, id: `anime_${i}` };
      })
    }];
    sections[0].rows.push({ title: '0 | ❌ Close', description: 'Close this menu', id: 'close' });

    const imageUrl = results[0].images?.jpg?.large_image_url || results[0].images?.jpg?.image_url || null;
    await sendInteractiveList(conn, from, mek, 'Select Anime', body, 'Send a number or select from the list', sections, imageUrl);

  } catch (error) {
    console.error('Jikan API Error:', error);
    reply('❌ Something went wrong while searching.');
    if (animeSessions[from]) delete animeSessions[from];
  }
});

// ============================================================
// Listener
// ============================================================
if (!global._animeListenerAttached) {
  global._animeListenerAttached = true;

  const attachListener = () => {
    if (!globalConn) { setTimeout(attachListener, 1000); return; }

    globalConn.ev.on('messages.upsert', async (m) => {
      try {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const from = msg.key.remoteJid;
        const session = animeSessions[from];
        if (!session) return;

        const inner = msg.message?.viewOnceMessage?.message || msg.message?.viewOnceMessageV2?.message ||
                      msg.message?.ephemeralMessage?.message || msg.message;
        const textMsg = inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || '';

        let listId = inner.listResponseMessage?.singleSelectReply?.selectedRowId ||
                     inner.templateButtonReplyMessage?.selectedId ||
                     inner.buttonsResponseMessage?.selectedButtonId || null;
        if (!listId) {
          const paramsJson = inner.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
                             inner.interactiveResponseMessage?.nativeFlowResponseMessage?.params_json;
          if (paramsJson) {
            try {
              const p = typeof paramsJson === 'string' ? JSON.parse(paramsJson) : paramsJson;
              listId = p.id || p.selectedId || p.selected_id || null;
            } catch (e) {}
          }
        }

        if (listId === 'close' || textMsg.toLowerCase() === 'cancel' || textMsg === '0') {
          if (session.timeout) clearTimeout(session.timeout);
          await globalConn.sendMessage(from, { text: '❌ Menu closed.' }, { quoted: msg });
          delete animeSessions[from];
          return;
        }

        // Step: select_anime
        if (session.step === 'select_anime') {
          let selection = null;
          if (listId && listId.startsWith('anime_')) {
            const idx = parseInt(listId.split('_')[1]);
            if (!isNaN(idx)) selection = idx;
          }
          if (selection === null && textMsg.trim() !== '') {
            const match = textMsg.trim().match(/^(\d+)/);
            if (match) {
              const num = parseInt(match[1]);
              if (num >= 1 && num <= session.results.length) selection = num - 1;
            }
          }
          if (selection === null || !session.results[selection]) return;

          const item = session.results[selection];
          const title = item.title_english || item.title;
          const year = item.year || 'Unknown';
          const synopsis = item.synopsis ? (item.synopsis.length > 250 ? item.synopsis.substring(0, 250) + '...' : item.synopsis) : 'No synopsis available.';
          const rating = item.score ? `${item.score}/10` : 'N/A';
          const episodes = item.episodes || 'N/A';
          const type = item.type || 'N/A';
          const posterUrl = item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || null;

          session.step = 'ask_poster';
          session.mediaTitle = title;
          session.posterUrl = posterUrl;
          resetSessionTimeout(from);

          await simulateTyping(globalConn, from, randomDelay(2000, 3000));

          const infoText = `🎌 *${title}* (${year})\n` +
                           `⭐ *Rating:* ${rating}\n` +
                           `📺 *Type:* ${type}\n` +
                           `🎞️ *Episodes:* ${episodes}\n\n` +
                           `📝 *Synopsis:*\n${synopsis}`;

          await sendQuickButtons(
            globalConn, from, msg,
            infoText,
            'Do you want the poster?',
            [
              { text: '🖼️ Yes, send poster', id: 'poster_yes' },
              { text: '❌ No, thanks', id: 'poster_no' }
            ]
          );
          return;
        }

        // Step: ask_poster
        if (session.step === 'ask_poster') {
          if (listId === 'poster_yes' || textMsg.toLowerCase().includes('yes') || textMsg === '1') {
            await sendPoster(globalConn, from, session, msg);
          } else if (listId === 'poster_no' || textMsg.toLowerCase().includes('no') || textMsg === '0') {
            await globalConn.sendMessage(from, { text: '✅ Info delivered. Have a nice day!' }, { quoted: msg });
            delete animeSessions[from];
          } else {
            await globalConn.sendMessage(from, { text: '❌ Please choose using the buttons (or reply 1 / 0).' }, { quoted: msg });
          }
          return;
        }

      } catch (err) {
        console.error('[ANIME] Listener error:', err);
      }
    });
  };
  attachListener();
}
