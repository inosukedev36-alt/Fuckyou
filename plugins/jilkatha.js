/**
 * ╔══════════════════════════════════════════════╗
 * ║  📚  JILKATHA SEARCH  ·  plugins/jilkatha.js  ║
 * ╚══════════════════════════════════════════════╝
 *
 *  .jk <keyword>
 *  .jk raw <keyword>    → first API item as JSON (debug)
 *
 *  Flow : search → scroll-menu (single_select) → story card → read here
 *  API  : https://api.kcey.online/api/jilkatha/search   (API credit: DTZ KCEY)
 */

const { cmd } = require('../command');
const axios = require('axios');
const { generateWAMessageFromContent, prepareWAMessageMedia, proto } = require('@dnuzi/baileys');

// ═══════════════════════ CONFIG ═══════════════════════
const BOT_NAME = 'SHIRO-MD';
const API_URL = 'https://api.kcey.online/api/jilkatha/search';
const API_KEY = process.env.KCEY_API_KEY || 'kcey_854640828e7d4c1f97a612eeeed122c3a6f0';
const FOOTER = `© ${BOT_NAME} `;
const PER_MENU = 10; // rows in one menu
const SESSION_TTL = 15 * 60 * 1000; // a menu stays active for 15 min
const CHUNK = 3500; // story text split size

// ═══════════════════════ HELPERS ═══════════════════════
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clip = (s, n) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

const pick = (o, keys) => {
  for (const k of keys) {
    const v = o && o[k];
    if ((typeof v === 'string' || typeof v === 'number') && String(v).trim()) return String(v).trim();
  }
  return '';
};

// API item → common shape (field names are guessed – use ".jk raw <kw>" to check)
const normalize = (it, i) => {
  if (typeof it === 'string') it = { title: it };
  return {
    title: pick(it, ['title', 'name', 'heading']) || `Story ${i + 1}`,
    url: pick(it, ['url', 'link', 'href', 'permalink']),
    image: pick(it, ['image', 'thumbnail', 'thumb', 'img', 'cover', 'poster']),
    desc: pick(it, ['description', 'desc', 'excerpt', 'summary', 'snippet']),
    date: pick(it, ['date', 'published', 'created', 'time']),
    author: pick(it, ['author', 'writer', 'by']),
    text: pick(it, ['content', 'story', 'text', 'body']),
    raw: it,
  };
};

const chunk = (text, size) => {
  const out = [];
  let rest = String(text).trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
};

// ═══════════════════════ API ═══════════════════════
async function fetchPage(q, page) {
  const params = { q, key: API_KEY };
  if (page > 1) params.page = page;

  const { data } = await axios.get(API_URL, { params, timeout: 30000 });
  if (!data || typeof data !== 'object') throw new Error('Invalid API response');
  if (data.success === false) throw new Error(data.message || data.error || 'API returned success:false');

  // API ignored ?page= and sent another page back → treat as "no more results"
  if (page > 1 && data.page && Number(data.page) !== page) return { items: [] };

  const list = Array.isArray(data.items) ? data.items : [];
  return { items: list.slice(0, PER_MENU).map(normalize) };
}

// ═══════════════════════ SESSIONS ═══════════════════════
const sessions = new Map(); // sid → { q, ts, pages: { [page]: items[] } }
const newSid = () => Math.random().toString(36).slice(2, 8);
const sweep = () => {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.ts > SESSION_TTL) sessions.delete(k);
};

// ═══════════════════════ SCROLL-MENU (single_select) ═══════════════════════
// interactiveMessage + nativeFlow "single_select"  (same style as menutest)
async function sendMenu(conn, jid, quoted, { header = '', body, title, sections, image = '' }) {
  const IM = proto.Message.InteractiveMessage;

  let hdr = { title: header, subtitle: '', hasMediaAttachment: false };
  if (image) {
    try {
      const media = await prepareWAMessageMedia({ image: { url: image } }, { upload: conn.waUploadToServer });
      hdr = { ...media, title: header, subtitle: '', hasMediaAttachment: true };
    } catch (e) {
      /* image failed → menu without picture */
    }
  }

  const content = {
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage: IM.create({
          header: IM.Header.create(hdr),
          body: IM.Body.create({ text: body }),
          footer: IM.Footer.create({ text: FOOTER }),
          nativeFlowMessage: IM.NativeFlowMessage.create({
            buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify({ title, sections }) }],
            messageParamsJson: '',
          }),
        }),
      },
    },
  };

  const msg = generateWAMessageFromContent(jid, content, { quoted: quoted || undefined, userJid: conn.user.id });
  await conn.relayMessage(jid, msg.message, { messageId: msg.key.id });
  return msg;
}

// ═══════════════════════ SCREENS ═══════════════════════
async function showList(conn, jid, quoted, sid, page) {
  const s = sessions.get(sid);
  const items = s.pages[page];

  const rows = items.map((it, i) => ({
    header: '',
    title: clip(it.title, 60),
    description: clip(it.desc || it.date || it.author, 72),
    id: `jk:${sid}:open:${page}:${i}`,
  }));

  const nav = [];
  if (page > 1) nav.push({ header: '', title: '⬅️ Previous page', description: `Page ${page - 1}`, id: `jk:${sid}:go:${page - 1}` });
  nav.push({ header: '', title: 'Next page ➡️', description: `Page ${page + 1}`, id: `jk:${sid}:go:${page + 1}` });

  const body =
    `╭━━━〔 📚 *JILKATHA SEARCH* 〕━━━╮\n` +
    `┃ 🔎 *Search*  : ${s.q}\n` +
    `┃ 📄 *Page*    : ${page}\n` +
    `┃ 📦 *Results* : ${items.length}\n` +
    `╰━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
    `👇 පහල බටන් එක ඔබලා කතාවක් තෝරන්න`;

  return sendMenu(conn, jid, quoted, {
    body,
    title: '📚 කතා තෝරන්න',
    sections: [
      { title: `Page ${page} results`, rows },
      { title: 'Navigation', rows: nav },
    ],
  });
}

async function showDetails(conn, jid, quoted, sid, page, idx) {
  const it = sessions.get(sid)?.pages?.[page]?.[idx];
  if (!it) return conn.sendMessage(jid, { text: '⚠️ Item එක හොයාගන්න බැරි වුණා. ආපහු search කරන්න.' });

  const body =
    `📖 *${it.title}*\n\n` +
    (it.desc ? `📝 ${clip(it.desc, 350)}\n\n` : '') +
    (it.author ? `✍️ *Author* : ${it.author}\n` : '') +
    (it.date ? `📅 *Date*   : ${it.date}\n` : '') +
    (it.url ? `🔗 ${it.url}\n` : '') +
    `\n👇 ඊළඟට කරන්න ඕන දේ තෝරන්න`;

  const rows = [];
  if (it.text) {
    rows.push({ header: '', title: '📖 මෙතනම කියවන්න', description: 'Story එක chat එකටම එවනවා', id: `jk:${sid}:read:${page}:${idx}` });
  }
  rows.push({ header: '', title: '⬅️ ආපසු ලැයිස්තුවට', description: `Page ${page} results`, id: `jk:${sid}:go:${page}` });

  return sendMenu(conn, jid, quoted, {
    body,
    title: '⚙️ තෝරන්න',
    sections: [{ title: 'Options', rows }],
    image: /^https?:\/\//i.test(it.image) ? it.image : '',
  });
}

async function sendStory(conn, jid, it) {
  const parts = chunk(`*${it.title}*\n\n${it.text}`, CHUNK);
  for (let i = 0; i < parts.length; i++) {
    const tail = parts.length > 1 ? `\n\n_(${i + 1}/${parts.length})_` : '';
    await conn.sendMessage(jid, { text: parts[i] + tail });
    if (i < parts.length - 1) await sleep(800);
  }
}

// ═══════════════════════ BUTTON REPLIES ═══════════════════════
const unwrap = (m) =>
  (m && (m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message)) || m;

const selectedId = (msg) => {
  let m = msg && msg.message;
  for (let i = 0; i < 3 && m; i++) {
    const n = unwrap(m);
    if (n === m) break;
    m = n;
  }
  if (!m) return '';

  const nf = m.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (nf && nf.paramsJson) {
    try {
      const j = JSON.parse(nf.paramsJson);
      if (j.id) return String(j.id);
    } catch (e) {}
  }
  return (
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.templateButtonReplyMessage?.selectedId ||
    ''
  );
};

const attached = new WeakSet();
const seen = new Set();

function attach(conn) {
  if (attached.has(conn)) return;
  attached.add(conn);

  conn.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages || []) {
      const id = selectedId(msg);
      if (!id.startsWith('jk:')) continue; // not our button

      if (seen.has(msg.key.id)) continue; // duplicate event
      seen.add(msg.key.id);
      if (seen.size > 500) seen.clear();

      const jid = msg.key.remoteJid;
      try {
        const [, sid, act, pg, ix] = id.split(':');
        const s = sessions.get(sid);
        if (!s) {
          await conn.sendMessage(jid, { text: '⌛ මේ menu එක expire වෙලා. ආපහු *.jk <keyword>* කරන්න.' });
          continue;
        }
        s.ts = Date.now();
        const page = Number(pg);
        const idx = Number(ix);

        if (act === 'open') {
          await showDetails(conn, jid, null, sid, page, idx);
        } else if (act === 'read') {
          const it = s.pages[page]?.[idx];
          if (it?.text) await sendStory(conn, jid, it);
        } else if (act === 'go' && page >= 1) {
          if (!s.pages[page]) {
            const r = await fetchPage(s.q, page);
            if (!r.items.length) {
              await conn.sendMessage(jid, { text: `📭 Page ${page} එකේ තවත් results නැහැ.` });
              continue;
            }
            s.pages[page] = r.items;
          }
          await showList(conn, jid, null, sid, page);
        }
      } catch (e) {
        console.error('[jilkatha] button error:', e.message);
        await conn.sendMessage(jid, { text: `❌ Error: ${e.message}` }).catch(() => {});
      }
    }
  });
}

// ═══════════════════════ COMMAND ═══════════════════════
cmd(
  {
    pattern: 'jk',
    alias: [],
    desc: 'Jilkatha search (scroll-menu buttons)',
    category: 'search',
    react: '📚',
    filename: __filename,
  },
  async (conn, mek, m, { from, q, reply }) => {
    const say = reply || ((t) => conn.sendMessage(from, { text: t }, { quoted: mek }));
    try {
      const query = (q || '').trim();
      const dbg = /^raw(\s|$)/i.test(query);
      const term = dbg ? query.replace(/^raw\s*/i, '').trim() : query;

      if (!term) {
        return say(
          `╭━━━〔 📚 *JILKATHA SEARCH* 〕━━━╮\n` +
            `┃ ⚠️ keyword එකක් දෙන්න\n` +
            `┃ 📌 *.jk* <keyword>\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━╯`
        );
      }

      attach(conn);
      sweep();

      const first = await fetchPage(term, 1);

      if (dbg) {
        const sample = first.items[0] ? first.items[0].raw : { note: 'items empty' };
        return say('```' + JSON.stringify(sample, null, 2).slice(0, 3000) + '```');
      }
      if (!first.items.length) {
        return say(`📭 *"${term}"* සඳහා ප්‍රතිඵල හමු වුණේ නැහැ.\nවෙන keyword එකක් try කරන්න.`);
      }

      const sid = newSid();
      sessions.set(sid, { q: term, ts: Date.now(), pages: { 1: first.items } });
      await showList(conn, from, mek, sid, 1);
    } catch (e) {
      console.error('[jilkatha]', e);
      say(`❌ Error: ${e.message}`);
    }
  }
);
