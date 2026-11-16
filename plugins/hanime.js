const { cmd } = require('../command');
const { generateWAMessageFromContent, proto, prepareWAMessageMedia } = require('@dnuzi/baileys');

// සැසි දත්ත ගබඩා කිරීම (user අනුව)
const sessions = {};

// API base URLs
const SEARCH_API = 'https://poddax-api.dev/hanime/search?text=';
const DOWNLOAD_API = 'https://poddax-api.dev/hanime/download?url=';

// Helper: API එකෙන් දත්ත ලබා ගැනීම
async function fetchAPI(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data;
}

// Helper: Interactive list message එකක් යැවීම (Baileys හි නිවැරදි ක්‍රමය)
async function sendInteractiveList(conn, from, mek, headerTitle, bodyText, footerText, sections, imageUrl = null) {
  try {
    let media = {};
    if (imageUrl) {
      media = await prepareWAMessageMedia(
        { image: { url: imageUrl } },
        { upload: conn.waUploadToServer }
      );
    }

    const listParams = {
      title: headerTitle,
      sections: sections
    };

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
    console.error('Interactive send error:', e);
    // Fallback: සාමාන්‍ය text message එකක් යවන්න
    await conn.sendMessage(from, { text: bodyText + '\n\n' + footerText }, { quoted: mek });
    return false;
  }
}

// Helper: Search API එකෙන් ප්‍රතිඵල ලබා ගැනීම සහ ඒවා normalise කිරීම
async function searchHanime(query) {
  const raw = await fetchAPI(SEARCH_API + encodeURIComponent(query));
  
  // API ප්‍රතිඵලය array එකක් හෝ object එකක් විය හැක. දෙකම හසුරුවන්න.
  let results = [];
  if (Array.isArray(raw)) {
    results = raw;
  } else if (raw && Array.isArray(raw.data)) {
    results = raw.data;
  } else if (raw && Array.isArray(raw.results)) {
    results = raw.results;
  } else if (raw && Array.isArray(raw.result)) {
    results = raw.result;
  } else {
    throw new Error('Unexpected search API response structure.');
  }

  // අවශ්‍ය fields ඇති බවට වග බලා ගන්න
  return results.map(item => ({
    title: item.title || item.name || 'Unknown Title',
    url: item.url || item.link || item.page_url || '',
    image: item.image || item.thumbnail || item.cover || null,
    description: item.description || item.desc || ''
  })).filter(item => item.title && item.url);
}

// Helper: Download API එකෙන් quality/ලින්ක් ලබා ගැනීම
async function getDownloadLinks(pageUrl) {
  const raw = await fetchAPI(DOWNLOAD_API + encodeURIComponent(pageUrl));

  // API ප්‍රතිඵලයේ ව්‍යුහය විවිධාකාර විය හැක. පොදු fields සොයන්න.
  let qualities = [];
  if (Array.isArray(raw)) {
    qualities = raw;
  } else if (raw && Array.isArray(raw.qualities)) {
    qualities = raw.qualities;
  } else if (raw && Array.isArray(raw.links)) {
    qualities = raw.links;
  } else if (raw && Array.isArray(raw.downloads)) {
    qualities = raw.downloads;
  } else if (raw && raw.data && Array.isArray(raw.data)) {
    qualities = raw.data;
  } else if (raw && raw.data && Array.isArray(raw.data.qualities)) {
    qualities = raw.data.qualities;
  } else {
    throw new Error('Unexpected download API response structure.');
  }

  return qualities.map(q => ({
    quality: q.quality || q.label || q.resolution || 'Unknown',
    size: q.size || q.file_size || '',
    url: q.url || q.link || q.download_url || ''
  })).filter(q => q.url);
}

// Helper: Episode එකක් තෝරාගත් පසු quality ලැයිස්තුව යැවීම
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

    // Numbered text list එකක් සකසන්න
    let body = `🎬 ${selectedItem.title}\n\n📥 ගුණාත්මක විකල්ප\n\n`;
    qualities.forEach((q, i) => {
      body += `${i + 1} | ${q.quality} ${q.size ? `(${q.size})` : ''}\n`;
    });
    body += `0 | ❌ වසන්න\n\nගුණාත්මක අංකයක් යවන්න.`;

    // Interactive list එකක් සකසන්න
    const sections = [{
      title: 'ගුණාත්මක විකල්ප',
      rows: qualities.map((q, i) => ({
        title: `${i + 1} | ${q.quality}`,
        description: q.size || '',
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
    console.error('Episode selection error:', e);
    await conn.sendMessage(from, { text: '⚠️ දෝෂයක්: ' + e.message }, { quoted: quotedMsg });
    delete sessions[from];
  }
}

// Helper: Quality එකක් තෝරාගත් පසු වීඩියෝව document එකක් ලෙස යැවීම
async function handleQualitySelection(conn, from, session, qualityIndex, quotedMsg) {
  try {
    const quality = session.qualities[qualityIndex];
    if (!quality) {
      await conn.sendMessage(from, { text: '❌ වලංගු නොවන තේරීමක්.' }, { quoted: quotedMsg });
      return;
    }

    const videoUrl = quality.url;
    const safeTitle = session.selectedEpisode.title.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);

    // වීඩියෝව document එකක් ලෙස යවන්න
    await conn.sendMessage(from, {
      document: { url: videoUrl },
      mimetype: 'video/mp4',
      fileName: `${safeTitle}_${quality.quality || 'video'}.mp4`,
      caption: `🎬 ${session.selectedEpisode.title}\n📥 ගුණාත්මකභාවය: ${quality.quality}`
    }, { quoted: quotedMsg });

    // සැසිය ඉවත් කරන්න
    delete sessions[from];

  } catch (e) {
    console.error('Quality selection error:', e);
    await conn.sendMessage(from, { text: '⚠️ වීඩියෝව යැවීමට නොහැකි විය: ' + e.message }, { quoted: quotedMsg });
    delete sessions[from];
  }
}

// ප්‍රධාන command එක
cmd({
  pattern: 'hanime',
  desc: 'Hanime වීඩියෝ සොයා බාගන්න',
  category: 'main',
  filename: __filename
}, async (conn, mek, m, { from, reply, q, text }) => {
  try {
    const query = q || text;
    if (!query) {
      return reply('කරුණාකර සොයා ගැනීමට නමක් ලබා දෙන්න.\nඋදා: .hanime haha');
    }

    // පෙර සැසියක් තිබේ නම් එය මකන්න
    if (sessions[from]) delete sessions[from];

    // නව සැසියක් ආරම්භ කරන්න
    sessions[from] = { step: 'search', query };

    const results = await searchHanime(query);
    if (results.length === 0) {
      delete sessions[from];
      return reply('❌ ප්‍රතිඵල කිසිවක් හමු නොවීය.');
    }

    sessions[from].results = results;
    sessions[from].step = 'select_episode';

    // Numbered text list එකක් සකසන්න
    let body = `🔍 සෙවුම: ${query}\n\n`;
    results.forEach((item, i) => {
      body += `${i + 1} | ${item.title}\n`;
    });
    body += `0 | ❌ වසන්න\n\nවීඩියෝ අංකයක් යවන්න.`;

    // Interactive list එකක් සකසන්න
    const sections = [{
      title: 'සෙවුම් ප්‍රතිඵල',
      rows: results.map((item, i) => ({
        title: `${i + 1} | ${item.title}`,
        description: item.description || '',
        id: `ep_${i}`
      }))
    }];
    sections[0].rows.push({ title: '0 | ❌ වසන්න', description: 'මෙනුව වසන්න', id: 'close' });

    // පළමු ප්‍රතිඵලයේ රූපය තිබේ නම් එය භාවිතා කරන්න
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
    console.error(e);
    reply('⚠️ දෝෂයක්: ' + e.message);
    if (sessions[from]) delete sessions[from];
  }
});

// ============================================================
// අංක පිළිතුරු සහ Interactive List තේරීම් හසුරුවන Listener එක
// ============================================================
// මෙය එක් වරක් පමණක් attach වේ
if (!global._hanimeListenerAttached) {
  global._hanimeListenerAttached = true;

  // conn object එක command එකෙන් ලබා ගනී. එබැවින් listener එක command එක තුළ attach කරමු.
  // නමුත් command එක නැවත නැවත run වන විට listener එක නැවත attach නොවීමට ඉහත flag එක භාවිතා කරන්න.
}

// Listener එක command එක තුළ attach කරන්න (conn එක ලබා ගැනීමට)
// මෙය සෑම විටම command එක run වන විට attach නොවී, එක් වරක් පමණක් සිදු වේ
cmd({
  pattern: 'hanime_listener',
  desc: 'Hanime replies සඳහා internal listener',
  category: 'hidden',
  filename: __filename
}, async (conn, mek, m, { from }) => {
  // මෙය command එකක් නොව, listener එක attach කිරීමට භාවිතා කරන internal command එකකි
  if (!conn._hanimeReplyListener) {
    conn._hanimeReplyListener = true;
    conn.ev.on('messages.upsert', async (m) => {
      try {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const session = sessions[from];
        if (!session) return;

        // Text එක ලබා ගන්න
        const textMsg = msg.message.conversation 
          || msg.message.extendedTextMessage?.text 
          || '';
        
        // Interactive list response එක ලබා ගන්න
        const listId = msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
          || msg.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson?.selectedRowId;

        let selection = null;

        // 1. Interactive list response
        if (listId) {
          if (listId === 'close') {
            delete sessions[from];
            await conn.sendMessage(from, { text: '❌ මෙනුව වසා ඇත.' }, { quoted: msg });
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
              await conn.sendMessage(from, { text: '❌ මෙනුව වසා ඇත.' }, { quoted: msg });
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
            await conn.sendMessage(from, { text: '❌ වලංගු නොවන අංකයක්.' }, { quoted: msg });
            return;
          }
          await handleEpisodeSelection(conn, from, session, item, msg);
        } else if (selection.type === 'quality' && session.step === 'select_quality') {
          await handleQualitySelection(conn, from, session, selection.index, msg);
        }

      } catch (err) {
        console.error('Listener error:', err);
      }
    });
  }
});
