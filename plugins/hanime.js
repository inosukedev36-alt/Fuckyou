const { cmd } = require('../command');
const { generateWAMessageFromContent, proto, prepareWAMessageMedia } = require('@dnuzi/baileys');

// ============================================================
// Global Variables
// ============================================================
let globalConn = null;
const sessions = {};

const SEARCH_API = 'https://poddax-api.dev/hanime/search?text=';
const DOWNLOAD_API = 'https://poddax-api.dev/hanime/download?url=';

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // විනාඩි 5
const LOADING_INTERVAL_MS = 1500;         // loading bar update වන කාලය
const TOTAL_BARS = 20;                     // 5% = 1 bar, 20 bars = 100%

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
// Helper: Loading bar (• = filled, ○ = empty, 5% = 1 filled)
// ============================================================
function renderBar(percent) {
  const filled = Math.min(TOTAL_BARS, Math.floor(percent / 5));
  return '•'.repeat(filled) + '○'.repeat(TOTAL_BARS - filled);
}

function buildLoadingText(title, subtitle, totalTargets, percent) {
  const targetLine = totalTargets > 1 ? `\n📤 Sending to ${totalTargets} chats` : '';
  return `📥 Downloading: ${title}\n📦 ${subtitle}${targetLine}\n\n[${renderBar(percent)}] ${percent}%\n⏳ Please wait...`;
}

async function startLoadingBar(conn, from, quotedMsg, title, subtitle, totalTargets) {
  let loadingKey = null;
  let percent = 0;

  try {
    const sent = await conn.sendMessage(from, { text: buildLoadingText(title, subtitle, totalTargets, 0) }, { quoted: quotedMsg });
    loadingKey = sent?.key || null;
  } catch (e) {
    console.error('[HANIME] Failed to send loading message:', e.message);
  }

  const interval = setInterval(async () => {
    if (percent >= 95) return;
    percent = Math.min(95, percent + Math.floor(Math.random() * 3) + 3);
    try {
      if (loadingKey) {
        await conn.sendMessage(from, { text: buildLoadingText(title, subtitle, totalTargets, percent), edit: loadingKey });
      }
    } catch (_) {}
  }, LOADING_INTERVAL_MS);

  return {
    loadingKey,
    stop: () => clearInterval(interval),
    finish: async (finalText) => {
      clearInterval(interval);
      // 100% දක්වා smooth jump
      let p = percent;
      while (p < 100) {
        p = Math.min(100, p + 10);
        try {
          await conn.sendMessage(from, { text: buildLoadingText(title, subtitle, totalTargets, p), edit: loadingKey });
          await new Promise(r => setTimeout(r, 120));
        } catch (_) {}
      }
      await new Promise(r => setTimeout(r, 500));
      try {
        await conn.sendMessage(from, { text: finalText, edit: loadingKey });
        setTimeout(async () => {
          try { await conn.sendMessage(from, { delete: loadingKey }); } catch (_) {}
        }, 4000);
      } catch (_) {}
    }
  };
}

// ============================================================
// Helper: Filename builders
// Format: (EP01)TitleName[CustomTag].mp4
// ============================================================
function extractEpisodeNum(title, fallbackIndex) {
  const patterns = [
    /\(ep?[\s._-]*(\d{1,4})\)/i,
    /\bep?[\s._-]*(\d{1,4})\b/i,
    /\bepisode[\s._-]*(\d{1,4})\b/i,
    /^\s*(\d{1,4})\b/
  ];
  for (const p of patterns) {
    const m = title.match(p);
    if (m) return String(m[1]).padStart(2, '0');
  }
  return String(fallbackIndex).padStart(2, '0');
}

function buildFileName(title, episodeNum, customTag) {
  const cleanTitle = title.replace(/[^\w]/g, '').substring(0, 50) || 'Video';
  const safeTag = (customTag || '').replace(/[\[\]\/\\:*?"<>|]/g, '').trim().substring(0, 30) || 'HANIME';
  return `(EP${episodeNum})${cleanTitle}[${safeTag}].mp4`;
}

// ============================================================
// Helper: Interactive list
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
        console.error('[HANIME] Media prepare failed:', imgErr.message);
        media = {};
      }
    }

    const listParams = { title: headerTitle, sections };

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
    await conn.sendMessage(from, { text: bodyText + '\n\n' + footerText }, { quoted: mek });
    return false;
  }
}

// ============================================================
// Helper: API search / download
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
// Helper: Send video to all targets (loading bar සමඟ)
// ============================================================
async function sendVideoToTargets(conn, from, session, quotedMsg) {
  const { selectedEpisode, selectedQuality, targetJids, customTag, selectedIndex } = session;
  const total = targetJids.length;

  const episodeNum = extractEpisodeNum(selectedEpisode.title, (selectedIndex || 0) + 1);
  const fileName = buildFileName(selectedEpisode.title, episodeNum, customTag);
  const caption = `🎬 ${selectedEpisode.title}\n📥 Quality: ${selectedQuality.name}`;

  const loading = await startLoadingBar(
    conn, from, quotedMsg,
    selectedEpisode.title,
    `Quality: ${selectedQuality.name}`,
    total
  );

  let success = 0, failed = 0;
  const failedJids = [];

  for (const jid of targetJids) {
    try {
      await conn.sendMessage(jid, {
        document: { url: selectedQuality.url },
        mimetype: 'video/mp4',
        fileName: fileName,
        caption: caption
      });
      success++;
    } catch (e) {
      failed++;
      failedJids.push(jid);
      console.error(`[HANIME] Failed to send to ${jid}:`, e.message);
    }
  }

  let finalText;
  if (failed === 0) {
    finalText = `✅ Downloaded & sent to ${success} chat(s)!\n📁 File: ${fileName}`;
  } else {
    finalText = `⚠️ Sent to ${success}, failed ${failed}.\n📁 File: ${fileName}\n❌ Failed: ${failedJids.join(', ')}`;
  }

  await loading.finish(finalText);
  delete sessions[from];
}

// ============================================================
// Helper: Episode selection → quality ලැයිස්තුව යවයි
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
    qualities.forEach((q, i) => { body += `${i + 1} | ${q.name}\n`; });
    body += `0 | ❌ Close\n\nSend the quality number.`;

    const sections = [{
      title: 'Available Qualities',
      rows: qualities.map((q, i) => ({ title: `${i + 1} | ${q.name}`, description: '', id: `q_${i}` }))
    }];
    sections[0].rows.push({ title: '0 | ❌ Close', description: 'Close this menu', id: 'close' });

    await sendInteractiveList(conn, from, quotedMsg, 'Select Quality', body, 'Send a number or select from the list', sections, selectedItem.image || null);
  } catch (e) {
    console.error('[HANIME] Episode selection error:', e);
    await conn.sendMessage(from, { text: '⚠️ Error: ' + e.message }, { quoted: quotedMsg });
    delete sessions[from];
  }
}

// ============================================================
// Helper: Quality selection → destination අහයි
// ============================================================
async function handleQualitySelection(conn, from, session, qualityIndex, quotedMsg) {
  const quality = session.qualities[qualityIndex];
  if (!quality) {
    await conn.sendMessage(from, { text: '❌ Invalid selection.' }, { quoted: quotedMsg });
    return;
  }

  session.selectedQuality = quality;
  session.step = 'select_destination';
  resetSessionTimeout(from);

  await conn.sendMessage(from, {
    text: `🎬 ${session.selectedEpisode.title}\n📥 Quality: ${quality.name}\n\n📤 Where to send?\n\n1 | Inbox (DM)\n2 | Group(s)\n0 | ❌ Cancel\n\nReply with a number.`
  }, { quoted: quotedMsg });
}

// ============================================================
// Command
// ============================================================
cmd({
  pattern: 'hanime',
  desc: 'Search and download Hanime videos',
  category: 'main',
  filename: __filename
}, async (conn, mek, m, { from, reply, q, text }) => {
  globalConn = conn;

  try {
    const query = q || text;
    if (!query) {
      return reply('Please provide a name to search.\nExample: .hanime haha');
    }

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
    results.forEach((item, i) => { body += `${i + 1} | ${item.title}\n`; });
    body += `0 | ❌ Close\n\nSend the video number.`;

    const sections = [{
      title: 'Search Results',
      rows: results.map((item, i) => ({ title: `${i + 1} | ${item.title}`, description: '', id: `ep_${i}` }))
    }];
    sections[0].rows.push({ title: '0 | ❌ Close', description: 'Close this menu', id: 'close' });

    const imageUrl = results[0]?.image || null;

    await sendInteractiveList(conn, from, mek, 'Search Results', body, 'Send a number or select from the list', sections, imageUrl);
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

        // Debug (ඕන නම් uncomment):
        // console.log('[HANIME] incoming:', JSON.stringify(msg.message, null, 2));

        // Wrap ඉවත් කරයි
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

        // ============================================================
        // Step: enter_jids - user group JIDs එවයි (2කට වඩා support)
        // ============================================================
        if (session.step === 'enter_jids') {
          const raw = textMsg.trim();
          if (!raw) return;

          const senderJid = msg.key.participant || msg.key.remoteJid;
          const jids = raw.split(/[\n,;]+/)
            .map(s => s.trim())
            .filter(Boolean)
            .map(j => {
              const lower = j.toLowerCase();
              if (lower === 'inbox' || lower === 'me') return senderJid;
              if (j.includes('@')) return j;
              if (/^\d+$/.test(j)) return j + '@g.us';
              return j;
            });

          if (jids.length === 0) {
            await globalConn.sendMessage(from, { text: '❌ No valid JIDs provided.' }, { quoted: msg });
            return;
          }

          session.targetJids = jids;
          session.step = 'enter_tag';
          resetSessionTimeout(from);

          const jidList = jids.map((j, i) => `${i + 1}. ${j}`).join('\n');
          await globalConn.sendMessage(from, {
            text: `✅ ${jids.length} target(s) set:\n${jidList}\n\n📝 Send a custom tag for the filename (goes inside [ ]):\nExample: SL_HL`
          }, { quoted: msg });
          return;
        }

        // ============================================================
        // Step: enter_tag - custom filename tag එවයි → file යවයි
        // ============================================================
        if (session.step === 'enter_tag') {
          const raw = textMsg.trim();

          if (raw.toLowerCase() === 'cancel') {
            delete sessions[from];
            await globalConn.sendMessage(from, { text: '❌ Cancelled.' }, { quoted: msg });
            return;
          }

          session.customTag = raw || 'HANIME';
          resetSessionTimeout(from);

          await sendVideoToTargets(globalConn, from, session, msg);
          return;
        }

        // ============================================================
        // Interactive list / button response parse කිරීම
        // ============================================================
        let listId = null;

        listId = inner.listResponseMessage?.singleSelectReply?.selectedRowId || null;
        if (!listId) listId = inner.buttonsResponseMessage?.selectedButtonId || null;
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

        // Close / cancel check
        if (listId === 'close') {
          if (session.timeout) clearTimeout(session.timeout);
          delete sessions[from];
          await globalConn.sendMessage(from, { text: '❌ Menu closed.' }, { quoted: msg });
          return;
        }

        // ============================================================
        // Step: select_destination - Inbox ද Group(s) ද තෝරයි
        // ============================================================
        if (session.step === 'select_destination') {
          const num = parseInt(textMsg.trim());

          if (isNaN(num)) {
            await globalConn.sendMessage(from, { text: '❌ Please reply with a number (1, 2, or 0).' }, { quoted: msg });
            return;
          }

          if (num === 0) {
            if (session.timeout) clearTimeout(session.timeout);
            delete sessions[from];
            await globalConn.sendMessage(from, { text: '❌ Menu closed.' }, { quoted: msg });
            return;
          }

          if (num === 1) {
            const senderJid = msg.key.participant || msg.key.remoteJid;
            session.targetJids = [senderJid];
            session.step = 'enter_tag';
            resetSessionTimeout(from);
            await globalConn.sendMessage(from, {
              text: `✅ Target: Inbox\n\n📝 Send a custom tag for the filename (goes inside [ ]):\nExample: SL_HL`
            }, { quoted: msg });
            return;
          }

          if (num === 2) {
            session.step = 'enter_jids';
            resetSessionTimeout(from);
            await globalConn.sendMessage(from, {
              text: `📤 Send group JID(s). You can send multiple, separated by comma or newline.\n\nExample:\n1203631@g.us, 1203632@g.us\n\nOr type "inbox" to include your DM.`
            }, { quoted: msg });
            return;
          }

          await globalConn.sendMessage(from, { text: '❌ Invalid option.' }, { quoted: msg });
          return;
        }

        // ============================================================
        // Step: select_episode / select_quality - list/number selection
        // ============================================================
        let selection = null;

        if (listId) {
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
          session.selectedIndex = selection.index;
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
