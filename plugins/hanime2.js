const { cmd } = require('../command');
const { generateWAMessageFromContent, proto, prepareWAMessageMedia } = require('@dnuzi/baileys');

// ============================================================
// FIX NOTES — hanime2.js
// ------------------------------------------------------------
// 1) පරණ code එකේ `global._hanimeListenerAttached` flag එක hanime / hanime2 /
//    hanime3 ඔක්කොටම common. ඒ නිසා මුලින්ම load වෙන hanime.js එකේ listener
//    එක විතරක් attach වෙලා, ඒක බැලුවේ hanime.js එකේම `sessions` විතරයි.
//    hanime2 එකේ session එකට reply කරාම අහන කෙනෙක් හිටියේ නැහැ → මුකුත් වුණේ නැහැ.
//    දැන් මේ file එකට ම unique listener එකක් (PLUGIN_ID එකෙන් namespaced).
// 2) Listener එක command එක run වෙද්දි දැනට තියෙන `conn` එකට bind වෙනවා.
//    (bot reconnect / plugin reload වුණත් පරණ listener අයින් කරලා අලුත් එක දානවා.)
// 3) API response shape එක පොඩ්ඩක් වෙනස් වුණත් parse වෙනවා. Error එකක් ආවොත්
//    chat එකේ පෙන්නනවා (කලින් silent fail).
// NOTE: global._hanimeSessions මෙතන set කරන්නේ නැහැ (hanime.js එකේ එකම තියෙනවා).
// ============================================================

// ============================================================
// Plugin Config
// ============================================================
const PLUGIN_ID = 'hanime2';            // UNIQUE per file
const TAG = '[HANIME2]';

const SEARCH_API = 'https://poddax-api.dev/hanime2/search?text=';
const DOWNLOAD_API = 'https://poddax-api.dev/hanime2/dl?url=';

const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const API_TIMEOUT_MS = 30 * 1000;

// ============================================================
// Global Variables
// ============================================================
const sessions = {};

// හැම hanime*.js file එකක්ම තමන්ගේ session store එක මෙතන register කරනවා.
// (එකම chat එකේ plugin දෙකක session එකවර තියෙන්නේ නැති වෙන්න)
const registry = (global._hanimeRegistry = global._hanimeRegistry || {});
registry[PLUGIN_ID] = sessions;

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
// Helper: API Request + tolerant response parsing
// ============================================================
const timeoutSignal = (ms) =>
  (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.timeout(ms)
    : undefined;

async function fetchAPI(url) {
  const res = await fetch(url, { signal: timeoutSignal(API_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  let data;
  try {
    data = await res.json();
  } catch (_) {
    throw new Error('API did not return valid JSON.');
  }

  if (!data || data.status === false || data.success === false) {
    throw new Error((data && (data.message || data.error)) || 'API returned status: false');
  }

  // බොහෝ endpoints වල payload එක `result` ඇතුලේ. නැත්නම් body එකම ගන්නවා.
  return data.result ?? data.results ?? data.data ?? data;
}

const URL_KEYS = ['url', 'link', 'download', 'download_url', 'downloadUrl', 'direct', 'direct_url', 'src', 'file', 'href'];
const QUALITY_NAME_KEYS = ['quality', 'resolution', 'res', 'label', 'name', 'format', 'title'];
const IMAGE_KEYS = ['image', 'thumbnail', 'thumb', 'cover', 'poster', 'img'];

const IMAGE_KEY_RE = /thumb|image|cover|poster|banner|preview|img/i;
const QUALITY_KEY_RE = /\d{3,4}\s*p?|\b(hd|sd|fhd|uhd|4k|low|medium|high)\b/i;

function pickStr(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const v = obj[k];
    if ((typeof v === 'string' || typeof v === 'number') && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function findList(payload, keys, depth = 0) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object' || depth > 2) return null;
  for (const k of keys) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  for (const k of keys) {
    if (payload[k] && typeof payload[k] === 'object') {
      const found = findList(payload[k], keys, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function guessQualityName(url, i) {
  const m = String(url || '').match(/(\d{3,4})p/i);
  return m ? `${m[1]}p` : `Quality ${i + 1}`;
}

function normalizeUrl(u) {
  const s = String(u || '').trim();
  if (s.startsWith('//')) return 'https:' + s;
  return s;
}

function normalizeSearch(payload) {
  const list = findList(payload, ['results', 'result', 'data', 'items', 'list', 'videos', 'episodes', 'search']);
  if (!list) throw new Error('Search results are not an array.');

  return list
    .filter(it => it && typeof it === 'object')
    .map(it => ({
      ...it,
      title: pickStr(it, ['title', 'name', 'text', 'episode']),
      url: normalizeUrl(pickStr(it, ['url', 'link', 'href', 'page'])),
      image: pickStr(it, IMAGE_KEYS) || null
    }))
    .filter(it => it.title && it.url);
}

function normalizeQualities(payload) {
  let list = findList(payload, ['downloads', 'download', 'links', 'qualities', 'sources', 'urls', 'formats', 'videos', 'files', 'data', 'result']);

  if (!list && payload && typeof payload === 'object') {
    // { "720p": "https://...", "480p": "https://..." }
    const entries = Object.entries(payload).filter(([k, v]) =>
      typeof v === 'string' && /^(https?:)?\/\//i.test(v) && !IMAGE_KEY_RE.test(k) && QUALITY_KEY_RE.test(k));
    if (entries.length) list = entries.map(([name, url]) => ({ name, url }));
    // එක direct link එකක් විතරක් තියෙන object එකක්
    else if (pickStr(payload, URL_KEYS)) list = [payload];
  }
  if (!list) throw new Error('Download links are not an array.');

  return list
    .map((q, i) => {
      if (typeof q === 'string') return { name: guessQualityName(q, i), url: normalizeUrl(q) };
      if (!q || typeof q !== 'object') return null;
      const url = normalizeUrl(pickStr(q, URL_KEYS));
      let name = pickStr(q, QUALITY_NAME_KEYS);
      if (/^\d{3,4}$/.test(name)) name += 'p';
      return { ...q, name: name || guessQualityName(url, i), url };
    })
    .filter(q => q && q.name && /^https?:\/\//i.test(q.url || ''));
}

function logPayload(label, payload) {
  try {
    console.error(`${TAG} ${label}:`, JSON.stringify(payload).slice(0, 600));
  } catch (_) {}
}

async function searchHanime(query) {
  const payload = await fetchAPI(SEARCH_API + encodeURIComponent(query));
  try {
    return normalizeSearch(payload);
  } catch (e) {
    logPayload('Unexpected search response', payload);
    throw e;
  }
}

async function getDownloadLinks(pageUrl) {
  const payload = await fetchAPI(DOWNLOAD_API + encodeURIComponent(pageUrl));
  let qualities;
  try {
    qualities = normalizeQualities(payload);
  } catch (e) {
    logPayload('Unexpected download response', payload);
    throw e;
  }
  if (qualities.length === 0) logPayload('Download response had no usable links', payload);
  return qualities;
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
      console.log(`${TAG} Session expired for ${from}`);
    }
  }, SESSION_TIMEOUT_MS);
}

// ============================================================
// Helper: අනිත් hanime plugins වල මේ chat එකේ session තියෙනවා නම් වහනවා
// ============================================================
function closeOtherSessions(from) {
  const stores = Object.entries(registry).filter(([id]) => id !== PLUGIN_ID).map(([, s]) => s);
  const legacy = global._hanimeSessions;                     // hanime.js එක expose කරන store එක
  if (legacy && legacy !== sessions && !stores.includes(legacy)) stores.push(legacy);

  for (const store of stores) {
    const s = store[from];
    if (!s) continue;
    if (s.timeout) clearTimeout(s.timeout);
    delete store[from];
  }
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
    console.error(`${TAG} Failed to send loading message:`, e.message);
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
// Helper: Send Video & Cleanup
// ============================================================
async function sendVideoToTargets(conn, from, session, quotedMsg) {
  const { selectedEpisode, selectedQuality, targetJids, customTag } = session;

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
      console.error(`${TAG} Send failed for ${jid}:`, e.message);
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
  if (sessions[from] === session) delete sessions[from];
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
    if (sessions[from] !== session) return;           // මේ අතරේ close / replace වුණා නම්

    if (qualities.length === 0) {
      const sent = await conn.sendMessage(from, { text: '❌ No download links found.' }, { quoted: quotedMsg });
      session.messageKeys.push(sent.key);
      await cleanupSession(conn, from, session);
      if (sessions[from] === session) delete sessions[from];
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
    // කලින් මෙතන session එක නිකම්ම delete වෙලා user ට මුකුත් පෙන්නුවේ නැහැ.
    console.error(`${TAG} Episode selection failed:`, e);
    if (sessions[from] !== session) return;
    session.step = 'select_episode';                  // තව episode එකක් try කරන්න පුළුවන්
    try {
      const sent = await conn.sendMessage(from, {
        text: `⚠️ Error: ${e.message}\n\nPick another number, or send 0 to close.`
      }, { quoted: quotedMsg });
      session.messageKeys.push(sent.key);
    } catch (_) {}
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
// Listener  (මේ file එකට ම පමණක් — hanime.js එකේ listener එකෙන් වෙන්)
// ============================================================
const MODULE_TOKEN = {};                              // file එක reload වුණාම වෙනස් වෙනවා
const LISTENER_KEY = `_${PLUGIN_ID}Listener`;         // e.g. global._hanime2Listener

// එකම message එක දෙපාරක් process වෙන එක නවත්තන්න
const seenMsgIds = new Map();
function alreadyHandled(id) {
  if (!id) return false;
  if (seenMsgIds.has(id)) return true;
  seenMsgIds.set(id, Date.now());
  if (seenMsgIds.size > 300) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, t] of seenMsgIds) if (t < cutoff) seenMsgIds.delete(k);
  }
  return false;
}

async function handleIncoming(conn, msg) {
  if (!msg || !msg.message || msg.key.fromMe) return;

  const from = msg.key.remoteJid;
  const session = sessions[from];
  if (!session) return;
  if (alreadyHandled(msg.key.id)) return;

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
    const sent = await conn.sendMessage(from, { text: '❌ Menu closed.' }, { quoted: msg });
    session.messageKeys.push(sent.key);
    await cleanupSession(conn, from, session);
    if (sessions[from] === session) delete sessions[from];
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

      await simulateTyping(conn, from, randomDelay(1000, 2000));
      const sent = await conn.sendMessage(from, { text: `✅ Target: Inbox\n\n📝 Send a custom tag for the filename (goes inside [ ]):\nExample: SL_HL` }, { quoted: msg });
      session.messageKeys.push(sent.key);
      return;
    }

    if (choice === 2) {
      session.step = 'enter_jids';
      resetSessionTimeout(from);
      await simulateTyping(conn, from, randomDelay(1000, 2000));
      const sent = await conn.sendMessage(from, { text: `📤 Send group JID(s). You can send multiple, separated by comma or newline.\n\nExample:\n1203631@g.us, 1203632@g.us\n\nOr type "inbox" to include your DM.` }, { quoted: msg });
      session.messageKeys.push(sent.key);
      return;
    }

    const errMsg = await conn.sendMessage(from, { text: '❌ Please choose using the buttons (or reply 1 / 2 / 0).' }, { quoted: msg });
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

    await simulateTyping(conn, from, randomDelay(1500, 3000));
    const jidList = jids.map((j, i) => `${i + 1}. ${j}`).join('\n');
    const sent = await conn.sendMessage(from, { text: `✅ ${jids.length} target(s) set:\n${jidList}\n\n📝 Send a custom tag for the filename (goes inside [ ]):\nExample: SL_HL` }, { quoted: msg });
    session.messageKeys.push(sent.key);
    return;
  }

  // ============================================================
  // Step: enter_tag → Send Video
  // ============================================================
  if (session.step === 'enter_tag') {
    const raw = textMsg.trim();
    session.customTag = raw || 'HANIME';
    session.step = 'sending';                         // දෙපාරක් trigger වෙන්නේ නැති වෙන්න
    resetSessionTimeout(from);

    await sendVideoToTargets(conn, from, session, msg);
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
    await handleEpisodeSelection(conn, from, session, item, msg);
  } else if (selection.type === 'quality' && session.step === 'select_quality') {
    await handleQualitySelection(conn, from, session, selection.index, msg);
  }
}

function makeHandler(conn) {
  return async (m) => {
    for (const msg of (m && m.messages) || []) {
      try {
        await handleIncoming(conn, msg);
      } catch (err) {
        console.error(`${TAG} Listener error:`, err);
      }
    }
  };
}

// command එක run වෙන හැම වෙලාවකම call කරනවා — listener එක දැනට තියෙන conn එකට bind කරනවා
function ensureListener(conn) {
  const prev = global[LISTENER_KEY];
  if (prev && prev.conn === conn && prev.owner === MODULE_TOKEN) return;

  if (prev) {
    try {
      const ev = prev.conn.ev;
      (ev.off || ev.removeListener).call(ev, 'messages.upsert', prev.handler);
    } catch (_) {}
  }

  const handler = makeHandler(conn);
  conn.ev.on('messages.upsert', handler);
  global[LISTENER_KEY] = { conn, owner: MODULE_TOKEN, handler };
  console.log(`${TAG} Listener attached.`);
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
  ensureListener(conn);

  let session = null;

  try {
    const query = (q || text || '').trim();
    if (!query) return reply('Please provide a name.\nExample: .hanime2 haha');

    closeOtherSessions(from);
    if (sessions[from]) {
      if (sessions[from].timeout) clearTimeout(sessions[from].timeout);
      delete sessions[from];
    }

    session = { step: 'search', query, messageKeys: [mek.key] };
    sessions[from] = session;
    resetSessionTimeout(from);

    await simulateTyping(conn, from, randomDelay(2000, 4000));

    const results = await searchHanime(query);
    if (sessions[from] !== session) return;           // search කරද්දි close / replace වුණා නම්

    console.log(`${TAG} "${query}" → ${results.length} result(s)`);

    if (results.length === 0) {
      if (session.timeout) clearTimeout(session.timeout);
      delete sessions[from];
      return reply('❌ No results found.');
    }

    session.results = results;
    session.step = 'select_episode';
    resetSessionTimeout(from);

    await simulateTyping(conn, from, randomDelay(1500, 3000));
    if (sessions[from] !== session) return;

    let body = `🔍 Search: ${query}\n\n`;
    results.forEach((item, i) => { body += `${i + 1} | ${item.title}\n`; });
    body += `0 | ❌ Close\n\nSend the video number.`;

    const sections = [{
      title: 'Search Results',
      rows: results.map((item, i) => ({ title: `${i + 1} | ${item.title}`, description: '', id: `ep_${i}` }))
    }];
    sections[0].rows.push({ title: '0 | ❌ Close', description: 'Close this menu', id: 'close' });

    await sendInteractiveList(conn, from, mek, session, 'Search Results', body, 'Send a number or select from the list', sections, results[0]?.image || null);
  } catch (e) {
    console.error(`${TAG} Command error:`, e);
    reply('⚠️ Error: ' + e.message);
    if (session && sessions[from] === session) {
      if (session.timeout) clearTimeout(session.timeout);
      delete sessions[from];
    }
  }
});
