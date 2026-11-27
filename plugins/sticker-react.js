'use strict';

/**
 * ╔══════════════════════════════════════════════════╗
 *   Feature   : Sticker / Emoji Auto-Reaction  (.r)
 *   Method    : Sticker reaction by @DanuZz | MovaNest Tm
 *   Library   : @dnuzi/baileys
 * ╚══════════════════════════════════════════════════╝
 *
 *   .r                            (reply to a sticker or an emoji) → save it as the reaction
 *   .r 😂                         → save an emoji as the reaction
 *   .r <jid|lid|number> ... on    → react to EVERY message these users send
 *   .r <jid|lid|number> ... off   → stop reacting to these users
 *   .r all off                    → stop reacting to everyone
 *   .r list                       → show the saved reaction and the active users
 *
 *   Instead of typing an ID you can also reply to a user's message
 *   (or @mention the user) and send  .r on  /  .r off
 *
 *   Put this file in your bot's "plugins" folder.
 */

const fs = require('fs');
const path = require('path');
const { cmd } = require('../command'); // ← change this path if your bot keeps `cmd` somewhere else

/* ═══════════════════════════ CONFIG ═══════════════════════════ */
const OWNER_ONLY = true;                                              // only the bot owner can use .r
const DATA_FILE = path.join(__dirname, '..', 'r_react_data.json');    // saved reaction + users
const REACT_GAP_MS = 800;                                             // pause between two reactions (anti-spam)
const MAX_QUEUE = 40;                                                 // drop extra reactions when the queue is full
const MAX_MESSAGE_AGE_SEC = 120;                                      // ignore old messages (offline backlog)
const STICKER_REUPLOAD_MS = 6 * 60 * 60 * 1000;                       // refresh the sticker upload every 6 hours
const BAILEYS_PACKAGES = ['@dnuzi/baileys', '@whiskeysockets/baileys', 'baileys'];
const LOG = '[.r]';

/* ═══════════════════════════ STORAGE ═══════════════════════════ */
let db = null; // { reaction: null | {...}, targets: string[] }

function loadDb() {
  if (db) return db;
  db = { reaction: null, targets: [] };
  try {
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db.reaction = saved.reaction || null;
      db.targets = Array.isArray(saved.targets) ? saved.targets.filter(Boolean) : [];
    }
  } catch (e) {
    console.error(`${LOG} Could not read the data file:`, e.message);
  }
  return db;
}

function saveDb() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error(`${LOG} Could not save the data file:`, e.message);
  }
}

/* ═══════════════════════════ HELPERS ═══════════════════════════ */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uniq = (arr) => [...new Set(arr)];

let baileysLib = null;
async function loadBaileys() {
  if (baileysLib) return baileysLib;
  for (const name of BAILEYS_PACKAGES) {
    try { baileysLib = require(name); return baileysLib; } catch (_) { /* try next way */ }
    try { baileysLib = await import(name); return baileysLib; } catch (_) { /* try next package */ }
  }
  throw new Error('Baileys package not found');
}

/** "94771234567:12@s.whatsapp.net" → "94771234567@s.whatsapp.net" */
function normalizeJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  const at = jid.lastIndexOf('@');
  if (at < 1) return '';
  const user = jid.slice(0, at).split(':')[0].split('_')[0];
  let server = jid.slice(at + 1).toLowerCase();
  if (server === 'c.us') server = 's.whatsapp.net';
  return user && server ? `${user}@${server}` : '';
}

const isUserJid = (jid) => /@(s\.whatsapp\.net|lid)$/.test(jid);

/** Turns what the owner typed (number / jid / lid) into a clean JID, or null when invalid. */
function parseJidToken(token) {
  const t = String(token || '').trim().replace(/^@/, '').replace(/^\+/, '');
  if (!t) return null;
  if (t.includes('@')) {
    const jid = normalizeJid(t);
    return jid && isUserJid(jid) ? jid : null;
  }
  const digits = t.replace(/[\s\-()]/g, '');
  return /^\d{6,15}$/.test(digits) ? `${digits}@s.whatsapp.net` : null;
}

/** Phone-number JID <-> LID lookup through Baileys' LID mapping store (if this build has one). */
const altCache = new Map();
async function lookupAlt(conn, jid, want /* 'pn' | 'lid' */) {
  const cacheKey = `${want}:${jid}`;
  const hit = altCache.get(cacheKey);
  if (hit && Date.now() - hit.at < (hit.value ? 3600e3 : 120e3)) return hit.value;

  let value = null;
  try {
    const store = conn.signalRepository && conn.signalRepository.lidMapping;
    if (store) {
      const res = want === 'pn' ? await store.getPNForLID(jid) : await store.getLIDForPN(jid);
      value = normalizeJid(res) || null;
    }
  } catch (_) { /* mapping not available – ignore */ }

  if (altCache.size > 2000) altCache.clear();
  altCache.set(cacheKey, { value, at: Date.now() });
  return value;
}

/* ── message helpers ── */
function unwrapMessage(message) {
  let msg = message;
  for (let i = 0; i < 6 && msg; i++) {
    const inner =
      (msg.ephemeralMessage && msg.ephemeralMessage.message) ||
      (msg.viewOnceMessage && msg.viewOnceMessage.message) ||
      (msg.viewOnceMessageV2 && msg.viewOnceMessageV2.message) ||
      (msg.viewOnceMessageV2Extension && msg.viewOnceMessageV2Extension.message) ||
      (msg.documentWithCaptionMessage && msg.documentWithCaptionMessage.message) ||
      (msg.editedMessage && msg.editedMessage.message);
    if (!inner) break;
    msg = inner;
  }
  return msg || null;
}

function contentTypeOf(message) {
  if (!message) return null;
  return (
    Object.keys(message).find(
      (k) => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage' && message[k] != null
    ) || null
  );
}

function getContextInfo(message) {
  const msg = unwrapMessage(message);
  if (!msg) return null;
  for (const key of Object.keys(msg)) {
    const ci = msg[key] && msg[key].contextInfo;
    if (ci) return ci;
  }
  return null;
}

function getText(message) {
  const msg = unwrapMessage(message) || {};
  return (
    msg.conversation ||
    (msg.extendedTextMessage && msg.extendedTextMessage.text) ||
    (msg.imageMessage && msg.imageMessage.caption) ||
    (msg.videoMessage && msg.videoMessage.caption) ||
    ''
  );
}

function tsSeconds(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts.toNumber === 'function') return ts.toNumber();
  return Number(ts) || 0;
}

/** A sticker that somebody sent as a "sticker reaction" (type 11) – we never react to those. */
function isStickerReaction(message) {
  const assoc = message && message.messageContextInfo && message.messageContextInfo.messageAssociation
    ? message.messageContextInfo.messageAssociation.associationType
    : null;
  return assoc === 11 || assoc === 'STICKER_ANNOTATION';
}

/* ── emoji detection (flags, keycaps, skin tones, ZWJ families…) ── */
const EMOJI_RE =
  /\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*/gu;

/** Returns the first emoji when the text contains ONLY emoji, otherwise null. */
function extractEmoji(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const found = t.match(EMOJI_RE);
  if (!found) return null;
  const rest = t.replace(EMOJI_RE, '').replace(/\s+/g, '');
  return rest === '' ? found[0] : null;
}

/* ── sticker helpers ── */
const toB64 = (v) => (v == null ? undefined : typeof v === 'string' ? v : Buffer.from(v).toString('base64'));
const toNum = (v) => (v == null ? undefined : typeof v === 'number' ? v : typeof v.toNumber === 'function' ? v.toNumber() : Number(v));

/** Keeps the original sticker fields (base64) – same payload style as the DanuZz example. */
function serializeSticker(st) {
  return {
    url: st.url,
    directPath: st.directPath,
    mediaKey: toB64(st.mediaKey),
    fileSha256: toB64(st.fileSha256),
    fileEncSha256: toB64(st.fileEncSha256),
    fileLength: toNum(st.fileLength),
    mimetype: st.mimetype || 'image/webp',
    isAnimated: Boolean(st.isAnimated),
    isLottie: Boolean(st.isLottie),
    width: st.width,
    height: st.height,
  };
}

async function downloadSticker(st) {
  const { downloadContentFromMessage } = await loadBaileys();
  const stream = await downloadContentFromMessage(st, 'sticker');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Returns the stickerMessage to send. The saved sticker is uploaded again (fresh media key / URL),
 * so it keeps working even after the original WhatsApp media link has expired.
 * If the upload fails, the original sticker fields are used instead.
 */
const stickerCache = new WeakMap(); // conn → { savedAt, content, expires }
async function getStickerContent(conn) {
  const r = db.reaction;
  const cached = stickerCache.get(conn);
  if (cached && cached.savedAt === r.savedAt && cached.expires > Date.now()) return cached.content;

  let content = null;
  if (r.data) {
    try {
      const { prepareWAMessageMedia } = await loadBaileys();
      const media = await prepareWAMessageMedia(
        {
          sticker: Buffer.from(r.data, 'base64'),
          mimetype: r.raw && r.raw.mimetype,
          isAnimated: r.raw && r.raw.isAnimated,
          isLottie: r.raw && r.raw.isLottie,
        },
        { upload: conn.waUploadToServer }
      );
      content = media.stickerMessage;
    } catch (e) {
      console.error(`${LOG} Sticker upload failed, using the original sticker data:`, e.message || e);
    }
  }

  const uploaded = Boolean(content);
  content = content || r.raw;
  stickerCache.set(conn, {
    savedAt: r.savedAt,
    content,
    expires: Date.now() + (uploaded ? STICKER_REUPLOAD_MS : 5 * 60 * 1000),
  });
  return content;
}

/* ═══════════════════════════ REACTING ═══════════════════════════ */
/** React to ONE message with the saved emoji / sticker. */
async function reactTo(conn, msg) {
  const r = db.reaction;
  if (!r) return;
  const jid = msg.key.remoteJid;

  if (r.type === 'emoji') {
    await conn.sendMessage(jid, { react: { text: r.emoji, key: msg.key } });
    return;
  }

  const sticker = await getStickerContent(conn);
  if (!sticker) throw new Error('No sticker data available');

  // Sticker reaction (DanuZz method): the sticker is linked to the original message (type 11)
  await conn.relayMessage(
    jid,
    {
      messageContextInfo: {
        messageAssociation: {
          associationType: 11,
          parentMessageKey: msg.key, // key of the message being reacted to
        },
      },
      stickerMessage: { ...sticker },
    },
    {}
  );
}

/** Reactions are sent one by one with a small pause, so busy chats do not flood WhatsApp. */
let chain = Promise.resolve();
let pending = 0;
function enqueue(task) {
  if (pending >= MAX_QUEUE) return;
  pending++;
  chain = chain
    .then(task)
    .catch((e) => console.error(`${LOG} Reaction failed:`, (e && e.message) || e))
    .then(() => sleep(REACT_GAP_MS))
    .finally(() => { pending--; });
}

const seenIds = new Set();
function alreadySeen(id) {
  if (seenIds.has(id)) return true;
  seenIds.add(id);
  if (seenIds.size > 500) seenIds.delete(seenIds.values().next().value);
  return false;
}

/* ═══════════════════════ INCOMING MESSAGES ═══════════════════════ */
const SKIP_TYPES = new Set([
  'protocolMessage', 'reactionMessage', 'encReactionMessage', 'pollUpdateMessage',
  'keepInChatMessage', 'pinInChatMessage', 'editedMessage', 'albumMessage',
  'callLogMesssage', 'encEventResponseMessage', 'secretEncryptedMessage',
]);

/** Is the sender of this message one of the active users? (checks both JID and LID forms) */
async function isTargetSender(conn, msg) {
  const key = msg.key;
  const inGroup = (key.remoteJid || '').endsWith('@g.us');
  const raw = inGroup
    ? [key.participant, key.participantAlt, key.participantPn, key.participantLid, msg.participant]
    : [key.remoteJid, key.remoteJidAlt, key.senderPn, key.senderLid];
  const ids = uniq(raw.map(normalizeJid).filter(Boolean));

  const targets = new Set(db.targets);
  if (ids.some((j) => targets.has(j))) return true;

  // Fallback: LID <-> phone number mapping (only when the list holds the other kind of ID)
  const hasPn = db.targets.some((j) => j.endsWith('@s.whatsapp.net'));
  const hasLid = db.targets.some((j) => j.endsWith('@lid'));
  for (const id of ids) {
    let alt = null;
    if (id.endsWith('@lid') && hasPn) alt = await lookupAlt(conn, id, 'pn');
    else if (id.endsWith('@s.whatsapp.net') && hasLid) alt = await lookupAlt(conn, id, 'lid');
    if (alt && targets.has(alt)) return true;
  }
  return false;
}

async function onIncoming(conn, msg) {
  const data = loadDb();
  if (!data.reaction || data.targets.length === 0) return;

  const key = msg && msg.key;
  if (!key || key.fromMe || !msg.message) return;

  const chat = key.remoteJid || '';
  if (!/@(g\.us|s\.whatsapp\.net|lid)$/.test(chat)) return; // ignore status, newsletters, broadcasts

  const inner = unwrapMessage(msg.message);
  const type = contentTypeOf(inner);
  if (!type || SKIP_TYPES.has(type)) return;
  if (isStickerReaction(msg.message) || isStickerReaction(inner)) return;

  const ts = tsSeconds(msg.messageTimestamp);
  if (ts && Date.now() / 1000 - ts > MAX_MESSAGE_AGE_SEC) return;

  if (!(await isTargetSender(conn, msg))) return;
  if (alreadySeen(`${chat}:${key.id}`)) return;

  enqueue(() => reactTo(conn, msg));
}

/** Attaches the "messages.upsert" listener once per socket (a new socket after reconnect gets its own). */
const attached = new WeakSet();
function ensureListener(conn) {
  if (!conn || !conn.ev || attached.has(conn)) return;
  attached.add(conn);
  conn.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages || []) {
      try {
        await onIncoming(conn, msg);
      } catch (e) {
        console.error(`${LOG} Listener error:`, (e && e.message) || e);
      }
    }
  });
  console.log(`${LOG} Auto-reaction listener attached.`);
}

/* ═══════════════════════════ COMMAND ═══════════════════════════ */
const usage = () =>
  [
    '🎭 *Auto Reaction – .r*',
    '',
    '1) Set the reaction:',
    '   • Reply to a sticker or an emoji with *.r*',
    '   • or send *.r 😂*',
    '2) Turn it on for users (many at once):',
    '   *.r <jid|lid|number> <jid|lid|number> on*',
    '3) Turn it off:',
    '   *.r <jid|lid|number> ... off*  or  *.r all off*',
    '4) Show status: *.r list*',
    '',
    'ℹ️ Numbers need the country code, e.g. 94771234567. LIDs must end with @lid.',
    '💡 You can also reply to a user\'s message (or @mention the user) and send *.r on* / *.r off*.',
  ].join('\n');

function buildList(data) {
  const r = data.reaction;
  const what = !r
    ? 'not set'
    : r.type === 'emoji'
      ? `${r.emoji} (emoji)`
      : `sticker${r.raw && r.raw.isLottie ? ' (lottie)' : r.raw && r.raw.isAnimated ? ' (animated)' : ''}`;
  const lines = ['🎭 *Auto Reaction*', '', `• Reaction : ${what}`, `• Active users : ${data.targets.length}`];
  if (data.targets.length) lines.push('', ...data.targets.map((j, i) => `${i + 1}. ${j}`));
  return lines.join('\n');
}

/** Shows the saved reaction on the command message so the owner sees it working. */
async function preview(conn, mek) {
  try {
    await reactTo(conn, mek);
  } catch (e) {
    console.error(`${LOG} Preview reaction failed:`, (e && e.message) || e);
  }
}

async function saveEmoji(conn, mek, say, data, emoji) {
  data.reaction = { type: 'emoji', emoji, savedAt: Date.now() };
  saveDb();
  await preview(conn, mek);
  return say(`✅ Emoji ${emoji} saved as the auto-reaction.\n\nNow use: *.r <jid|lid|number> on*`);
}

async function saveFromQuoted(conn, mek, say, data, quoted) {
  if (quoted.stickerMessage) {
    const st = quoted.stickerMessage;
    let buffer = null;
    try {
      buffer = await downloadSticker(st);
    } catch (e) {
      console.error(`${LOG} Could not download the sticker:`, (e && e.message) || e);
    }
    data.reaction = {
      type: 'sticker',
      savedAt: Date.now(),
      raw: serializeSticker(st),
      data: buffer && buffer.length ? buffer.toString('base64') : null,
    };
    saveDb();
    await preview(conn, mek);
    return say(
      '✅ Sticker saved as the auto-reaction.' +
        (data.reaction.data ? '' : '\n⚠️ Could not keep a local copy – the original sticker link will be used (it may expire later).') +
        '\n\nNow use: *.r <jid|lid|number> on*'
    );
  }

  const emoji = extractEmoji(getText(quoted));
  if (emoji) return saveEmoji(conn, mek, say, data, emoji);

  return say('❌ Please reply to a *sticker* or to a message that contains *only an emoji*.');
}

async function handleToggle(say, data, info, targetText, action) {
  const mentioned = ((info && info.mentionedJid) || []).map(normalizeJid).filter(Boolean);
  const tokens = targetText.split(/[\s,;]+/).filter(Boolean);
  const found = [];
  const invalid = [];
  let all = false;

  for (const tok of tokens) {
    if (tok.toLowerCase() === 'all' && action === 'off') { all = true; continue; }
    const digits = tok.replace(/^@/, '');
    const mentionHit = mentioned.find((j) => j.split('@')[0] === digits); // exact JID/LID of an @mention
    const jid = mentionHit || parseJidToken(tok);
    if (jid) found.push(jid); else invalid.push(tok);
  }

  // No ID typed → use the owner of the message that was replied to
  if (!tokens.length && info && info.participant) {
    const replied = normalizeJid(info.participant);
    if (replied && isUserJid(replied)) found.push(replied);
  }

  if (all) {
    const count = data.targets.length;
    data.targets = [];
    saveDb();
    return say(`✅ Auto-react turned OFF for everyone (${count} user${count === 1 ? '' : 's'} removed).`);
  }

  const ids = uniq(found);
  if (!ids.length) {
    const why = invalid.length
      ? `❌ Invalid JID / LID / number: ${invalid.join(', ')}`
      : '❌ Give at least one JID / LID / number, or reply to a user\'s message.';
    return say(`${why}\n\n${usage()}`);
  }

  const lines = [];

  if (action === 'on') {
    const added = ids.filter((j) => !data.targets.includes(j));
    const already = ids.filter((j) => data.targets.includes(j));
    data.targets.push(...added);
    saveDb();
    if (added.length) lines.push(`✅ Auto-react ON for ${added.length} user${added.length === 1 ? '' : 's'}:`, ...added.map((j) => `• ${j}`));
    if (already.length) lines.push('ℹ️ Already enabled:', ...already.map((j) => `• ${j}`));
    if (!data.reaction) lines.push('⚠️ No reaction is saved yet. Reply to a sticker or an emoji with *.r* first.');
  } else {
    const removed = ids.filter((j) => data.targets.includes(j));
    const missing = ids.filter((j) => !data.targets.includes(j));
    data.targets = data.targets.filter((j) => !removed.includes(j));
    saveDb();
    if (removed.length) lines.push(`✅ Auto-react OFF for ${removed.length} user${removed.length === 1 ? '' : 's'}:`, ...removed.map((j) => `• ${j}`));
    if (missing.length) lines.push('ℹ️ Not in the active list:', ...missing.map((j) => `• ${j}`));
  }

  if (invalid.length) lines.push(`⚠️ Ignored invalid input: ${invalid.join(', ')}`);
  return say(lines.join('\n'));
}

async function handleCommand(conn, mek, ctx) {
  ensureListener(conn);

  const chat = mek.key.remoteJid;
  const say = (text) => conn.sendMessage(chat, { text }, { quoted: mek });

  try {
    if (OWNER_ONLY && !(ctx.isOwner || ctx.isCreator || ctx.isMe || mek.key.fromMe)) {
      return await say('❌ This command can only be used by the bot owner.');
    }

    const data = loadDb();
    const input = String(ctx.q ?? (Array.isArray(ctx.args) ? ctx.args.join(' ') : '')).trim();
    const info = getContextInfo(mek.message);
    const quoted = info && info.quotedMessage ? unwrapMessage(info.quotedMessage) : null;

    // .r list
    if (/^list$/i.test(input)) return await say(buildList(data));

    // .r <ids> on | off
    const toggle = input.match(/^([\s\S]*?)\s*(on|off)$/i);
    if (toggle) return await handleToggle(say, data, info, toggle[1], toggle[2].toLowerCase());

    // .r  (replying to a sticker / an emoji)
    if (input === '') {
      if (!quoted) return await say(usage());
      return await saveFromQuoted(conn, mek, say, data, quoted);
    }

    // .r 😂
    const emoji = extractEmoji(input);
    if (emoji) return await saveEmoji(conn, mek, say, data, emoji);

    return await say(usage());
  } catch (e) {
    console.error(`${LOG} Command error:`, e);
    try { await say(`❌ Something went wrong: ${(e && e.message) || e}`); } catch (_) { /* ignore */ }
  }
}

/* ═══════════════════════════ REGISTER ═══════════════════════════ */
cmd(
  {
    pattern: 'r',
    desc: 'Auto sticker / emoji reaction for chosen users',
    category: 'owner',
    filename: __filename,
  },
  async (conn, mek, m, ctx) => handleCommand(conn, mek, ctx || {})
);

// Runs on normal messages – only makes sure the listener is attached after a (re)start / reconnect.
cmd(
  { on: 'body', dontAddCommandList: true, filename: __filename },
  async (conn) => { ensureListener(conn); }
);
