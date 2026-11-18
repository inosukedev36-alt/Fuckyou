const { cmd } = require('../command');
const { generateWAMessageFromContent, proto, prepareWAMessageMedia } = require('@dnuzi/baileys');

// ============================================================
// Global Variables
// ============================================================
let globalConn = null; // Baileys connection reference
const sessions = {};   // User sessions: { [from]: { step, query, results, selectedEpisode, qualities, timeout } }

const SEARCH_API = 'https://poddax-api.dev/hanime/search?text=';
const DOWNLOAD_API = 'https://poddax-api.dev/hanime/download?url=';

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // විනාඩි 5

// ============================================================
// Helper: API Request (Native Fetch)
// ============================================================
async function fetchAPI(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json();
  if (!data.status) throw new Error('API returned status: false');
  return data.result;
}

// ============================================================
// Helper: Session cleanup timer
// ============================================================
function resetSessionTimeout(from) {
  const s = sessions[from];
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  s.timeout = setTimeout(() => {
    if (sessions[from]) {
      delete sessions[from];
      console.log(`[HANIME] Session expired for ${from}`);
    }
  }, SESSION_TIMEOUT_MS);
}

// ============================================================
// Helper: Interactive List එකක් යැවීම
// ============================================================
async function sendInteractiveList(conn, from, mek, headerTitle, bodyText, footerText, sections, imageUrl = null) {
  try {
    let media = {};
    if (imageUrl) {
      try {
        media = await prepareWAMessageMedia(
          { image: { url: imageUrl } },
          { upload: conn.waUploadToServer }
        );
      } catch (imgErr) {
        // image prepare fail වුණොත් crash නොවී continue කරයි
        console.error('[HANIME] Media prepare failed, sending without image:', imgErr.message);
        media = {};
      }
    }

    const listParams = { title: headerTitle, sections };

    // viewOnceMessage ඉවත් කර කෙලින්ම interactiveMessage යවයි
    const msg = generateWAMessageFromContent(from, {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        header: proto.Message.InteractiveMessage.Header.fromObject({
          title: headerTitle,
          hasMediaAttachment: !!imageUrl && Object.keys(media).length > 0,
          ...media
        }),
        body: { text: bodyText },
        footer: { text: footerText },
        nativeFlowMessage: {
          buttons: [{
            name: 'single_select',
            buttonParamsJson: JSON.stringify(listParams)
          }]
        }
      })
    }, { quoted: mek });

    await conn.relayMessage(from, msg.message, { messageId: msg.key.id });
    return true;
  } catch (e) {
    console.error('[HANIME] Interactive send error:', e);
    // fallback: plain text එකක් යවයි
    await conn.sendMessage(from, { text: bodyText + '\n\n' + footerText }, { quoted: mek });
    return false;
  }
}

// ============================================================
// Helper: Search API
// ============================================================
async function searchHanime(query) {
  const results = await fetchAPI(SEARCH_API + encodeURIComponent(query));
  if (!Array.isArray(results)) throw new Error('Search results are not an array.');
  return results.filter(item => item.title && item.url);
}

// ============================================================
// Helper: Download API
// ============================================================
async function getDownloadLinks(pageUrl) {
  const qualities = await fetchAPI(DOWNLOAD_API + encodeURIComponent(pageUrl));
  if (!Array.isArray(qualities)) throw new Error('Download links are not an array.');
  return qualities.filter(q => q.name && q.url);
}

// ============================================================
// Helper: Episode තෝරාගත් පසු quality ලැයිස්තුව යැවීම
// ============================================================
async function handleEpisodeSelection(conn, from, session, selectedItem, quotedMsg) {
  try {
    session.step = 'select_quality';
    session.selectedEpisode = selectedItem;
    resetSessionTimeout(from);

    const qualities = await getDownloadLinks(selectedItem.url);
    if (qualities.length === 0) {
      await conn.sendMessage(from, { text: '❌ No download links found for this video.' }, { quoted: quotedMsg });
      delete sessions[from];
      return;
    }

    session.qualities = qualities;

    let body = `🎬 ${selectedItem.title}\n\n📥 Available Qualities\n\n`;
    qualities.forEach((q, i) => {
      body += `${i + 1} | ${q.name}\n`;
    });
    body += `0 | ❌ Close\n\nSend the quality number.`;

    const sections = [{
      title: 'Available Qualities',
      rows: qualities.map((q, i) => ({
        title: `${i + 1} | ${q.name}`,
        description: '',
        id: `q_${i}`
      }))
    }];
    sections[0].rows.push({ title: '0 | ❌ Close', description: 'Close this menu', id: 'close' });

    await sendInteractiveList(
      conn, from, quotedMsg,
      'Select Quality',
      body,
      'Send a number or select from the list',
      sections,
      selectedItem.image || null
    );
  } catch (e) {
    console.error('[HANIME] Episode selection error:', e);
    await conn.sendMessage(from, { text: '⚠️ Error: ' + e.message }, { quoted: quotedMsg });
    delete sessions[from];
  }
}

// ============================================================
// Helper: Quality තෝරාගත් පසු වීඩියෝව document එකක් ලෙස යැවීම
// ============================================================
async function handleQualitySelection(conn, from, session, qualityIndex, quotedMsg) {
  try {
    const quality = session.qualities[qualityIndex];
    if (!quality) {
      await conn.sendMessage(from, { text: '❌ Invalid selection.' }, { quoted: quotedMsg });
      return;
    }

    const videoUrl = quality.url;
    const safeTitle = session.selectedEpisode.title.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);

    await conn.sendMessage(from, {
      document: { url: videoUrl },
      mimetype: 'video/mp4',
      fileName: `${safeTitle}_${quality.name}.mp4`,
      caption: `🎬 ${session.selectedEpisode.title}\n📥 Quality: ${quality.name}`
    }, { quoted: quotedMsg });

    delete sessions[from];
  } catch (e) {
    console.error('[HANIME] Quality selection error:', e);
    await conn.sendMessage(from, { text: '⚠️ Failed to send video: ' + e.message }, { quoted: quotedMsg });
    delete sessions[from];
  }
}

// ============================================================
// ප්‍රධාන command එක
// ============================================================
cmd({
  pattern: 'hanime',
  desc: 'Search and download Hanime videos',
  category: 'main',
  filename: __filename
}, async (conn, mek, m, { from, reply, q, text }) => {
  // Listener එකට අවශ්‍ය නිසා global connection reference එක set කරයි
  globalConn = conn;

  try {
    const query = q || text;
    if (!query) {
      return reply('Please provide a name to search.\nExample: .hanime haha');
    }

    // පරණ session එකක් තිබේ නම් එය clear කරයි
    if (sessions[from]) {
      if (sessions[from].timeout) clearTimeout(sessions[from].timeout);
      delete sessions[from];
    }

    sessions[from] = { step: 'search', query };
    resetSessionTimeout(from);

    const results = await searchHanime(query);
    if (results.length === 0) {
      delete sessions[from];
      return reply('❌ No results found.');
    }

    sessions[from].results = results;
    sessions[from].step = 'select_episode';
    resetSessionTimeout(from);

    let body = `🔍 Search: ${query}\n\n`;
    results.forEach((item, i) => {
      body += `${i + 1} | ${item.title}\n`;
    });
    body += `0 | ❌ Close\n\nSend the video number.`;

    const sections = [{
      title: 'Search Results',
      rows: results.map((item, i) => ({
        title: `${i + 1} | ${item.title}`,
        description: '',
        id: `ep_${i}`
      }))
    }];
    sections[0].rows.push({ title: '0 | ❌ Close', description: 'Close this menu', id: 'close' });

    const imageUrl = results[0]?.image || null;

    await sendInteractiveList(
      conn, from, mek,
      'Search Results',
      body,
      'Send a number or select from the list',
      sections,
      imageUrl
    );
  } catch (e) {
    console.error('[HANIME] Command error:', e);
    reply('⚠️ Error: ' + e.message);
    if (sessions[from]) {
      if (sessions[from].timeout) clearTimeout(sessions[from].timeout);
      delete sessions[from];
    }
  }
});

// ============================================================
// Listener එක Module මට්ටමේ attach කරයි
// ============================================================
if (!global._hanimeListenerAttached) {
  global._hanimeListenerAttached = true;

  const attachListener = () => {
    if (!globalConn) {
      // connection එක තාම ready නැත්නම් තත්පරයකින් නැවත උත්සාහ කරයි
      setTimeout(attachListener, 1000);
      return;
    }

    globalConn.ev.on('messages.upsert', async (m) => {
      try {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const session = sessions[from];
        if (!session) return;

        // Debug කරන්න ඕන නම් uncomment කරන්න:
        // console.log('[HANIME] incoming:', JSON.stringify(msg.message, null, 2));

        // viewOnce / ephemeral wrapper ඉවත් කරයි
        const inner =
          msg.message?.viewOnceMessage?.message ||
          msg.message?.viewOnceMessageV2?.message ||
          msg.message?.viewOnceMessageV2Extension?.message ||
          msg.message?.ephemeralMessage?.message ||
          msg.message;

        const textMsg =
          inner.conversation ||
          inner.extendedTextMessage?.text ||
          inner.imageMessage?.caption ||
          '';

        let listId = null;

        // 1) පරණ listMessage response
        listId = inner.listResponseMessage?.singleSelectReply?.selectedRowId || null;

        // 2) Template buttons response
        if (!listId) listId = inner.buttonsResponseMessage?.selectedButtonId || null;

        // 3) Native flow (single_select → ප්‍රධාන case එක)
        if (!listId) {
          const paramsJson =
            inner.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
            inner.interactiveResponseMessage?.nativeFlowResponseMessage?.params_json;
          if (paramsJson) {
            try {
              const p = typeof paramsJson === 'string' ? JSON.parse(paramsJson) : paramsJson;
              listId = p.id || p.selectedId || p.selected_id || null;
            } catch (e) {
              console.error('[HANIME] paramsJson parse error:', e, paramsJson);
            }
          }
        }

        let selection = null;

        // ID එකෙන් තේරීම හඳුනාගනී
        if (listId) {
          if (listId === 'close') {
            if (session.timeout) clearTimeout(session.timeout);
            delete sessions[from];
            await globalConn.sendMessage(from, { text: '❌ Menu closed.' }, { quoted: msg });
            return;
          }
          const parts = listId.split('_');
          const type = parts[0];
          const index = parseInt(parts[1]);
          if (type === 'ep' && !isNaN(index)) selection = { type: 'episode', index };
          else if (type === 'q' && !isNaN(index)) selection = { type: 'quality', index };
        }

        // Number / text reply (fallback)
        if (!selection && textMsg && textMsg.trim() !== '') {
          const cleaned = textMsg.trim();
          // "1 | title" වගේ ආවොත් මුල් අංකය ගනී
          const match = cleaned.match(/^(\d+)/);
          if (match) {
            const num = parseInt(match[1]);
            if (num === 0) {
              if (session.timeout) clearTimeout(session.timeout);
              delete sessions[from];
              await globalConn.sendMessage(from, { text: '❌ Menu closed.' }, { quoted: msg });
              return;
            }
            if (session.step === 'select_episode' && num >= 1) selection = { type: 'episode', index: num - 1 };
            else if (session.step === 'select_quality' && num >= 1) selection = { type: 'quality', index: num - 1 };
          }
        }

        if (!selection) return;

        // තේරීම හසුරුවයි
        if (selection.type === 'episode' && session.step === 'select_episode') {
          const item = session.results[selection.index];
          if (!item) {
            await globalConn.sendMessage(from, { text: '❌ Invalid number.' }, { quoted: msg });
            return;
          }
          await handleEpisodeSelection(globalConn, from, session, item, msg);
        } else if (selection.type === 'quality' && session.step === 'select_quality') {
          await handleQualitySelection(globalConn, from, session, selection.index, msg);
        }
      } catch (err) {
        console.error('[HANIME] Listener error:', err);
      }
    });

    console.log('[HANIME] Listener attached successfully.');
  };

  attachListener();
}
