'use strict';

/**
 * ╔══════════════════════════════════════════════════╗
 *   Feature   : Sticker / Emoji Auto-Reaction  (.r)
 *   Method    : Sticker reaction by @DanuZz | MovaNest Tm
 *   Library   : @dnuzi/baileys
 * ╚══════════════════════════════════════════════════╝
 *
 *   Every user (or group of users) can get a DIFFERENT sticker / emoji.
 *
 *   (reply to a sticker / an emoji)  .r <jid|lid|number> ... on
 *         → every message these users send gets THAT sticker / emoji as a reaction
 *   .r <jid|lid|number> ... 😂 on    → same, but the emoji is typed inside the command
 *   .r <jid|lid|number> ... off      → stop reacting to these users
 *   .r all off                       → stop reacting to everyone
 *   .r list                          → show who gets which reaction
 *
 *   Reply to another sticker and run .r again to give other users a different reaction,
 *   or to CHANGE the reaction of users that are already on the list.
 *   You can also @mention users instead of typing their IDs.
 *
 *   Put this file in your bot's "plugins" folder.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cmd } = require('../command'); // ← change this path if your bot keeps `cmd` somewhere else

/* ═══════════════════════════ CONFIG ═══════════════════════════ */
const OWNER_ONLY = true;                                              // only the bot owner can use .r
const DATA_FILE = path.join(__dirname, '..', 'r_react_data.json');    // saved reactions + users
const REACT_GAP_MS = 800;                                             // pause between two reactions (anti-spam)
const MAX_QUEUE = 40;                                                 // drop extra reactions when the queue is full
const MAX_MESSAGE_AGE_SEC = 120;                                      // ignore old messages (offline backlog)
const STICKER_REUPLOAD_MS = 6 * 60 * 60 * 1000;                       // refresh a sticker upload every 6 hours
const BAILEYS_PACKAGES = ['@dnuzi/baileys', '@whiskeysockets/baileys', 'baileys'];
const LOG = '[.r]';

/* ═══════════════════════════ STORAGE ═══════════════════════════ */
// reactions : { "<reactionId>": { type: 'emoji', emoji } | { type: 'sticker', raw, data } }
// users     : { "<jid or lid>": "<reactionId>" }   ← every user points to ITS OWN reaction
let db = null;

const emojiId = (emoji) => `e:${emoji}`;

function loadDb() {
  if (db) return db;
  db = { reactions: {}, users: {} };
  try {
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
      if (saved.reactions && saved.users) {
        db.reactions = saved.reactions;
        for (const [jid, rid] of Object.entries(saved.users)) {
          if (db.reactions[rid]) db.users[jid] = rid;
        }
      } else if (saved.reaction && Array.isArray(saved.targets)) {
        // Old format (one reaction for everybody) → convert, nobody loses their reaction
        const old = saved.reaction;
        const valid = old.type === 'emoji' ? old.emoji : old.raw;
        if (valid) {
          const rid = old.type === 'emoji' ? emojiId(old.emoji) : `s:${(old.raw && old.raw.fileSha256) || 'legacy'}`;
          db.reactions[rid] = old;
          for (const jid of saved.targets) if (jid) db.users[jid] = rid;
          saveDb();
          console.log(`${LOG} Old data converted (${Object.keys(db.users).length} user(s)).`);
        }
      }
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
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, reactions: db.reactions, users: db.users }));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error(`${LOG} Could not save the data file:`, e.message);
  }
}

/** Removes reactions that no user points to any more (keeps the data file small). */
function gcReactions() {
  const used = new Set(Object.values(db.users));
  for (const rid of Object.keys(db.reactions)) {
    if (!used.has(rid)) delete db.reactions[rid];
  }
}

const hasUsers = () => {
  for (const _ in db.users) return true; // eslint-disable-line no-unused-vars
  return false;
};

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

/** The same sticker always gets the same id, so it is stored only once. */
function stickerId(st) {
  const sha = toB64(st.fileSha256);
  if (sha) return `s:${sha}`;
  const h = crypto.createHash('sha1').update(`${st.url || ''}|${toB64(st.mediaKey) || ''}`).digest('base64');
  return `s:${h}`;
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
const stickerCache = new WeakMap(); // conn → Map(reactionId → { savedAt, content, expires })
async function getStickerContent(conn, rid, r) {
  let perConn = stickerCache.get(conn);
  if (!perConn) { perConn = new Map(); stickerCache.set(conn, perConn); }
  const cached = perConn.get(rid);
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
  perConn.set(rid, {
    savedAt: r.savedAt,
    content,
    expires: Date.now() + (uploaded ? STICKER_REUPLOAD_MS : 5 * 60 * 1000),
  });
  return content;
}

/* ═══════════════════════════ REACTING ═══════════════════════════ */
/** React to ONE message with the reaction `rid` (an emoji or a sticker from the saved list). */
async function reactTo(conn, msg, rid) {
  const r = db.reactions[rid];
  if (!r) return;
  const jid = msg.key.remoteJid;

  if (r.type === 'emoji') {
    await conn.sendMessage(jid, { react: { text: r.emoji, key: msg.key } });
    return;
  }

  const sticker = await getStickerContent(conn, rid, r);
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

/** Which reaction (if any) belongs to the sender of this message? Checks both JID and LID forms. */
async function findReactionId(conn, msg) {
  const key = msg.key;
  const inGroup = (key.remoteJid || '').endsWith('@g.us');
  const raw = inGroup
    ? [key.participant, key.participantAlt, key.participantPn, key.participantLid, msg.participant]
    : [key.remoteJid, key.remoteJidAlt, key.senderPn, key.senderLid];
  const ids = uniq(raw.map(normalizeJid).filter(Boolean));

  const users = db.users;
  for (const j of ids) if (users[j]) return users[j];

  // Fallback: LID <-> phone number mapping (only when the list holds the other kind of ID)
  let hasPn = false;
  let hasLid = false;
  for (const j of Object.keys(users)) {
    if (j.endsWith('@lid')) hasLid = true; else hasPn = true;
    if (hasPn && hasLid) break;
  }
  for (const id of ids) {
    let alt = null;
    if (id.endsWith('@lid') && hasPn) alt = await lookupAlt(conn, id, 'pn');
    else if (id.endsWith('@s.whatsapp.net') && hasLid) alt = await lookupAlt(conn, id, 'lid');
    if (alt && users[alt]) return users[alt];
  }
  return null;
}

async function onIncoming(conn, msg) {
  loadDb();
  if (!hasUsers()) return;

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

  const rid = await findReactionId(conn, msg);
  if (!rid) return;
  if (alreadySeen(`${chat}:${key.id}`)) return;

  enqueue(() => reactTo(conn, msg, rid));
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
    '1) Give a sticker / emoji to users:',
    '   Reply to a sticker (or to a message that has only an emoji) with',
    '   *.r <jid|lid|number> <jid|lid|number> ... on*',
    '   or type the emoji: *.r <jid|lid|number> 😂 on*',
    '2) Turn it off:',
    '   *.r <jid|lid|number> ... off*  or  *.r all off*',
    '3) See who gets which reaction: *.r list*',
    '',
    '💡 Every user can have a different sticker / emoji. Reply to another sticker and use *.r* again for other users (or to change the reaction of a user).',
    'ℹ️ Numbers need the country code, e.g. 94771234567. LIDs must end with @lid. You can also @mention users.',
  ].join('\n');

function reactionLabel(r) {
  if (!r) return 'unknown';
  if (r.type === 'emoji') return r.emoji;
  if (r.raw && r.raw.isLottie) return 'lottie sticker';
  if (r.raw && r.raw.isAnimated) return 'animated sticker';
  return 'sticker';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function buildList(data) {
  const groups = new Map(); // reactionId → [jid, ...]
  for (const [jid, rid] of Object.entries(data.users)) {
    if (!groups.has(rid)) groups.set(rid, []);
    groups.get(rid).push(jid);
  }
  if (!groups.size) {
    return '🎭 *Auto Reactions*\n\nNo users are active yet.\nReply to a sticker or an emoji with *.r <jid|lid|number> on* to start.';
  }
  const lines = ['🎭 *Auto Reactions*', '', `Active users: ${Object.keys(data.users).length}`];
  let n = 0;
  for (const [rid, jids] of groups) {
    n++;
    lines.push('', `${n}) ${reactionLabel(data.reactions[rid])} – ${plural(jids.length, 'user')}`, ...jids.map((j) => `   • ${j}`));
  }
  return lines.join('\n');
}

/** Shows the chosen reaction on the command message, so the owner can see what was assigned. */
async function preview(conn, mek, rid) {
  try {
    await reactTo(conn, mek, rid);
  } catch (e) {
    console.error(`${LOG} Preview reaction failed:`, (e && e.message) || e);
  }
}

/** The sticker / emoji that the command message replied to (or null). */
function quotedReaction(quoted) {
  if (!quoted) return null;
  if (quoted.stickerMessage) return { kind: 'sticker', st: quoted.stickerMessage };
  const emoji = extractEmoji(getText(quoted));
  return emoji ? { kind: 'emoji', emoji } : null;
}

const buildEmoji = (emoji) => ({
  id: emojiId(emoji),
  entry: { type: 'emoji', emoji, savedAt: Date.now() },
  noCopy: false,
});

async function buildSticker(data, st) {
  const id = stickerId(st);
  const existing = data.reactions[id];
  if (existing && existing.data) return { id, entry: existing, noCopy: false }; // already stored → no new download

  let buffer = null;
  try {
    buffer = await downloadSticker(st);
  } catch (e) {
    console.error(`${LOG} Could not download the sticker:`, (e && e.message) || e);
  }
  const entry = {
    type: 'sticker',
    savedAt: Date.now(),
    raw: serializeSticker(st),
    data: buffer && buffer.length ? buffer.toString('base64') : null,
  };
  return { id, entry, noCopy: !entry.data };
}

async function handleToggle(conn, mek, say, data, info, quoted, targetText, action) {
  const mentioned = ((info && info.mentionedJid) || []).map(normalizeJid).filter(Boolean);
  const tokens = targetText.split(/[\s,;]+/).filter(Boolean);
  const found = [];
  const invalid = [];
  const typedEmojis = [];
  let all = false;

  for (const tok of tokens) {
    if (tok.toLowerCase() === 'all' && action === 'off') { all = true; continue; }
    const emoji = action === 'on' ? extractEmoji(tok) : null;
    if (emoji) { typedEmojis.push(emoji); continue; }
    const digits = tok.replace(/^@/, '');
    const mentionHit = mentioned.find((j) => j.split('@')[0] === digits); // exact JID/LID of an @mention
    const jid = mentionHit || parseJidToken(tok);
    if (jid) found.push(jid); else invalid.push(tok);
  }
  const ids = uniq(found);

  /* ───────── OFF ───────── */
  if (action === 'off') {
    if (all) {
      const count = Object.keys(data.users).length;
      data.users = {};
      gcReactions();
      saveDb();
      return say(`✅ Auto-react turned OFF for everyone (${plural(count, 'user')} removed).`);
    }
    if (!ids.length) {
      const why = invalid.length
        ? `❌ Invalid JID / LID / number: ${invalid.join(', ')}`
        : '❌ Give at least one JID / LID / number (or @mention a user).';
      return say(`${why}\n\n${usage()}`);
    }
    const removed = ids.filter((j) => data.users[j]);
    const missing = ids.filter((j) => !data.users[j]);
    for (const j of removed) delete data.users[j];
    gcReactions();
    saveDb();

    const lines = [];
    if (removed.length) lines.push(`✅ Auto-react OFF for ${plural(removed.length, 'user')}:`, ...removed.map((j) => `• ${j}`));
    if (missing.length) lines.push('ℹ️ Not in the active list:', ...missing.map((j) => `• ${j}`));
    if (invalid.length) lines.push(`⚠️ Ignored invalid input: ${invalid.join(', ')}`);
    return say(lines.join('\n'));
  }

  /* ───────── ON ───────── */
  if (!ids.length) {
    const why = invalid.length
      ? `❌ Invalid JID / LID / number: ${invalid.join(', ')}`
      : '❌ Give at least one JID / LID / number (or @mention a user).';
    return say(`${why}\n\n${usage()}`);
  }

  const typed = uniq(typedEmojis);
  if (typed.length > 1) return say('❌ Only one emoji can be given in a command.');
  const replied = quotedReaction(quoted);
  if (typed.length && replied) {
    return say('❌ Use either the replied sticker / emoji or an emoji typed in the command, not both.');
  }
  if (!typed.length && !replied) {
    return say(
      '❌ No sticker / emoji found.\n' +
        'Reply to a *sticker* (or to a message that has *only an emoji*) with:\n' +
        '*.r <jid|lid|number> ... on*\n' +
        'or type the emoji: *.r <jid|lid|number> 😂 on*'
    );
  }

  const reaction = typed.length
    ? buildEmoji(typed[0])
    : replied.kind === 'emoji'
      ? buildEmoji(replied.emoji)
      : await buildSticker(data, replied.st);

  const existing = data.reactions[reaction.id];
  if (!existing || !existing.data) data.reactions[reaction.id] = reaction.entry;

  const added = [];
  const changed = [];
  const already = [];
  for (const j of ids) {
    const current = data.users[j];
    if (!current) added.push(j);
    else if (current === reaction.id) already.push(j);
    else changed.push(j);
    data.users[j] = reaction.id;
  }
  gcReactions();
  saveDb();
  await preview(conn, mek, reaction.id);

  const label = reactionLabel(data.reactions[reaction.id]);
  const lines = [];
  if (added.length) lines.push(`✅ Auto-react ON (${label}) for ${plural(added.length, 'user')}:`, ...added.map((j) => `• ${j}`));
  if (changed.length) lines.push(`🔄 Reaction changed to ${label} for ${plural(changed.length, 'user')}:`, ...changed.map((j) => `• ${j}`));
  if (already.length) lines.push(`ℹ️ Already using ${label}:`, ...already.map((j) => `• ${j}`));
  if (invalid.length) lines.push(`⚠️ Ignored invalid input: ${invalid.join(', ')}`);
  if (reaction.noCopy) lines.push('⚠️ Could not keep a local copy of the sticker – its original link will be used (it may expire later).');
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

    // .r <ids> on | off   (reply to a sticker / an emoji to choose the reaction for "on")
    const toggle = input.match(/^([\s\S]*?)\s*(on|off)$/i);
    if (toggle) return await handleToggle(conn, mek, say, data, info, quoted, toggle[1], toggle[2].toLowerCase());

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
    desc: 'Auto sticker / emoji reaction (different reaction for each user)',
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
