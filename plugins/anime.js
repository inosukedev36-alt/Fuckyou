const axios = require('axios');
const { cmd } = require('../command');
const { generateWAMessageFromContent, proto, prepareWAMessageMedia } = require('@dnuzi/baileys');

// ============================================================
// Global Variables & Sessions
// ============================================================
let globalConn = null;
const aniInfoSessions = {};
global._aniInfoSessions = aniInfoSessions;

const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================
// Antiban Helpers
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
  const s = aniInfoSessions[from];
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  s.timeout = setTimeout(() => {
    if (aniInfoSessions[from]) {
      delete aniInfoSessions[from];
      console.log(`[ANIINFO] Session expired for ${from}`);
    }
  }, SESSION_TIMEOUT_MS);
}

// ============================================================
// Interactive Helpers
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
// Poster Sender
// ============================================================
async function sendAniInfoPoster(conn, from, session, quotedMsg) {
  const { posterUrl, mediaTitle } = session;
  if (!posterUrl) {
    await conn.sendMessage(from, { text: '❌ No poster available for this title.' }, { quoted: quotedMsg });
    delete aniInfoSessions[from];
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
  delete aniInfoSessions[from];
}

// ============================================================
// Main Command: .aniinfo
// ============================================================
cmd({
  pattern: "aniinfo",
  alias: ["ani"],
  desc: "Search anime from multiple servers (MAL / Bilibili)",
  category: "download",
  react: "🎌"
}, async (conn, mek, m, { from, reply, q }) => {
  globalConn = conn;
  const query = q;

  if (!query) {
    return reply('Please provide an anime name.\nExample: .aniinfo Naruto');
  }

  try {
    // Clear existing session
    if (aniInfoSessions[from]) {
      if (aniInfoSessions[from].timeout) clearTimeout(aniInfoSessions[from].timeout);
      delete aniInfoSessions[from];
    }

    // Create new session
    aniInfoSessions[from] = {
      step: 'select_server',
      query: query
    };
    resetSessionTimeout(from);

    await simulateTyping(conn, from, randomDelay(1200, 2000));

    await sendQuickButtons(
      conn, from, mek,
      `🔍 *Search:* ${query}\n\nSelect a server to search from:`,
      '📚 Server 1 = MyAnimeList (Anime Info)\n🎬 Server 2 = Bilibili (Videos)',
      [
        { text: '📚 Server 1 (MAL)', id: 'server_1' },
        { text: '🎬 Server 2 (Bilibili)', id: 'server_2' }
      ]
    );
  } catch (error) {
    console.error('[ANIINFO] Command error:', error);
    reply('❌ Something went wrong.');
    if (aniInfoSessions[from]) delete aniInfoSessions[from];
  }
});

// ============================================================
// Listener
// ============================================================
if (!global._aniInfoListenerAttached) {
  global._aniInfoListenerAttached = true;

  const attachAniInfoListener = () => {
    if (!globalConn) { setTimeout(attachAniInfoListener, 1000); return; }

    globalConn.ev.on('messages.upsert', async (m) => {
      try {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const from = msg.key.remoteJid;
        const session = aniInfoSessions[from];
        if (!session) return;

        // Extract inner message
        const inner = msg.message?.viewOnceMessage?.message || msg.message?.viewOnceMessageV2?.message ||
                      msg.message?.ephemeralMessage?.message || msg.message;
        const textMsg = (inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || '').trim();

        // Extract list/button ID
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

        // Global cancel
        if (listId === 'close' || textMsg.toLowerCase() === 'cancel' || textMsg === '0') {
          if (session.timeout) clearTimeout(session.timeout);
          await globalConn.sendMessage(from, { text: '❌ Menu closed.' }, { quoted: msg });
          delete aniInfoSessions[from];
          return;
        }

        // --------------------------------------------------------
        // STEP 1: Server Selection
        // --------------------------------------------------------
        if (session.step === 'select_server') {
          let server = null;
          if (listId === 'server_1' || textMsg === '1') server = 1;
          else if (listId === 'server_2' || textMsg === '2') server = 2;

          if (!server) {
            await globalConn.sendMessage(from, { text: '❌ Please select Server 1 or Server 2.' }, { quoted: msg });
            return;
          }

          session.server = server;
          session.step = 'searching';
          resetSessionTimeout(from);

          await simulateTyping(globalConn, from, randomDelay(1500, 2500));

          const apiUrl = server === 1
            ? `https://api-nomo.zone.id/api/animesearch?q=${encodeURIComponent(session.query)}`
            : `https://api-nomo.zone.id/api/anisearch?q=${encodeURIComponent(session.query)}`;

          const res = await axios.get(apiUrl, { timeout: 15000 });

          if (!res.data?.status || !Array.isArray(res.data.result) || res.data.result.length === 0) {
            await globalConn.sendMessage(from, { text: '❌ No results found.' }, { quoted: msg });
            delete aniInfoSessions[from];
            return;
          }

          const results = res.data.result.slice(0, 10); // max 10 for buttons
          session.results = results;
          session.step = 'select_anime';
          resetSessionTimeout(from);

          // Build result buttons / list
          let body = `🔍 *Results for "${session.query}"* (Server ${server})\n\n`;
          results.forEach((item, i) => {
            body += `${i + 1} | ${item.title}\n`;
          });
          body += `\n0 | ❌ Close`;

          const sections = [{
            title: `Server ${server} Results`,
            rows: results.map((item, i) => ({
              title: `${i + 1} | ${item.title}`,
              description: server === 1
                ? `${item.type || 'Anime'} | ⭐ ${item.score || 'N/A'}`
                : `${item.duration || ''} | ${item.author || ''}`,
              id: `ani_${i}`
            }))
          }];
          sections[0].rows.push({ title: '0 | ❌ Close', description: 'Close this menu', id: 'close' });

          const thumb = server === 1
            ? (results[0].imageUrl || null)
            : (results[0].thumbnail || null);

          await sendInteractiveList(
            globalConn, from, msg,
            'Select Anime',
            body,
            'Tap a result or reply with a number',
            sections,
            thumb
          );
          return;
        }

        // --------------------------------------------------------
        // STEP 2: Anime Selection → Show Details
        // --------------------------------------------------------
        if (session.step === 'select_anime') {
          let selection = null;

          if (listId && listId.startsWith('ani_')) {
            const idx = parseInt(listId.split('_')[1]);
            if (!isNaN(idx) && idx >= 0 && idx < session.results.length) selection = idx;
          }
          if (selection === null && textMsg !== '') {
            const match = textMsg.match(/^(\d+)/);
            if (match) {
              const num = parseInt(match[1]);
              if (num >= 1 && num <= session.results.length) selection = num - 1;
            }
          }
          if (selection === null || !session.results[selection]) return;

          const item = session.results[selection];
          session.step = 'ask_poster';
          session.mediaTitle = item.title;
          resetSessionTimeout(from);

          await simulateTyping(globalConn, from, randomDelay(1500, 2500));

          let infoText = '';
          let posterUrl = null;

          if (session.server === 1) {
            // Server 1 (MAL) details
            const desc = item.description
              ? (item.description.length > 300 ? item.description.substring(0, 300) + '...' : item.description)
              : 'No description available.';

            infoText = `🎌 *${item.title}*\n` +
                       `📺 *Type:* ${item.type || 'N/A'}\n` +
                       `🎞️ *Episodes:* ${item.episodes || 'N/A'}\n` +
                       `⭐ *Score:* ${item.score || 'N/A'}\n` +
                       `🔗 *Link:* ${item.link || 'N/A'}\n\n` +
                       `📝 *Description:*\n${desc}`;
            posterUrl = item.imageUrl || null;
          } else {
            // Server 2 (Bilibili) details
            infoText = `🎬 *${item.title}*\n` +
                       `👁️ *Views:* ${item.views || 'N/A'}\n` +
                       `⏱️ *Duration:* ${item.duration || 'N/A'}\n` +
                       `👤 *Author:* ${item.author || 'N/A'}\n` +
                       `🔗 *URL:* ${item.url || 'N/A'}`;
            posterUrl = item.thumbnail || null;
          }

          session.posterUrl = posterUrl;

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

        // --------------------------------------------------------
        // STEP 3: Poster Confirmation
        // --------------------------------------------------------
        if (session.step === 'ask_poster') {
          if (listId === 'poster_yes' || textMsg.toLowerCase().includes('yes') || textMsg === '1') {
            await sendAniInfoPoster(globalConn, from, session, msg);
          } else if (listId === 'poster_no' || textMsg.toLowerCase().includes('no') || textMsg === '0' || textMsg === '2') {
            await globalConn.sendMessage(from, { text: '✅ Done. Have a nice day!' }, { quoted: msg });
            delete aniInfoSessions[from];
          } else {
            await globalConn.sendMessage(from, { text: '❌ Please choose using the buttons (1 = Yes / 2 = No).' }, { quoted: msg });
          }
          return;
        }

      } catch (err) {
        console.error('[ANIINFO] Listener error:', err);
      }
    });
  };
  attachAniInfoListener();
}
