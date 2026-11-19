const { cmd } = require('../command');
const { generateWAMessageFromContent, proto, prepareWAMessageMedia } = require('@dnuzi/baileys');

// ============================================================
// Global Variables
// ============================================================
let globalConn = null;
const sessions = {};

global._hanimeSessions = sessions;

const SEARCH_API = 'https://poddax-api.dev/hanime2/search?text=';
const DOWNLOAD_API = 'https://poddax-api.dev/hanime2/dl?url=';

const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================
// Antiban Helper Functions (Delay & Typing Presence)
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

// ============================================================
// Helper: API Request
// ============================================================
async function fetchAPI(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json();
  if (!data.status) throw new Error('API returned status: false');
  return data.result;
}

// ============================================================
// Helper: Session timeout reset
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
// Helper: Messages auto-delete කිරීම
// ============================================================
async function cleanupSession(conn, from, session) {
  if (!session || !session.messageKeys || session.messageKeys.length === 0) return;
  
  await sleep(3000);

  for (const key of session.messageKeys) {
    try {
      await conn.sendMessage(from, { delete: key });
      await sleep(randomDelay(400, 800)); 
    } catch (e) {}
  }
}

// ============================================================
// Helper: Loading Bar (░ වලින් පිරෙනවා, 100% උනාම █ වලට මාරු වෙනවා)
// ============================================================
async function startLoading(conn, from, quotedMsg, title, subtitle, session) {
  let loadingKey = null;
  let percent = 0;

  function getBarText(p, isDone = false) {
    const totalBlocks = 20;
    
    // Done උනාම ඔක්කොම █ වලට මාරු වෙනවා
    if (isDone) {
      return '█'.repeat(totalBlocks);
    }
    
    // පිරෙන කොටස ░ වලින්, හිස් තැන් space වලින් (10% = 2 blocks)
    const filled = Math.min(totalBlocks, Math.floor(p / 5));
    const empty = totalBlocks - filled;
    return '░'.repeat(filled) + '\u00A0'.repeat(empty);
  }

  try {
    const sent = await conn.sendMessage(from, { 
      text: `📥 Downloading: ${title}\n📦 ${subtitle}\n\n${getBarText(0)}\n⏳ Please wait...` 
    }, { quoted: quotedMsg });
    
    loadingKey = sent?.key || null;
    if (loadingKey) session.messageKeys.push(loadingKey);
  } catch (e) {
    console.error('[HANIME] Failed to send loading message:', e.message);
  }

  const interval = setInterval(async () => {
    if (percent >= 90) return;
    percent += 10;
    try {
      if (loadingKey) {
        await conn.sendMessage(from, { 
          text: `📥 Downloading: ${title}\n📦 ${subtitle}\n\n${getBarText(percent)}\n⏳ Please wait...`, 
          edit: loadingKey 
        });
      }
    } catch (_) {}
  }, 1500);

  return {
    loadingKey,
    stop: () => clearInterval(interval),
    finish: async (finalText) => {
      clearInterval(interval);
      try {
        if (loadingKey) {
          // 100% Done: ඔක්කොම █ වලට මාරු වෙනවා
          await conn.sendMessage(from, { 
            text: `📥 Downloading: ${title}\n📦 ${subtitle}\n\n${getBarText(100, true)}\n✅ Done!`, 
            edit: loadingKey 
          });
          await sleep(1000);
          await conn.sendMessage(from, { text: finalText, edit: loadingKey });
        }
      } catch (_) {}
    }
  };
}

// ============================================================
// Helper: Filename Builder (Spaces support & Sub-Eng removal)
// ============================================================
function buildFileName(title, customTag) {
  let cleanTitle = title.replace(/\s*[\[\(]?\s*(sub[- _]?eng|eng[- _]?sub|sub)\s*[\]\)]?\s*/ig, ' ');
  cleanTitle = cleanTitle.replace(/[\\/:*?"<>|]/g, '');
  cleanTitle = cleanTitle.replace(/\s+/g, ' ').trim().substring(0, 60);
  if (!cleanTitle) cleanTitle = 'Video';

  const safeTag = (customTag || '')
    .replace(/[\[\]\\/:*?"<>|]/g, '') 
    .trim() 
    .substring(0, 30) || 'HANIME';

  return `${cleanTitle}[${safeTag}].mp4`;
}

// ============================================================
// Helper: Interactive List
// ============================================================
async function sendInteractiveList(conn, from, mek, session, headerTitle, bodyText, footerText, sections, imageUrl = null) {
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
    session.messageKeys.push(msg.key);
    return true;
  } catch (e) {
    const sent = await conn.sendMessage(from, { text: bodyText + '\n\n' + footerText }, { quoted: mek });
    session.messageKeys.push(sent.key);
    return false;
  }
}

// ============================================================
// Helper: Quick Reply Buttons
// ============================================================
async function sendQuickButtons(conn, from, mek, session, bodyText, footerText, buttons) {
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
    session.messageKeys.push(msg.key);
    return true;
  } catch (e) {
    let fallback = bodyText + '\n\n';
    buttons.forEach((b, i) => { fallback += `${i + 1} | ${b.text}\n`; });
    fallback += '\n' + footerText;
    const sent = await conn.sendMessage(from, { text: fallback }, { quoted: mek });
    session.messageKeys.push(sent.key);
    return false;
  }
}

// ============================================================
// Helper: API calls
// ============================================================
async function searchHanime(query) {
  const results = await fetchAPI(SEARCH_API + encodeURIComponent(query));
  if (!Array.isArray(results)) throw new Error('Search results are not an array.');
  return results.filter(item => item.title && item.url);
}

async function getDownloadLinks(pageUrl) {
  const qualities = await fetchAPI(DOWNLOAD_API + encodeURIComponent(pageUrl));
  if (!Array.isArray(qualities)) throw new Error('Download links are not an array.');
  return qualities.filter(q => q.name && q.url);
}

// ============================================================
// Helper: Send Video & Cleanup
// ============================================================
async function sendVideoToTargets(conn, from, session, quotedMsg) {
  const { selectedEpisode, selectedQuality, targetJids, customTag } = session;
  const total = targetJids.length;

  const fileName = buildFileName(selectedEpisode.title, customTag);

  await simulateTyping(conn, from, randomDelay(2000, 4000));

  const loading = await startLoading(conn, from, quotedMsg, selectedEpisode.title, `Quality: ${selectedQuality.name}`, session);

  let success = 0, failed = 0;
  const failedJids = [];

  for (const jid of targetJids) {
    try {
      if (success > 0 || failed > 0) {
        await simulateTyping(conn, from, randomDelay(5000, 10000));
      }

      await conn.sendMessage(jid, {
        document: { url: selectedQuality.url },
        mimetype: 'video/mp4',
        fileName: fileName
      });
      success++;

      await sleep(randomDelay(2000, 4000)); 

    } catch (e) {
      failed++;
      failedJids.push(jid);
      await sleep(randomDelay(1000, 2000));
    }
  }

  let finalText;
  if (failed === 0) {
    finalText = `✅ Downloaded & Uploaded!\n📁 File: ${fileName}`;
  } else {
    finalText = `⚠️ Sent to ${success}, failed ${failed}.\n📁 File: ${fileName}\n❌ Failed: ${failedJids.join(', ')}`;
  }

  await loading.finish(finalText);
  
  await cleanupSession(conn, from, session);
  delete sessions[from];
}

// ============================================================
// Helper: Episode → Quality
// ============================================================
async function handleEpisodeSelection(conn, from, session, selectedItem, quotedMsg) {
  try {
    session.step = 'select_quality';
    session.selectedEpisode = selectedItem;
    resetSessionTimeout(from);

    await simulateTyping(conn, from, randomDelay(1500, 3000));

    const qualities = await getDownloadLinks(selectedItem.url);
    if (qualities.length === 0) {
      const sent = await conn.sendMessage(from, { text: '❌ No download links found.' }, { quoted: quotedMsg });
      session.messageKeys.push(sent.key);
      await cleanupSession(conn, from, session);
      delete sessions[from];
      return;
    }

    session.qualities = qualities;
    let body = `🎬 ${selectedItem.title}\n\n📥 Available Qualities\n\n`;
    qualities.forEach((q, i) => { body += `${i + 1} | ${q.name}\n`; });
    body += `0 | ❌ Close\n\nSend the quality number.`;

    const sections = [{
      title: 'Available Qualities',
      rows: qualities.map((q, i) => ({ title: `${i + 1} | ${q.name}`, description: '', id: `q_${i}` }))
    }];
    sections[0].rows.push({ title: '0 | ❌ Close', description: 'Close this menu', id: 'close' });

    await sendInteractiveList(conn, from, quotedMsg, session, 'Select Quality', body, 'Send a number or select from the list', sections, selectedItem.image || null);
  } catch (e) {
    delete sessions[from];
  }
}

// ============================================================
// Helper: Quality → Destination Buttons
// ============================================================
async function handleQualitySelection(conn, from, session, qualityIndex, quotedMsg) {
  const quality = session.qualities[qualityIndex];
  if (!quality) {
    const sent = await conn.sendMessage(from, { text: '❌ Invalid selection.' }, { quoted: quotedMsg });
    session.messageKeys.push(sent.key);
    return;
  }

  session.selectedQuality = quality;
  session.step = 'select_destination';
  resetSessionTimeout(from);

  await simulateTyping(conn, from, randomDelay(1500, 2500));

  const bodyText = `🎬 ${session.selectedEpisode.title}\n📥 Quality: ${quality.name}\n\n📤 Where should I send the file?`;

  await sendQuickButtons(
    conn, from, quotedMsg, session,
    bodyText,
    'Choose a destination',
    [
      { text: '📥 Inbox (DM)', id: 'dest_inbox' },
      { text: '👥 Group(s)', id: 'dest_group' },
      { text: '❌ Cancel', id: 'close' }
    ]
  );
}

// ============================================================
// Main Command
// ============================================================
cmd({
  pattern: 'hanime2',
  desc: 'Search and download Hanime2 videos',
  category: 'main',
  filename: __filename
}, async (conn, mek, m, { from, reply, q, text }) => {
  globalConn = conn;

  try {
    const query = q || text;
    if (!query) return reply('Please provide a name.\nExample: .hanime haha');

    if (sessions[from]) {
      if (sessions[from].timeout) clearTimeout(sessions[from].timeout);
      delete sessions[from];
    }

    sessions[from] = { step: 'search', query, messageKeys: [mek.key] };
    resetSessionTimeout(from);

    await simulateTyping(conn, from, randomDelay(2000, 4000));

    const results = await searchHanime(query);
    if (results.length === 0) {
      delete sessions[from];
      return reply('❌ No results found.');
    }

    sessions[from].results = results;
    sessions[from].step = 'select_episode';
    resetSessionTimeout(from);

    await simulateTyping(conn, from, randomDelay(1500, 3000));

    let body = `🔍 Search: ${query}\n\n`;
    results.forEach((item, i) => { body += `${i + 1} | ${item.title}\n`; });
    body += `0 | ❌ Close\n\nSend the video number.`;

    const sections = [{
      title: 'Search Results',
      rows: results.map((item, i) => ({ title: `${i + 1} | ${item.title}`, description: '', id: `ep_${i}` }))
    }];
    sections[0].rows.push({ title: '0 | ❌ Close', description: 'Close this menu', id: 'close' });

    await sendInteractiveList(conn, from, mek, sessions[from], 'Search Results', body, 'Send a number or select from the list', sections, results[0]?.image || null);
  } catch (e) {
    reply('⚠️ Error: ' + e.message);
    if (sessions[from]) delete sessions[from];
  }
});

// ============================================================
// Listener
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

        session.messageKeys.push(msg.key);

        const inner =
          msg.message?.viewOnceMessage?.message || msg.message?.viewOnceMessageV2?.message ||
          msg.message?.ephemeralMessage?.message || msg.message;

        const textMsg = inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || '';

        let listId = null;
        listId = inner.listResponseMessage?.singleSelectReply?.selectedRowId ||
                 inner.templateButtonReplyMessage?.selectedId ||
                 inner.buttonsResponseMessage?.selectedButtonId || null;
                 
        if (!listId) {
          const paramsJson = inner.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson || inner.interactiveResponseMessage?.nativeFlowResponseMessage?.params_json;
          if (paramsJson) {
            try {
              const p = typeof paramsJson === 'string' ? JSON.parse(paramsJson) : paramsJson;
              listId = p.id || p.selectedId || p.selected_id || null;
            } catch (e) {}
          }
        }

        if (listId === 'close' || textMsg.toLowerCase() === 'cancel' || textMsg === '0') {
          if (session.timeout) clearTimeout(session.timeout);
          const sent = await globalConn.sendMessage(from, { text: '❌ Menu closed.' }, { quoted: msg });
          session.messageKeys.push(sent.key);
          await cleanupSession(globalConn, from, session);
          delete sessions[from];
          return;
        }

        // ============================================================
        // Step: select_destination
        // ============================================================
        if (session.step === 'select_destination') {
          let choice = null;
          
          if (listId === 'dest_inbox' || textMsg.toLowerCase().includes('inbox')) choice = 1;
          else if (listId === 'dest_group' || textMsg.toLowerCase().includes('group')) choice = 2;
          else {
            const num = parseInt(textMsg.trim());
            if (num === 1) choice = 1;
            else if (num === 2) choice = 2;
          }

          if (choice === 1) {
            const senderJid = msg.key.participant || msg.key.remoteJid;
            session.targetJids = [senderJid];
            session.step = 'enter_tag';
            resetSessionTimeout(from);
            
            await simulateTyping(globalConn, from, randomDelay(1000, 2000));
            const sent = await globalConn.sendMessage(from, { text: `✅ Target: Inbox\n\n📝 Send a custom tag for the filename (goes inside [ ]):\nExample: SL_HL` }, { quoted: msg });
            session.messageKeys.push(sent.key);
            return;
          }

          if (choice === 2) {
            session.step = 'enter_jids';
            resetSessionTimeout(from);
            await simulateTyping(globalConn, from, randomDelay(1000, 2000));
            const sent = await globalConn.sendMessage(from, { text: `📤 Send group JID(s). You can send multiple, separated by comma or newline.\n\nExample:\n1203631@g.us, 1203632@g.us\n\nOr type "inbox" to include your DM.` }, { quoted: msg });
            session.messageKeys.push(sent.key);
            return;
          }

          const errMsg = await globalConn.sendMessage(from, { text: '❌ Please choose using the buttons (or reply 1 / 2 / 0).' }, { quoted: msg });
          session.messageKeys.push(errMsg.key);
          return;
        }

        // ============================================================
        // Step: enter_jids
        // ============================================================
        if (session.step === 'enter_jids') {
          const raw = textMsg.trim();
          if (!raw) return;

          const senderJid = msg.key.participant || msg.key.remoteJid;
          const jids = raw.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean).map(j => {
              const lower = j.toLowerCase();
              if (lower === 'inbox' || lower === 'me') return senderJid;
              if (j.includes('@')) return j;
              if (/^\d+$/.test(j)) return j + '@g.us';
              return j;
            });

          if (jids.length === 0) return;

          session.targetJids = jids;
          session.step = 'enter_tag';
          resetSessionTimeout(from);

          await simulateTyping(globalConn, from, randomDelay(1500, 3000));
          const jidList = jids.map((j, i) => `${i + 1}. ${j}`).join('\n');
          const sent = await globalConn.sendMessage(from, { text: `✅ ${jids.length} target(s) set:\n${jidList}\n\n📝 Send a custom tag for the filename (goes inside [ ]):\nExample: SL_HL` }, { quoted: msg });
          session.messageKeys.push(sent.key);
          return;
        }

        // ============================================================
        // Step: enter_tag → Send Video
        // ============================================================
        if (session.step === 'enter_tag') {
          const raw = textMsg.trim();
          session.customTag = raw || 'HANIME';
          resetSessionTimeout(from);

          await sendVideoToTargets(globalConn, from, session, msg);
          return;
        }

        // ============================================================
        // Step: select_episode / select_quality
        // ============================================================
        let selection = null;
        if (listId && listId !== 'close') {
          const parts = listId.split('_');
          const type = parts[0];
          const index = parseInt(parts[1]);
          if (type === 'ep' && !isNaN(index)) selection = { type: 'episode', index };
          else if (type === 'q' && !isNaN(index)) selection = { type: 'quality', index };
        }

        if (!selection && textMsg && textMsg.trim() !== '') {
          const match = textMsg.trim().match(/^(\d+)/);
          if (match) {
            const num = parseInt(match[1]);
            if (session.step === 'select_episode' && num >= 1) selection = { type: 'episode', index: num - 1 };
            else if (session.step === 'select_quality' && num >= 1) selection = { type: 'quality', index: num - 1 };
          }
        }

        if (!selection) return;

        if (selection.type === 'episode' && session.step === 'select_episode') {
          const item = session.results[selection.index];
          if (!item) return;
          session.selectedIndex = selection.index;
          await handleEpisodeSelection(globalConn, from, session, item, msg);
        } else if (selection.type === 'quality' && session.step === 'select_quality') {
          await handleQualitySelection(globalConn, from, session, selection.index, msg);
        }
      } catch (err) {
        console.error('[HANIME] Listener error:', err);
      }
    });

    console.log('[HANIME] Anti-ban Listener attached successfully.');
  };

  attachListener();
}
