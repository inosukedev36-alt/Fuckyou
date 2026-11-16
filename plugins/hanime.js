const { cmd } = require('../command');
const { generateWAMessageFromContent, proto, prepareWAMessageMedia } = require('@dnuzi/baileys');

// ============================================================
// Global Variables
// ============================================================
let globalConn = null; // Baileys connection reference
const sessions = {};   // User sessions: { [from]: { step, query, results, selectedEpisode, qualities } }

const SEARCH_API = 'https://poddax-api.dev/hanime/search?text=';
const DOWNLOAD_API = 'https://poddax-api.dev/hanime/download?url=';

// ============================================================
// Helper: API Request (Using Native Fetch)
// ============================================================
async function fetchAPI(url) {
  // Node.js 18+ හි built-in fetch භාවිතා කරයි
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json();
  if (!data.status) throw new Error('API returned status: false');
  return data.result; // සැබෑ දත්ත මෙහි ඇත
}

// ============================================================
// Helper: Interactive List එකක් යැවීම
// ============================================================
async function sendInteractiveList(conn, from, mek, headerTitle, bodyText, footerText, sections, imageUrl = null) {
  try {
    let media = {};
    if (imageUrl) {
      media = await prepareWAMessageMedia(
        { image: { url: imageUrl } },
        { upload: conn.waUploadToServer }
      );
    }

    const listParams = { title: headerTitle, sections };

    const msg = generateWAMessageFromContent(from, {
      viewOnceMessage: {
        message: {
          messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
          interactiveMessage: proto.Message.InteractiveMessage.fromObject({
            header: proto.Message.InteractiveMessage.Header.fromObject({
              title: headerTitle,
              hasMediaAttachment: !!imageUrl,
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
        }
      }
    }, { quoted: mek });

    await conn.relayMessage(from, msg.message, { messageId: msg.key.id });
    return true;
  } catch (e) {
    console.error('[HANIME] Interactive send error:', e);
    // Fallback: සාමාන්‍ය text message එකක් යවන්න
    await conn.sendMessage(from, { text: bodyText + '\n\n' + footerText }, { quoted: mek });
    return false;
  }
}

// ============================================================
// Helper: Search API එකෙන් ප්‍රතිඵල ලබා ගැනීම
// ============================================================
async function searchHanime(query) {
  const results = await fetchAPI(SEARCH_API + encodeURIComponent(query));
  if (!Array.isArray(results)) throw new Error('Search results are not an array.');
  return results.filter(item => item.title && item.url);
}

// ============================================================
// Helper: Download API එකෙන් quality ලබා ගැනීම
// ============================================================
async function getDownloadLinks(pageUrl) {
  const qualities = await fetchAPI(DOWNLOAD_API + encodeURIComponent(pageUrl));
  if (!Array.isArray(qualities)) throw new Error('Download links are not an array.');
  return qualities.filter(q => q.name && q.url);
}

// ============================================================
// Helper: Episode එකක් තෝරාගත් පසු quality ලැයිස්තුව යැවීම
// ============================================================
async function handleEpisodeSelection(conn, from, session, selectedItem, quotedMsg) {
  try {
    session.step = 'select_quality';
    session.selectedEpisode = selectedItem;

    const qualities = await getDownloadLinks(selectedItem.url);
    if (qualities.length === 0) {
      await conn.sendMessage(from, { text: '❌ මෙම වීඩියෝව සඳහා බාගැනීම් ලින්ක් නොමැත.' }, { quoted: quotedMsg });
      delete sessions[from];
      return;
    }

    session.qualities = qualities;

    let body = `🎬 ${selectedItem.title}\n\n📥 ගුණාත්මක විකල්ප\n\n`;
    qualities.forEach((q, i) => {
      body += `${i + 1} | ${q.name}\n`;
    });
    body += `0 | ❌ වසන්න\n\nගුණාත්මක අංකයක් යවන්න.`;

    const sections = [{
      title: 'ගුණාත්මක විකල්ප',
      rows: qualities.map((q, i) => ({
        title: `${i + 1} | ${q.name}`,
        description: '',
        id: `q_${i}`
      }))
    }];
    sections[0].rows.push({ title: '0 | ❌ වසන්න', description: 'මෙනුව වසන්න', id: 'close' });

    await sendInteractiveList(
      conn, from, quotedMsg,
      'ගුණාත්මකභාවය තෝරන්න',
      body,
      'අංකයක් යවන්න හෝ ලැයිස්තුවෙන් තෝරන්න',
      sections,
      selectedItem.image || null
    );
  } catch (e) {
    console.error('[HANIME] Episode selection error:', e);
    await conn.sendMessage(from, { text: '⚠️ දෝෂයක්: ' + e.message }, { quoted: quotedMsg });
    delete sessions[from];
  }
}

// ============================================================
// Helper: Quality එකක් තෝරාගත් පසු වීඩියෝව document එකක් ලෙස යැවීම
// ============================================================
async function handleQualitySelection(conn, from, session, qualityIndex, quotedMsg) {
  try {
    const quality = session.qualities[qualityIndex];
    if (!quality) {
      await conn.sendMessage(from, { text: '❌ වලංගු නොවන තේරීමක්.' }, { quoted: quotedMsg });
      return;
    }

    const videoUrl = quality.url;
    const safeTitle = session.selectedEpisode.title.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);

    await conn.sendMessage(from, {
      document: { url: videoUrl },
      mimetype: 'video/mp4',
      fileName: `${safeTitle}_${quality.name}.mp4`,
      caption: `🎬 ${session.selectedEpisode.title}\n📥 ගුණාත්මකභාවය: ${quality.name}`
    }, { quoted: quotedMsg });

    delete sessions[from];
  } catch (e) {
    console.error('[HANIME] Quality selection error:', e);
    await conn.sendMessage(from, { text: '⚠️ වීඩියෝව යැවීමට නොහැකි විය: ' + e.message }, { quoted: quotedMsg });
    delete sessions[from];
  }
}

// ============================================================
// ප්‍රධාන command එක
// ============================================================
cmd({
  pattern: 'hanime',
  desc: 'Hanime වීඩියෝ සොයා බාගන්න',
  category: 'main',
  filename: __filename
}, async (conn, mek, m, { from, reply, q, text }) => {
  // Global connection reference එක සකසන්න (listener එකට අවශ්‍යයි)
  globalConn = conn;

  try {
    const query = q || text;
    if (!query) {
      return reply('කරුණාකර සොයා ගැනීමට නමක් ලබා දෙන්න.\nඋදා: .hanime haha');
    }

    if (sessions[from]) delete sessions[from];

    sessions[from] = { step: 'search', query };

    const results = await searchHanime(query);
    if (results.length === 0) {
      delete sessions[from];
      return reply('❌ ප්‍රතිඵල කිසිවක් හමු නොවීය.');
    }

    sessions[from].results = results;
    sessions[from].step = 'select_episode';

    let body = `🔍 සෙවුම: ${query}\n\n`;
    results.forEach((item, i) => {
      body += `${i + 1} | ${item.title}\n`;
    });
    body += `0 | ❌ වසන්න\n\nවීඩියෝ අංකයක් යවන්න.`;

    const sections = [{
      title: 'සෙවුම් ප්‍රතිඵල',
      rows: results.map((item, i) => ({
        title: `${i + 1} | ${item.title}`,
        description: '',
        id: `ep_${i}`
      }))
    }];
    sections[0].rows.push({ title: '0 | ❌ වසන්න', description: 'මෙනුව වසන්න', id: 'close' });

    const imageUrl = results[0]?.image || null;

    await sendInteractiveList(
      conn, from, mek,
      'සෙවුම් ප්‍රතිඵල',
      body,
      'අංකයක් යවන්න හෝ ලැයිස්තුවෙන් තෝරන්න',
      sections,
      imageUrl
    );
  } catch (e) {
    console.error('[HANIME] Command error:', e);
    reply('⚠️ දෝෂයක්: ' + e.message);
    if (sessions[from]) delete sessions[from];
  }
});

// ============================================================
// Listener එක Module මට්ටමේ attach කරන්න
// ============================================================
if (!global._hanimeListenerAttached) {
  global._hanimeListenerAttached = true;

  const attachListener = () => {
    if (!globalConn) {
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

        const textMsg = msg.message.conversation 
          || msg.message.extendedTextMessage?.text 
          || '';
        const listId = msg.message.listResponseMessage?.singleSelectReply?.selectedRowId;

        let selection = null;

        // 1. Interactive list response
        if (listId) {
          if (listId === 'close') {
            delete sessions[from];
            await globalConn.sendMessage(from, { text: '❌ මෙනුව වසා ඇත.' }, { quoted: msg });
            return;
          }
          const [type, indexStr] = listId.split('_');
          const index = parseInt(indexStr);
          if (type === 'ep' && !isNaN(index)) selection = { type: 'episode', index };
          else if (type === 'q' && !isNaN(index)) selection = { type: 'quality', index };
        }
        // 2. Number reply
        else if (textMsg.trim() !== '') {
          const num = parseInt(textMsg.trim());
          if (!isNaN(num)) {
            if (num === 0) {
              delete sessions[from];
              await globalConn.sendMessage(from, { text: '❌ මෙනුව වසා ඇත.' }, { quoted: msg });
              return;
            }
            if (session.step === 'select_episode') selection = { type: 'episode', index: num - 1 };
            else if (session.step === 'select_quality') selection = { type: 'quality', index: num - 1 };
          }
        }

        if (!selection) return;

        // තේරීම හසුරුවන්න
        if (selection.type === 'episode' && session.step === 'select_episode') {
          const item = session.results[selection.index];
          if (!item) {
            await globalConn.sendMessage(from, { text: '❌ වලංගු නොවන අංකයක්.' }, { quoted: msg });
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
  };

  attachListener();
}
