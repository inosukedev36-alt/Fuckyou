// plugins/fd.js
//
//   .fd <jid> [<jid2> ...] [-t <when>] [caption]
//   .fd list                  show scheduled jobs
//   .fd cancel <id|all>       cancel scheduled job(s)
//
//   Send now
//     • reply to any message        -> that message is sent to every jid
//                                      (a caption you type replaces the old one on image / video / document)
//     • send media with the command -> that media is sent to every jid (text after the jids = its caption)
//     • no reply, no media          -> only the text after the jids is sent
//     • reply + just ".fd <jid>"    -> forwarded exactly as it is (original caption stays)
//
//   Timer (-t, Sri Lanka time) - same rules, but sent later
//     -t 30s | 15m | 2h30m | 1d | 1mo | 1y | 1y2mo3d4h5m6s     after that much time
//     -t 2026.12.2   |   -t 2026.12.2 18:30                    on that date (00:00 if no time is given)

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { cmd } = require('../command');
const { downloadContentFromMessage } = require('@dnuzi/baileys');

const OWNER_ONLY = true;         // false = anyone can use .fd
const SHOW_FORWARD_TAG = false;  // true = sent messages carry WhatsApp's "Forwarded" label
const DELAY_MS = 1500;           // pause between jids (anti-spam)
const MAX_TRIES = 3;             // timer jobs: tries per jid (covers the bot reconnecting)
const RETRY_MS = 30 * 1000;      // wait before the next try
const STORE_FILE = path.join(__dirname, '..', 'fd_schedule.json'); // pending timers - survive restarts
const MEDIA_DIR = path.join(__dirname, '..', 'fd_media');          // media waiting for its timer
const SL_OFFSET = 5.5 * 3600 * 1000;                               // Sri Lanka = UTC+5:30, no DST
const MAX_AHEAD = 100 * 366 * 24 * 3600 * 1000;                    // longest timer: 100 years

const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'];
const SKIP = ['messageContextInfo', 'senderKeyDistributionMessage'];
const CAPTIONABLE = ['imageMessage', 'videoMessage', 'documentMessage'];
const MEDIA = { imageMessage: 'image', videoMessage: 'video', documentMessage: 'document', audioMessage: 'audio', stickerMessage: 'sticker' };
const JID_RE = /^[\w.:-]+@(s\.whatsapp\.net|c\.us|g\.us|lid|newsletter)$/i;
const DATE_RE = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const DUR_RE = /^(\d{1,6}[a-z]+)+$/i;
const UNIT = {
  y: 'y', yr: 'y', yrs: 'y', year: 'y', years: 'y',
  mo: 'mo', month: 'mo', months: 'mo',
  d: 'd', day: 'd', days: 'd',
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  m: 'm', min: 'm', mins: 'm', minute: 'm', minutes: 'm',
  s: 's', sec: 's', secs: 's', second: 's', seconds: 's',
};

const USAGE =
  '*.fd* - send / forward to jid(s)\n\n' +
  '• Reply to a message:  .fd <jid> [<jid2> ...] [caption]\n' +
  '• Media + caption:  .fd <jid> [<jid2> ...] [caption]\n' +
  '• Text only:  .fd <jid> [<jid2> ...] <text>\n' +
  'Reply with just `.fd <jid>` to forward the message exactly as it is.\n\n' +
  '*Timer* (Sri Lanka time) - add `-t` after the jid(s)\n' +
  '• after:  -t 30s | 15m | 2h30m | 1d | 1mo | 1y | 1y2mo3d4h5m6s\n' +
  '• on a date:  -t 2026.12.2   or   -t 2026.12.2 18:30   (00:00 if no time)\n' +
  '• .fd list   |   .fd cancel <id|all>\n\n' +
  'jid: 120363xxxxxxxxxx@g.us | 94771234567@s.whatsapp.net | 120363xxxxxxxxxx@newsletter';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rm = (file) => {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
};

// strip ephemeral / view-once / document-caption wrappers
const unwrap = (msg) => {
  let w;
  while (msg && (w = WRAPPERS.find((k) => msg[k]))) msg = msg[w].message;
  return msg;
};

const typeOf = (msg) => msg && Object.keys(msg).find((k) => !SKIP.includes(k) && msg[k]);

const textOf = (msg) => {
  const t = typeOf(msg);
  if (!t) return '';
  const v = msg[t];
  return typeof v === 'string' ? v : v.text || v.caption || '';
};

// ───────────────────────────── time helpers (Sri Lanka time) ─────────────────────────────

const fmtSL = (ms) => new Date(ms + SL_OFFSET).toISOString().slice(0, 19).replace('T', ' ');

function fmtDur(ms) {
  let s = Math.max(0, Math.round(ms / 1000));
  const out = [];
  for (const [label, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    const n = Math.floor(s / size);
    if (n) { out.push(n + label); s -= n * size; }
  }
  return out.join(' ') || '0s';
}

// "1y2mo3d" -> { y: 1, mo: 2, d: 3 }   (null if it is not a time like that)
function durationOf(tok) {
  if (!DUR_RE.test(tok)) return null;
  const out = {};
  for (const [, n, u] of tok.toLowerCase().matchAll(/(\d+)([a-z]+)/g)) {
    const unit = UNIT[u];
    if (!unit) return null;
    out[unit] = (out[unit] || 0) + Number(n);
  }
  return out;
}

// months / years are calendar months / years (1mo from Jan 31 -> Feb 28), the rest are fixed lengths
function addDuration(now, t) {
  const wall = new Date(now + SL_OFFSET); // Sri Lanka wall clock, kept in the UTC fields
  if (t.y || t.mo) {
    const day = wall.getUTCDate();
    wall.setUTCDate(1);
    wall.setUTCMonth(wall.getUTCMonth() + (t.y || 0) * 12 + (t.mo || 0));
    const last = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 0)).getUTCDate();
    wall.setUTCDate(Math.min(day, last));
  }
  const ms = (((t.d || 0) * 24 + (t.h || 0)) * 60 + (t.m || 0)) * 60000 + (t.s || 0) * 1000;
  return wall.getTime() - SL_OFFSET + ms;
}

// text right after "-t"  ->  { runAt, rest }   (rest = what is left after the time)
function readTimer(rest, now) {
  const peek = () => {
    const h = rest.match(/^\s*(\S+)/);
    return h && { tok: h[1], len: h[0].length };
  };
  let h = peek();
  if (!h) throw new Error('add a time after -t (example: -t 2h30m   or   -t 2026.12.2 18:30)');

  let runAt;
  const date = h.tok.match(DATE_RE);
  if (date) {
    rest = rest.slice(h.len);
    let [hh, mm, ss] = [0, 0, 0];
    h = peek();
    const time = h && h.tok.match(TIME_RE);
    if (time) {
      [hh, mm, ss] = [+time[1], +time[2], +(time[3] || 0)];
      rest = rest.slice(h.len);
    }
    const [y, mo, d] = [+date[1], +date[2], +date[3]];
    const at = new Date(Date.UTC(y, mo - 1, d, hh, mm, ss));
    if (hh > 23 || mm > 59 || ss > 59 || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) {
      throw new Error('that date / time is not valid');
    }
    runAt = at.getTime() - SL_OFFSET;
  } else {
    const total = {};
    let part;
    let any = false;
    while ((h = peek()) && (part = durationOf(h.tok))) {
      for (const k in part) total[k] = (total[k] || 0) + part[k];
      rest = rest.slice(h.len);
      any = true;
    }
    if (!any) throw new Error(`cannot read "${peek().tok}" as a time (examples: 30s, 15m, 2h30m, 1d, 1mo, 1y, 2026.12.2 18:30)`);
    runAt = addDuration(now, total);
  }

  if (!Number.isFinite(runAt) || runAt > now + MAX_AHEAD) throw new Error('that time is too far ahead');
  if (runAt <= now) throw new Error(`${fmtSL(runAt)} has already passed (now: ${fmtSL(now)}, Sri Lanka time)`);
  return { runAt, rest };
}

// "jid1 -t 2h jid2 some caption"  ->  { jids: [jid1, jid2], runAt, caption: 'some caption' }
function parseArgs(raw, now) {
  const jids = [];
  let runAt = null;
  let rest = raw;
  for (;;) {
    const hit = rest.match(/^\s*(\S+)/);
    if (!hit) break;
    if (JID_RE.test(hit[1])) {
      jids.push(hit[1].toLowerCase().replace(/@c\.us$/, '@s.whatsapp.net'));
      rest = rest.slice(hit[0].length);
    } else if (hit[1].toLowerCase() === '-t') {
      if (runAt) throw new Error('use -t only once');
      ({ runAt, rest } = readTimer(rest.slice(hit[0].length), now));
    } else {
      break;
    }
  }
  return { jids: [...new Set(jids)], caption: rest.trim(), runAt };
}

// ───────────────────────────── sending ─────────────────────────────

async function downloadBuffer(inner, kind) {
  const stream = await downloadContentFromMessage(inner, kind);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// source = Buffer or { url: '/path/to/file' }, meta = the original media fields
function mediaPayload(type, meta, source) {
  const p = { [MEDIA[type]]: source, mimetype: meta.mimetype };
  if (CAPTIONABLE.includes(type)) p.caption = meta.caption || '';
  if (type === 'documentMessage') p.fileName = meta.fileName || 'file';
  if (type === 'audioMessage') p.ptt = !!meta.ptt;
  if (type === 'videoMessage' && meta.gifPlayback) p.gifPlayback = true;
  return p;
}

// send right now
async function deliver(conn, jid, { content, type, getBuffer }) {
  const channel = jid.endsWith('@newsletter');

  // plain text (channels also need this for link / reply texts)
  if (type === 'conversation' || (channel && type === 'extendedTextMessage')) {
    return conn.sendMessage(jid, { text: textOf(content) });
  }

  // chats & groups: relay the original message - no download, no re-upload
  if (!channel) {
    return conn.sendMessage(jid, {
      forward: { key: { fromMe: true }, message: content },
      force: SHOW_FORWARD_TAG,
    });
  }

  // channels: media has to be uploaded again (downloaded only once for all jids)
  if (!MEDIA[type]) throw new Error('this message type cannot be sent to a channel');
  return conn.sendMessage(jid, mediaPayload(type, content[type], await getBuffer()));
}

// ───────────────────────────── timers ─────────────────────────────

let store = { seq: 0, jobs: [] };
try {
  const saved = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  store = { seq: saved.seq || 0, jobs: Array.isArray(saved.jobs) ? saved.jobs : [] };
} catch {
  /* first run - no file yet */
}

const save = () => {
  fs.writeFileSync(STORE_FILE + '.tmp', JSON.stringify(store, null, 1));
  fs.renameSync(STORE_FILE + '.tmp', STORE_FILE);
};

let liveConn = null;
let ticker = null;
const running = new Set();

// remember the newest connection (jobs need it) and start the 1-second clock
const touch = (conn) => {
  liveConn = conn;
  if (!ticker) {
    ticker = setInterval(tick, 1000);
    if (ticker.unref) ticker.unref();
  }
};

// media is saved to disk now: WhatsApp deletes old media, so a month-long timer could not relay it later
async function schedule({ chat, jids, runAt, content, type }) {
  const inner = content[type];
  const isText = type === 'conversation' || type === 'extendedTextMessage';
  if (!isText && !MEDIA[type]) throw new Error('a timer works for text / photo / video / audio / document / sticker only');

  const job = { id: ++store.seq, chat, runAt, jids, total: jids.length, sent: 0, tries: 0, type };
  if (isText) {
    job.kind = 'text';
    job.text = textOf(content);
  } else {
    job.kind = 'media';
    job.file = path.join(MEDIA_DIR, `fd_${job.id}`);
    job.meta = { mimetype: inner.mimetype, caption: inner.caption, fileName: inner.fileName, ptt: inner.ptt, gifPlayback: inner.gifPlayback };
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    try {
      await pipeline(await downloadContentFromMessage(inner, MEDIA[type]), fs.createWriteStream(job.file));
    } catch (e) {
      rm(job.file);
      throw e;
    }
  }
  store.jobs.push(job);
  save();
  return job;
}

// state.first = the message uploaded for the first jid, relayed to the other jids (one upload for all)
async function sendJob(conn, jid, job, state) {
  if (job.kind === 'text') return conn.sendMessage(jid, { text: job.text });

  const channel = jid.endsWith('@newsletter');
  if (!channel && state.first) {
    return conn.sendMessage(jid, { forward: state.first, force: SHOW_FORWARD_TAG });
  }
  const res = await conn.sendMessage(jid, mediaPayload(job.type, job.meta, { url: job.file }));
  const sent = !channel && res && res.message && unwrap(res.message);
  if (sent && sent[job.type]) state.first = { key: { fromMe: true }, message: { [job.type]: sent[job.type] } };
  return res;
}

async function runJob(conn, job) {
  if (!job.tries) job.late = Date.now() - job.runAt;
  const state = {};
  const failed = [];
  for (let i = 0; i < job.jids.length; i++) {
    try {
      await sendJob(conn, job.jids[i], job, state);
      job.sent++;
    } catch (e) {
      failed.push({ jid: job.jids[i], err: e.message });
    }
    if (i < job.jids.length - 1) await sleep(DELAY_MS);
  }

  if (failed.length && ++job.tries < MAX_TRIES) { // try the failed jids again shortly
    job.jids = failed.map((f) => f.jid);
    job.runAt = Date.now() + RETRY_MS;
    return save();
  }

  store.jobs = store.jobs.filter((j) => j !== job);
  if (job.file) rm(job.file);
  save();

  let msg = `⏰ Scheduled #${job.id}: sent to ${job.sent}/${job.total} jid(s)`;
  if (failed.length) msg += `\n\n❌ Failed:\n${failed.map((f) => `${f.jid} - ${f.err}`).join('\n')}`;
  if (job.late > 60000) msg += `\n\n⚠️ Sent ${fmtDur(job.late)} late (the bot was offline).`;
  try {
    await conn.sendMessage(job.chat, { text: msg });
  } catch { /* chat not reachable - nothing more to do */ }
}

async function tick() {
  if (!liveConn || running.size) return; // one job at a time
  const job = store.jobs.find((j) => j.runAt <= Date.now());
  if (!job) return;
  running.add(job.id);
  try {
    await runJob(liveConn, job);
  } catch (e) {
    console.error('[fd] job', job.id, e);
    job.runAt = Date.now() + RETRY_MS; // never spin on a broken job
  } finally {
    running.delete(job.id);
  }
}

function listText() {
  if (!store.jobs.length) return 'No scheduled .fd jobs.';
  const now = Date.now();
  const rows = [...store.jobs]
    .sort((a, b) => a.runAt - b.runAt)
    .map((j) => {
      const what = j.kind === 'text' ? `text "${j.text.length > 25 ? j.text.slice(0, 25) + '…' : j.text}"` : MEDIA[j.type];
      return `#${j.id} - ${fmtSL(j.runAt)} (in ${fmtDur(j.runAt - now)})\n    ${what} → ${j.jids.join(', ')}`;
    });
  return `⏰ *Scheduled .fd jobs* (Sri Lanka time)\n\n${rows.join('\n')}`;
}

function cancelText(arg) {
  if (!arg) return '❌ Use: .fd cancel <id|all>';
  const hit = store.jobs.filter((j) => arg === 'all' || String(j.id) === arg);
  if (!hit.length) return `❌ No scheduled job "${arg}".`;
  const idle = hit.filter((j) => !running.has(j.id));
  if (!idle.length) return '❌ That job is being sent right now.';
  for (const j of idle) if (j.file) rm(j.file);
  store.jobs = store.jobs.filter((j) => !idle.includes(j));
  save();
  return `🗑️ Cancelled ${idle.map((j) => '#' + j.id).join(', ')}`;
}

// ───────────────────────────── command ─────────────────────────────

cmd(
  {
    pattern: 'fd',
    desc: 'Send / forward a message to one or more jids (now or on a timer)',
    category: 'owner',
    filename: __filename,
  },
  async (conn, mek, m, { isOwner }) => {
    touch(conn);
    const chat = mek.key.remoteJid;
    const say = (text) => conn.sendMessage(chat, { text }, { quoted: mek });

    try {
      if (OWNER_ONLY && !isOwner && !mek.key.fromMe) return await say('❌ Owner only command.');

      const own = unwrap(mek.message);
      const ownType = typeOf(own);
      const raw = textOf(own).replace(/^\s*\S+/, ''); // drop ".fd"

      const [word = '', arg = ''] = raw.trim().split(/\s+/);
      if (word.toLowerCase() === 'list') return await say(listText());
      if (word.toLowerCase() === 'cancel') return await say(cancelText(arg.toLowerCase().replace(/^#/, '')));

      let parsed;
      try {
        parsed = parseArgs(raw, Date.now());
      } catch (e) {
        return await say(`❌ Timer: ${e.message}`);
      }
      const { jids, caption, runAt } = parsed;
      if (!jids.length) return await say(USAGE);

      // what gets sent: media attached to the command > replied message > caption text
      const replied = unwrap(own[ownType]?.contextInfo?.quotedMessage);
      const src = CAPTIONABLE.includes(ownType) ? own : replied;

      let content, type, note = '';
      if (src && typeOf(src)) {
        type = typeOf(src);
        if (CAPTIONABLE.includes(type)) {
          const text = src === own ? caption : caption || src[type].caption || '';
          content = { [type]: { ...src[type], caption: text } };
        } else {
          content = { [type]: src[type] };
          if (caption) note = 'Caption ignored: this message type cannot have a caption.';
        }
      } else if (caption) {
        type = 'conversation';
        content = { conversation: caption };
      } else {
        return await say('❌ Nothing to send. Reply to a message, attach media, or add a text after the jid.');
      }

      // timer: save it now, the bot sends it later
      if (runAt) {
        const job = await schedule({ chat, jids, runAt, content, type });
        let out = `⏰ Scheduled #${job.id}\n📅 ${fmtSL(runAt)} (Sri Lanka time) - in ${fmtDur(runAt - Date.now())}\n👥 ${jids.length} jid(s)\n\n.fd list   |   .fd cancel ${job.id}`;
        if (note) out += `\n\nℹ️ ${note}`;
        return await say(out);
      }

      // send now
      let pending; // download once, reuse for every channel jid
      const getBuffer = () => pending || (pending = downloadBuffer(content[type], MEDIA[type]));

      const failed = [];
      let sent = 0;
      for (let i = 0; i < jids.length; i++) {
        try {
          await deliver(conn, jids[i], { content, type, getBuffer });
          sent++;
        } catch (e) {
          failed.push(`${jids[i]} - ${e.message}`);
        }
        if (i < jids.length - 1) await sleep(DELAY_MS);
      }

      let report = `✅ Sent to ${sent}/${jids.length} jid(s)`;
      if (failed.length) report += `\n\n❌ Failed:\n${failed.join('\n')}`;
      if (note) report += `\n\nℹ️ ${note}`;
      await say(report);
    } catch (e) {
      console.error('[fd]', e);
      await say(`❌ Error: ${e.message}`);
    }
  }
);

// keeps the newest connection handy so pending timers can fire (also right after a restart)
cmd({ on: 'body', dontAddCommandList: true, filename: __filename }, async (conn) => touch(conn));
