const { cmd } = require('../command');
const { generateWAMessageFromContent, proto, prepareWAMessageMedia } = require('@dnuzi/baileys');

// ============================================================
// Config
// ============================================================
const API_BASE = 'https://vortex-api-theta.vercel.app/nsfw/watchhentai';
const SITE_BASE = 'https://watchhentai.net';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // idle session expires after 30 minutes
const API_TIMEOUT_MS = 60 * 1000;          // max wait for a single API call
const MAX_RESULTS = 25;                    // max search results shown in the list

// ============================================================
// Global Variables
// ============================================================
let globalConn = null;
const sessions = {};

global._hanime2Sessions = sessions;

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
// Helpers: Small utilities
// ============================================================
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
const isUrl = (u) => /^https?:\/\//i.test(u);
const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out')), ms))
]);

// First non-empty value among several possible field names
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function absUrl(u) {
  if (!u) return '';
  if (isUrl(u)) return u;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/')) return SITE_BASE + u;
  return u;
}

// https://site/videos/sukebe-elf-tanbouki-episode-1-id-01/ → "Sukebe Elf Tanbouki Episode 1"
function slugToTitle(url) {
  const slug = url.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() || '';
  return slug
    .replace(/-id-\d+$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim() || 'Untitled';
}

// ============================================================
// Helper: API Request
// ============================================================
async function fetchAPI(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(API_BASE + path, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const data = await res.json();
    if (data && typeof data === 'object' && (data.status === false || data.success === false)) {
      throw new Error(str(data.message) || str(data.error) || 'API returned status: false');
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data.result ?? data.results ?? data.data ?? data;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('API request timed out.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function logUnexpected(label, payload) {
  let raw = '';
  try { raw = JSON.stringify(payload); } catch (e) {}
  console.log(`[HANIME2] Unexpected ${label} response:`, (raw || String(payload)).slice(0, 600));
}

// ============================================================
// Helper: Response normalizers
// (field names are auto-detected, so small API changes won't break the plugin)
// ============================================================
const LIST_KEYS = ['results', 'result', 'data', 'items', 'list', 'series', 'videos', 'episodes'];
const EPISODE_KEYS = ['episodes', 'episode', 'eps', 'episode_list', 'episodeList', 'videos', 'list', 'chapters', 'items'];
const LINK_KEYS = ['downloads', 'download', 'links', 'qualities', 'sources', 'files', 'urls', 'result', 'data'];

function findArray(value, keys) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;
  for (const k of keys) if (Array.isArray(value[k])) return value[k];
  // one level deeper, e.g. { data: { episodes: [...] } }
  for (const v of Object.values(value)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of keys) if (Array.isArray(v[k])) return v[k];
    }
  }
  return null;
}

function normalizeItem(raw) {
  if (typeof raw === 'string') raw = { url: raw };
  if (!raw || typeof raw !== 'object') return null;

  const url = absUrl(str(pick(raw, ['url', 'link', 'href', 'page', 'episode_url'])));
  if (!url) return null;

  return {
    title: str(pick(raw, ['title', 'name', 'series_title', 'episode_title'])) || slugToTitle(url),
    url,
    image: absUrl(str(pick(raw, ['image', 'thumbnail', 'thumb', 'img', 'poster', 'cover']))) || null,
    number: str(pick(raw, ['number', 'episode', 'episode_number', 'ep', 'no']))
  };
}

function episodeNumber(ep) {
  const m = ep.number.match(/\d+(?:\.\d+)?/)
    || ep.url.match(/episode[-_ ]?(\d+)/i)
    || ep.title.match(/(?:episode|ep)[-_. ]*(\d+)/i);
  return m ? parseFloat(m[1] ?? m[0]) : null;
}

function normalizeSeries(payload, fallback) {
  const list = findArray(payload, EPISODE_KEYS);
  if (!list) return null;

  const info = Array.isArray(payload) ? {} : payload;
  const title = str(pick(info, ['title', 'name'])) || fallback.title;
  const image = absUrl(str(pick(info, ['image', 'thumbnail', 'thumb', 'img', 'poster', 'cover']))) || fallback.image;
  const meta = ['year', 'status', 'studio', 'rating', 'type'].map(k => str(info[k])).filter(Boolean).join(' • ');

  const seen = new Set();
  let episodes = [];
  for (const raw of list) {
    const ep = normalizeItem(raw);
    if (!ep || seen.has(ep.url)) continue;
    seen.add(ep.url);
    // "Episode 1" → "Series Title - Episode 1" (gives a proper file name later)
    if (!ep.title.toLowerCase().includes(title.toLowerCase())) ep.title = `${title} - ${ep.title}`;
    episodes.push(ep);
  }

  // Oldest → newest, when every episode has a detectable number
  const nums = episodes.map(episodeNumber);
  if (nums.length && nums.every(n => n !== null)) {
    episodes = episodes.map((ep, i) => ({ ep, n: nums[i] })).sort((a, b) => a.n - b.n).map(x => x.ep);
  }

  return { title, image, meta, episodes };
}

function normalizeLinks(payload) {
  let list = findArray(payload, LINK_KEYS);

  if (!list && payload && typeof payload === 'object') {
    const single = str(pick(payload, ['url', 'link', 'download', 'download_url', 'downloadUrl', 'src', 'file']));
    if (isUrl(single)) {
      list = [{ name: str(pick(payload, ['quality', 'name', 'label'])) || 'Default', url: single }];
    } else {
      // { "720p": "https://...", "1080p": "https://..." }
      list = Object.entries(payload)
        .filter(([k, v]) => typeof v === 'string' && isUrl(v) && /\d{3,4}p|hd|sd|4k|default|original/i.test(k))
        .map(([k, v]) => ({ name: k, url: v }));
    }
  }

  const seen = new Set();
  const out = [];
  (list || []).forEach((q, i) => {
    if (typeof q === 'string') q = { url: q };
    const url = str(pick(q, ['url', 'link', 'download', 'download_url', 'downloadUrl', 'src', 'file']));
    if (!isUrl(url) || seen.has(url)) return;
    seen.add(url);
    out.push({
      name: str(pick(q, ['name', 'quality', 'label', 'resolution', 'title', 'server'])) || `Link ${i + 1}`,
      url
    });
  });
  return out;
}

// ============================================================
// Helper: API calls
// ============================================================
async function searchHanime(query) {
  const payload = await fetchAPI(`/search?text=${encodeURIComponent(query)}`);
  const list = findArray(payload, LIST_KEYS);
  if (!list) {
    logUnexpected('search', payload);
    throw new Error('Unexpected search response from the API.');
  }

  const seen = new Set();
  const items = [];
  for (const raw of list) {
    const item = normalizeItem(raw);
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);
    items.push(item);
  }
  return items.slice(0, MAX_RESULTS);
}

async function getSeries(item) {
  const payload = await fetchAPI(`/series?url=${encodeURIComponent(item.url)}`);
  const series = normalizeSeries(payload, item);
  if (!series) {
    logUnexpected('series', payload);
    throw new Error('Unexpected series response from the API.');
  }
  return series;
}

async function getDownloadLinks(pageUrl) {
  const payload = await fetchAPI(`/download?url=${encodeURIComponent(pageUrl)}`);
  const links = normalizeLinks(payload);
  if (links.length === 0) logUnexpected('download', payload);
  return links;
}

// ============================================================
// Helper: Session handling
// ============================================================
function resetSessionTimeout(from) {
  const s = sessions[from];
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  s.timeout = setTimeout(() => {
    if (sessions[from] === s) {
      delete sessions[from];
      console.log(`[HANIME2] Session expired for ${from}`);
    }
  }, SESSION_TIMEOUT_MS);
}

// Removes the session (only if it is still the active one for this chat)
function endSession(from, session) {
  const s = sessions[from];
  if (!s || (session && s !== session)) return;
  if (s.timeout) clearTimeout(s.timeout);
  delete sessions[from];
}

// ============================================================
// Helper: Messages auto-delete
// ============================================================
async function cleanupMessages(conn, from, keys) {
  if (!keys || keys.length === 0) return;

  await sleep(3000);

  for (const key of keys) {
    try {
      await conn.sendMessage(from, { delete: key });
      await sleep(randomDelay(400, 800));
    } catch (e) {}
  }
}

// Ends the session first (so late messages are not collected), then wipes the menu messages
async function finishSession(conn, from, session) {
  const keys = [...session.messageKeys];
  endSession(from, session);
  await cleanupMessages(conn, from, keys);
}

async function closeSession(conn, from, session, quotedMsg) {
  try {
    const sent = await conn.sendMessage(from, { text: '❌ Menu closed.' }, { quoted: quotedMsg });
    session.messageKeys.push(sent.key);
  } catch (e) {}
  await finishSession(conn, from, session);
}

// ============================================================
// Helper: Loading Bar (fills with ░, switches to █ at 100%)
// ============================================================
async function startLoading(conn, from, quotedMsg, title, subtitle, session) {
  let loadingKey = null;
  let percent = 0;

  function getBarText(p, isDone = false) {
    const totalBlocks = 20;

    if (isDone) return '█'.repeat(totalBlocks);

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
    console.error('[HANIME2] Failed to send loading message:', e.message);
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
        media = await withTimeout(
          prepareWAMessageMedia({ image: { url: imageUrl } }, { upload: conn.waUploadToServer }),
          10000
        );
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

function buildSections(sectionTitle, labels, idPrefix, withBack) {
  const rows = labels.map((label, i) => ({ title: `${i + 1} | ${clip(label, 70)}`, description: '', id: `${idPrefix}_${i}` }));
  if (withBack) rows.push({ title: 'back | 🔙 Back', description: 'Go back one step', id: 'back' });
  rows.push({ title: '0 | ❌ Close', description: 'Close this menu', id: 'close' });
  return [{ title: sectionTitle, rows }];
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
// Screens
// ============================================================
async function showSeriesList(conn, from, session, quotedMsg) {
  const { results, query } = session;

  let body = `🔍 Search: ${query}\n\n`;
  results.forEach((item, i) => { body += `${i + 1} | ${item.title}\n`; });
  body += `0 | ❌ Close\n\nSend the series number.`;

  await sendInteractiveList(
    conn, from, quotedMsg, session,
    'Search Results', body, 'Send a number or select from the list',
    buildSections('Search Results', results.map(r => r.title), 's', false),
    results[0]?.image || null
  );
}

async function showEpisodeList(conn, from, session, quotedMsg) {
  const { series } = session;

  let body = `🎞️ ${series.title}\n`;
  if (series.meta) body += `${series.meta}\n`;
  body += `📺 Episodes: ${series.episodes.length}\n\n`;
  series.episodes.forEach((ep, i) => { body += `${i + 1} | ${ep.title}\n`; });
  body += `back | 🔙 Back\n0 | ❌ Close\n\nSend the episode number.`;

  await sendInteractiveList(
    conn, from, quotedMsg, session,
    'Select Episode', body, 'Send a number or select from the list',
    buildSections('Episodes', series.episodes.map(e => e.title), 'e', true),
    session.cover || null
  );
}

async function showQualityList(conn, from, session, quotedMsg) {
  const { qualities, selectedEpisode } = session;

  let body = `🎬 ${selectedEpisode.title}\n\n📥 Available Qualities\n\n`;
  qualities.forEach((q, i) => { body += `${i + 1} | ${q.name}\n`; });
  body += `back | 🔙 Back\n0 | ❌ Close\n\nSend the quality number.`;

  await sendInteractiveList(
    conn, from, quotedMsg, session,
    'Select Quality', body, 'Send a number or select from the list',
    buildSections('Available Qualities', qualities.map(q => q.name), 'q', true),
    selectedEpisode.image || session.cover || null
  );
}

async function showDestination(conn, from, session, quotedMsg) {
  const bodyText = `🎬 ${session.selectedEpisode.title}\n📥 Quality: ${session.selectedQuality.name}\n\n📤 Where should I send the file?`;

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
// Step handlers
// ============================================================

// Series → Episodes
async function handleSeriesSelection(conn, from, session, item, quotedMsg) {
  resetSessionTimeout(from);
  await simulateTyping(conn, from, randomDelay(1500, 3000));

  // The search result already points to an episode page → go straight to the download step
  if (/\/videos?\//i.test(item.url)) {
    session.direct = true;
    session.cover = item.image;
    await handleEpisodeSelection(conn, from, session, item, quotedMsg);
    return;
  }

  const series = await getSeries(item);
  if (series.episodes.length === 0) {
    const sent = await conn.sendMessage(from, { text: '❌ No episodes found for this series.' }, { quoted: quotedMsg });
    session.messageKeys.push(sent.key);
    return;
  }

  session.direct = false;
  session.series = series;
  session.cover = series.image || item.image;
  session.step = 'select_episode';
  await showEpisodeList(conn, from, session, quotedMsg);
}

// Episode → Qualities
async function handleEpisodeSelection(conn, from, session, episode, quotedMsg) {
  resetSessionTimeout(from);
  await simulateTyping(conn, from, randomDelay(1500, 3000));

  const qualities = await getDownloadLinks(episode.url);
  if (qualities.length === 0) {
    const sent = await conn.sendMessage(from, { text: '❌ No download links found.' }, { quoted: quotedMsg });
    session.messageKeys.push(sent.key);
    return; // stay on the current step so another item can be picked
  }

  session.selectedEpisode = episode;
  session.qualities = qualities;
  session.step = 'select_quality';

  // Only one link → nothing to choose, go to the destination step
  if (qualities.length === 1) {
    await handleQualitySelection(conn, from, session, 0, quotedMsg);
    return;
  }

  await showQualityList(conn, from, session, quotedMsg);
}

// Quality → Destination buttons
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
  await showDestination(conn, from, session, quotedMsg);
}

// Back one step
async function goBack(conn, from, session, quotedMsg) {
  resetSessionTimeout(from);
  await simulateTyping(conn, from, randomDelay(500, 1000));

  switch (session.step) {
    case 'enter_jids':
    case 'enter_tag':
      session.step = 'select_destination';
      return showDestination(conn, from, session, quotedMsg);

    case 'select_destination':
      if (session.qualities.length > 1) {
        session.step = 'select_quality';
        return showQualityList(conn, from, session, quotedMsg);
      }
      // a single quality was auto-selected → fall through to the episode level

    case 'select_quality':
      if (!session.direct) {
        session.step = 'select_episode';
        return showEpisodeList(conn, from, session, quotedMsg);
      }
      // came straight from the search results → fall through to the series level

    case 'select_episode':
      session.step = 'select_series';
      return showSeriesList(conn, from, session, quotedMsg);

    default:
      return; // select_series: nothing to go back to
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

  // ============================================================
  // Download + upload ONLY ONCE (no matter how many JIDs)
  // ============================================================
  let mediaBytes;
  try {
    const media = await prepareWAMessageMedia(
      { document: { url: selectedQuality.url }, mimetype: 'video/mp4', fileName: fileName },
      { upload: conn.waUploadToServer }
    );
    mediaBytes = proto.Message.encode(media).finish();
  } catch (e) {
    console.error('[HANIME2] Download/Upload failed:', e.message);
    loading.stop();
    try {
      const sent = await conn.sendMessage(from, { text: `❌ Download failed: ${e.message}` }, { quoted: quotedMsg });
      session.messageKeys.push(sent.key);
    } catch (_) {}
    await finishSession(conn, from, session);
    return;
  }

  let success = 0, failed = 0;
  const failedJids = [];

  for (const jid of targetJids) {
    try {
      if (success > 0 || failed > 0) {
        await simulateTyping(conn, from, randomDelay(5000, 10000));
      }

      // Re-use the already uploaded file (no new download / upload)
      const content = proto.Message.decode(mediaBytes);
      const waMsg = generateWAMessageFromContent(jid, content, { userJid: conn.user?.id });
      await conn.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id });
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
  await finishSession(conn, from, session);
}

// ============================================================
// Helper: JID parsing (group JIDs / numbers / "inbox")
// ============================================================
function toJid(token, senderJid) {
  const t = token.trim();
  const lower = t.toLowerCase();
  if (lower === 'inbox' || lower === 'me') return senderJid;
  if (t.includes('@')) return t;
  if (/^\d+-\d+$/.test(t)) return t + '@g.us';                              // old group format
  if (/^\d{16,}$/.test(t)) return t + '@g.us';                              // group id
  if (/^\d{7,15}$/.test(t)) return t + '@s.whatsapp.net';                   // phone number
  return null;
}

// ============================================================
// Helper: Read the selected id from any kind of interactive reply
// ============================================================
function extractSelectedId(inner) {
  let id = inner.listResponseMessage?.singleSelectReply?.selectedRowId ||
           inner.templateButtonReplyMessage?.selectedId ||
           inner.buttonsResponseMessage?.selectedButtonId || null;

  if (!id) {
    const flow = inner.interactiveResponseMessage?.nativeFlowResponseMessage;
    const paramsJson = flow?.paramsJson || flow?.params_json;
    if (paramsJson) {
      try {
        const p = typeof paramsJson === 'string' ? JSON.parse(paramsJson) : paramsJson;
        id = p.id || p.selectedId || p.selected_id || null;
      } catch (e) {}
    }
  }
  return id;
}

// Runs one step with a "busy" lock (blocks double taps) and reports errors to the chat
async function runExclusive(conn, from, session, quotedMsg, fn) {
  session.busy = true;
  try {
    await fn();
  } catch (e) {
    console.error('[HANIME2] Step error:', e);
    try {
      const sent = await conn.sendMessage(from, { text: `⚠️ Error: ${e.message}\nTry again, or send 0 to close.` }, { quoted: quotedMsg });
      session.messageKeys.push(sent.key);
    } catch (_) {}
  } finally {
    session.busy = false;
  }
}

// ============================================================
// Main Command
// ============================================================
cmd({
  pattern: 'hanime2',
  desc: 'Search and download Hanime videos (WatchHentai)',
  category: 'main',
  filename: __filename
}, async (conn, mek, m, { from, reply, q, text }) => {
  globalConn = conn;
  ensureListener(conn);

  let session = null;

  try {
    const query = (q || text || '').trim();
    if (!query) return reply('Please provide a name.\nExample: .hanime2 elf');

    // Close an older session of this plugin (and of the old .hanime plugin) in this chat
    endSession(from);
    const legacy = global._hanimeSessions && global._hanimeSessions[from];
    if (legacy) {
      if (legacy.timeout) clearTimeout(legacy.timeout);
      delete global._hanimeSessions[from];
    }

    session = { step: 'search', query, messageKeys: [mek.key], busy: false };
    sessions[from] = session;
    resetSessionTimeout(from);

    await simulateTyping(conn, from, randomDelay(2000, 4000));

    const results = await searchHanime(query);
    if (sessions[from] !== session) return; // a newer command replaced this session

    if (results.length === 0) {
      endSession(from, session);
      return reply('❌ No results found.');
    }

    session.results = results;
    session.step = 'select_series';
    resetSessionTimeout(from);

    await simulateTyping(conn, from, randomDelay(1500, 3000));
    await showSeriesList(conn, from, session, mek);
  } catch (e) {
    reply('⚠️ Error: ' + e.message);
    if (session) endSession(from, session);
  }
});

// ============================================================
// Listener
// ============================================================
async function onMessage(m) {
  try {
    const msg = m.messages?.[0];
    if (!msg || !msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const session = sessions[from];
    if (!session) return;

    // A newer .hanime session was started in this chat → let that plugin handle the replies
    if (global._hanimeSessions && global._hanimeSessions[from]) {
      endSession(from, session);
      return;
    }

    const conn = globalConn;
    session.messageKeys.push(msg.key);

    const inner =
      msg.message?.viewOnceMessage?.message || msg.message?.viewOnceMessageV2?.message ||
      msg.message?.ephemeralMessage?.message || msg.message;

    const textMsg = (inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || '').trim();
    const textLower = textMsg.toLowerCase();
    const listId = extractSelectedId(inner);

    // ============================================================
    // Close
    // ============================================================
    if (listId === 'close' || textLower === 'cancel' || textMsg === '0') {
      await closeSession(conn, from, session, msg);
      return;
    }

    if (session.busy) return;

    // ============================================================
    // Back
    // ============================================================
    if (listId === 'back' || textLower === 'back') {
      await runExclusive(conn, from, session, msg, () => goBack(conn, from, session, msg));
      return;
    }

    // ============================================================
    // Step: select_destination
    // ============================================================
    if (session.step === 'select_destination') {
      let choice = null;

      if (listId === 'dest_inbox' || textLower.includes('inbox') || textMsg === '1') choice = 1;
      else if (listId === 'dest_group' || textLower.includes('group') || textMsg === '2') choice = 2;
      else if (textMsg === '3') {
        await closeSession(conn, from, session, msg);
        return;
      }

      if (choice === 1) {
        const senderJid = msg.key.participant || msg.key.remoteJid;
        session.targetJids = [senderJid];
        session.step = 'enter_tag';
        resetSessionTimeout(from);

        await simulateTyping(conn, from, randomDelay(1000, 2000));
        const sent = await conn.sendMessage(from, { text: `✅ Target: Inbox\n\n📝 Send a custom tag for the filename (goes inside [ ]):\nExample: SL_HL\n(Send - to use the default tag)` }, { quoted: msg });
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

      if (/^\d+$/.test(textMsg)) {
        const errMsg = await conn.sendMessage(from, { text: '❌ Please choose using the buttons (or reply 1 / 2 / 0).' }, { quoted: msg });
        session.messageKeys.push(errMsg.key);
      }
      return;
    }

    // ============================================================
    // Step: enter_jids
    // ============================================================
    if (session.step === 'enter_jids') {
      if (!textMsg) return;

      const senderJid = msg.key.participant || msg.key.remoteJid;
      const tokens = textMsg.split(/[\n,;\s]+/).map(s => s.trim()).filter(Boolean);

      const jids = [];
      const invalid = [];
      for (const token of tokens) {
        const jid = toJid(token, senderJid);
        if (!jid) invalid.push(token);
        else if (!jids.includes(jid)) jids.push(jid);
      }

      if (jids.length === 0) {
        const errMsg = await conn.sendMessage(from, { text: '❌ No valid JID found. Please send it again (example: 1203631@g.us).' }, { quoted: msg });
        session.messageKeys.push(errMsg.key);
        return;
      }

      session.targetJids = jids;
      session.step = 'enter_tag';
      resetSessionTimeout(from);

      await simulateTyping(conn, from, randomDelay(1500, 3000));
      const jidList = jids.map((j, i) => `${i + 1}. ${j}`).join('\n');
      const ignored = invalid.length ? `\n⚠️ Ignored: ${invalid.join(', ')}` : '';
      const sent = await conn.sendMessage(from, { text: `✅ ${jids.length} target(s) set:\n${jidList}${ignored}\n\n📝 Send a custom tag for the filename (goes inside [ ]):\nExample: SL_HL\n(Send - to use the default tag)` }, { quoted: msg });
      session.messageKeys.push(sent.key);
      return;
    }

    // ============================================================
    // Step: enter_tag → Send Video
    // ============================================================
    if (session.step === 'enter_tag') {
      if (!textMsg) return;

      session.customTag = (textMsg === '-' || textLower === 'skip' || textLower === 'default') ? 'HANIME' : textMsg;
      resetSessionTimeout(from);

      await runExclusive(conn, from, session, msg, () => sendVideoToTargets(conn, from, session, msg));
      return;
    }

    // ============================================================
    // Step: select_series / select_episode / select_quality
    // ============================================================
    const STEPS = {
      select_series:  { prefix: 's', size: () => session.results.length },
      select_episode: { prefix: 'e', size: () => session.series.episodes.length },
      select_quality: { prefix: 'q', size: () => session.qualities.length }
    };
    const stepInfo = STEPS[session.step];
    if (!stepInfo) return;

    let index = null;
    if (listId) {
      const [prefix, idx] = listId.split('_');
      if (prefix === stepInfo.prefix && !isNaN(parseInt(idx))) index = parseInt(idx);
    } else {
      const match = textMsg.match(/^(\d+)\s*(?:[|.)]|$)/);
      if (match) {
        const num = parseInt(match[1]);
        if (num < 1 || num > stepInfo.size()) {
          const errMsg = await conn.sendMessage(from, { text: `❌ Invalid number. Choose between 1 and ${stepInfo.size()} (or 0 to close).` }, { quoted: msg });
          session.messageKeys.push(errMsg.key);
          return;
        }
        index = num - 1;
      }
    }

    if (index === null || index < 0 || index >= stepInfo.size()) return;

    if (session.step === 'select_series') {
      const item = session.results[index];
      await runExclusive(conn, from, session, msg, () => handleSeriesSelection(conn, from, session, item, msg));
    } else if (session.step === 'select_episode') {
      const episode = session.series.episodes[index];
      await runExclusive(conn, from, session, msg, () => handleEpisodeSelection(conn, from, session, episode, msg));
    } else if (session.step === 'select_quality') {
      await runExclusive(conn, from, session, msg, () => handleQualitySelection(conn, from, session, index, msg));
    }
  } catch (err) {
    console.error('[HANIME2] Listener error:', err);
  }
}

// Attaches the listener to the current connection (re-attaches after a reconnect / plugin reload)
function ensureListener(conn) {
  const prev = global._hanime2Listener;
  if (prev && prev.conn === conn && prev.handler === onMessage) return;

  if (prev) {
    try { prev.conn.ev.off('messages.upsert', prev.handler); } catch (e) {}
  }

  conn.ev.on('messages.upsert', onMessage);
  global._hanime2Listener = { conn, handler: onMessage };
  console.log('[HANIME2] Anti-ban Listener attached successfully.');
}
