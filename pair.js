require('dotenv').config();

// Message ids that look like a phone's (config.MESSAGE_ID_STYLE). This Baileys fork ignores options.messageId,
// so one line in node_modules is patched BEFORE the library is loaded (explained in lib/msgid.js).
const msgId = require('./lib/msgid');
const msgIdPatch = msgId.ensurePatched(require('./config'));
const runctx = require('./lib/gf/runctx');
const antiban = require('./lib/antiban');   // pacing, rate caps, human typing/presence, reconnect policy (see lib/antiban.js)

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const crypto = require('crypto');
const config = require('./config');

// ═══ the paired number itself ═══
// What you type on the phone / WhatsApp Web of the account this bot is linked to ("Message yourself", or any chat) is
// handled with the OWNER's access: commands everywhere, GF chat in the self-chat only.
// Optional switches in config.js:  OWN_NUMBER: { COMMANDS: true, SELF_CHAT_GF: true }
const OWN = { COMMANDS: true, SELF_CHAT_GF: true, ...(config.OWN_NUMBER || {}) };
const botSentIds = new Set();   // ids of messages this bot sent itself: the echo of those is never mistaken for "the owner typed it"
const rememberBotId = (id) => { if (!id) return; botSentIds.add(id); if (botSentIds.size > 3000) botSentIds.delete(botSentIds.values().next().value); };

// ═══ custom pairing code ═══
// The code WhatsApp asks for when linking a number is normally random. With PAIR_CODE it is the same every time:
// exactly 8 letters / digits, e.g. 'SHIROMD1'. Set it in config.js (PAIR_CODE: 'SHIROMD1') or in .env (PAIR_CODE=SHIROMD1).
// PAIR_CODE: '' = a random WhatsApp code like before. (Needs a Baileys version that accepts a custom code - see Pair().)
function wantedPairCode() {
    const src = config.PAIR_CODE !== undefined ? config.PAIR_CODE : (process.env.PAIR_CODE !== undefined ? process.env.PAIR_CODE : 'SHIROMD1');
    const code = String(src || '').replace(/[\s-]/g, '').toUpperCase();   // the phone shows capital letters, so the code is always capital
    if (!code) return null;
    if (!/^[A-Z0-9]{8}$/.test(code)) {
        console.log(`⚠️ PAIR_CODE "${code}" cannot be used (it must be exactly 8 letters or digits) - a random pairing code is used instead`);
        return null;
    }
    return code;
}

const axios = require('axios');
const mongoose = require('mongoose');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    getContentType,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    generateForwardMessageContent,
    generateWAMessageFromContent
} = require('@dnuzi/baileys');

const { getBuffer, getGroupAdmins, runtime } = require('./lib/functions');
const { sms } = require('./lib/msg');
const NodeCache = require('node-cache');
const util = require('util');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_BASE_PATH = './sessions';
const msgRetryCounterCache = new NodeCache();

require('events').EventEmitter.defaultMaxListeners = 500;

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI missing — exiting.');
    process.exit(1);
}

const messageCache = new Map(); // For anti-delete

mongoose.connect(MONGODB_URI)
    .then(async () => {
        console.log('Mongo db Connected පකෝ ✅');
        try {
            const SudoModel = mongoose.models.Sudo || mongoose.model('Sudo', new mongoose.Schema({ number: String }));
            const sudos = await SudoModel.find();
            global.sudoList = sudos.map(s => s.number);
            
            // Trusted numbers add to sudo automatically
            for (const t of config.TRUSTED_NUMBERS) {
                const jid = `${t.number}@s.whatsapp.net`;
                if (!global.sudoList.includes(jid)) {
                    global.sudoList.push(jid);
                    await SudoModel.findOneAndUpdate({ number: jid }, { number: jid }, { upsert: true });
                }
            }
            console.log(`✅ Loaded ${global.sudoList.length} sudo users.`);
        } catch (e) {
            console.log('Sudo load error:', e.message);
            global.sudoList = config.TRUSTED_NUMBERS.map(t => `${t.number}@s.whatsapp.net`);
        }
    })
    .catch(err => console.log('❌ 𝐌ᴏɴɢᴏ𝐃𝐁 ᴇʀʀᴏ:', err));

const SessionSchema = new mongoose.Schema({
    sessionId: String,
    data: Object
});
const Session = mongoose.model('Session', SessionSchema);

fs.readdirSync("./plugins/").forEach((plugin) => {
    if (path.extname(plugin).toLowerCase() == ".js") {
        try {
            require("./plugins/" + plugin);
        } catch (e) {
            console.error(`❌ Plugin "${plugin}" failed to load and was skipped:`, e && e.message);
        }
    }
});
console.log('plugings ඔක්කොම හරි පකෝ  ⚡');

const events = require('./command');

const commandMap = new Map();
for (const cmd of events.commands) {
    if (cmd.pattern) commandMap.set(cmd.pattern, cmd);
    if (cmd.alias) {
        for (const alias of cmd.alias) {
            if (!commandMap.has(alias)) commandMap.set(alias, cmd);
        }
    }
}

events.commandMap = commandMap;   // lets plugins (GF brain) look commands up and run them for the user

app.use(express.static(path.join(__dirname, 'public')));

const activeSockets = {};
global.activeSockets = activeSockets;
const keepAliveTimers = {};
const reconnectTimers = {};
const fileCache = {};
const saveDebounceTimers = {};
const userCooldowns = new Map();

// ═══ pairing window ═══
// A pairing code / QR code stays valid for PAIR_TTL_SECONDS (config.js or .env, default 60 = 1 minute).
// When nobody finishes the pairing in that time the unfinished session is thrown away, so a fresh code can be asked for.
const PAIR_TTL_MS = Math.max(20, Number(config.PAIR_TTL_SECONDS || process.env.PAIR_TTL_SECONDS || 60)) * 1000;
const MAX_QR_ATTEMPTS = Number(config.QR_MAX_ATTEMPTS || 3);   // QR codes that may be open at the same time
const pendingPairs = new Map();   // sessionId -> timer (a pairing code nobody has typed on the phone yet)
const qrAttempts = new Map();     // id -> QR pairing attempt (see "QR PAIRING" below)

global.groupCache = new Map();

function cleanupSession(sessionId) {
    try { antiban.detach(sessionId); } catch (e) {}
    if (keepAliveTimers[sessionId]) { clearInterval(keepAliveTimers[sessionId]); delete keepAliveTimers[sessionId]; }
    if (keepAliveTimers[`presence_${sessionId}`]) { clearInterval(keepAliveTimers[`presence_${sessionId}`]); delete keepAliveTimers[`presence_${sessionId}`]; }
    if (reconnectTimers[sessionId]) { clearTimeout(reconnectTimers[sessionId]); delete reconnectTimers[sessionId]; }
    if (saveDebounceTimers[sessionId]) { clearTimeout(saveDebounceTimers[sessionId]); delete saveDebounceTimers[sessionId]; }
    const sock = activeSockets[sessionId];
    if (sock) {
        killSocket(sock);
        delete activeSockets[sessionId];
    }
}

// really closes a socket (removing the listeners alone left the connection open, so an expired code could still be typed in)
function killSocket(sock) {
    if (!sock) return;
    try { sock.ev.removeAllListeners(); } catch (e) {}
    try { sock.end(undefined); } catch (e) {}
    try {
        const w = sock.ws;
        if (w && typeof w.terminate === 'function') w.terminate();
        else if (w && typeof w.close === 'function') { const p = w.close(); if (p && typeof p.catch === 'function') p.catch(() => {}); }
    } catch (e) {}
}

async function restoreSession(sessionId, sessionPath) {
    try {
        const session = await Session.findOne({ sessionId });
        if (!session) return false;
        await fs.ensureDir(sessionPath);
        for (const file in session.data) await fs.writeFile(path.join(sessionPath, file), session.data[file]);
        console.log('✅ 𝐑ᴇꜱᴛᴏʀᴇ:', sessionId);
        return true;
    } catch (err) { return false; }
}

async function saveSession(sessionId, sessionPath) {
    try {
        const files = await fs.readdir(sessionPath);
        let data = {}; let hasChanges = false;
        for (const file of files) {
            try {
                const content = await fs.readFile(path.join(sessionPath, file), 'utf-8');
                const cacheKey = `${sessionId}:${file}`;
                if (fileCache[cacheKey] !== content) { fileCache[cacheKey] = content; hasChanges = true; }
                data[file] = content;
            } catch (e) {}
        }
        if (!hasChanges) return;
        await Session.findOneAndUpdate({ sessionId }, { data }, { upsert: true });
        console.log('💾 𝐒aved:', sessionId);
    } catch (err) {}
}

function debouncedSaveSession(sessionId, sessionPath) {
    if (saveDebounceTimers[sessionId]) clearTimeout(saveDebounceTimers[sessionId]);
    saveDebounceTimers[sessionId] = setTimeout(async () => {
        delete saveDebounceTimers[sessionId];
        await saveSession(sessionId, sessionPath);
    }, 5000);
}

// ═══ pairing-code window ═══
// startPending: a code was handed out. If the phone has not accepted it when the window is over, the unfinished
// session (socket + MongoDB doc + folder) is removed. endPending: the phone accepted it, or the attempt was dropped.
function endPending(sessionId) {
    clearTimeout(pendingPairs.get(sessionId));
    pendingPairs.delete(sessionId);
}

function startPending(sessionId, sessionPath) {
    endPending(sessionId);
    pendingPairs.set(sessionId, setTimeout(async () => {
        pendingPairs.delete(sessionId);
        const c = activeSockets[sessionId]?.authState?.creds;
        if (!c || c.registered || c.account) return;   // typed in time (or the session is already gone): leave it alone
        console.log(`⌛ [${sessionId}] pairing code expired - unfinished session removed`);
        await dropPairing(sessionId, sessionPath);
    }, PAIR_TTL_MS + 3000));   // 3s grace, so a code typed in the last second still works
}

async function dropPairing(sessionId, sessionPath) {
    endPending(sessionId);
    cleanupSession(sessionId);
    try { await Session.findOneAndDelete({ sessionId }); } catch (e) {}
    try { await fs.remove(sessionPath); } catch (e) {}
    for (const k of Object.keys(fileCache)) if (k.startsWith(sessionId + ':')) delete fileCache[k];
}

// ═══ URL Detection ═══
function containsLink(text) {
    if (!text) return false;
    const urlPattern = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9-]+\.(com|net|org|io|me|co|tv|xyz|app|info|link|ly|to)\b[^\s]*)/i;
    return urlPattern.test(text);
}

// ═══ Bot Signature Detection ═══
function isBotMessage(mek, body) {
    if (!body) return false;
    const cleanBody = String(body).toLowerCase();
    
    // Command එකක් නම් bot message එකක් කියලා හඳුනාගන්නේ නෑ
    if (cleanBody.startsWith(config.PREFIX)) return false;

    for (const sig of config.BOT_SIGNATURES) {
        if (cleanBody.includes(sig.toLowerCase())) return true;
    }
    return false;
}

async function Pair(number, res = null) {
    const xnumber = number.replace(/[^0-9]/g, '');
    const sessionId = `dina_${xnumber}`;
    const sessionPath = path.join(SESSION_BASE_PATH, sessionId);

    // "owner side" for the anti-ban layer: owner, this linked number, sudo and trusted numbers
    // (their chats are never paused and never counted as cold messaging)
    const ownerDigits = [config.OWNER_NUMBER, config.OWNER_LID, xnumber].map(x => String(x || '').replace(/[^0-9]/g, '')).filter(Boolean);
    const isPrivilegedJid = (jid) => {
        const d = String(jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        if (!d) return false;
        if (ownerDigits.includes(d)) return true;
        if (Array.isArray(global.sudoList) && global.sudoList.some(j => String(j).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') === d)) return true;
        return (config.TRUSTED_NUMBERS || []).some(t => String(t.number) === d);
    };

    if (activeSockets[sessionId]) {
        if (res && pendingPairs.has(sessionId)) {
            // a code for this number is still waiting on the phone and a new one was asked for: drop the old attempt first
            await dropPairing(sessionId, sessionPath);
        } else {
            if (res && !res.headersSent) res.json({ error: 'Session already active.' });
            return;
        }
    }

    try {
        await restoreSession(sessionId, sessionPath);
        await fs.ensureDir(sessionPath);

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();
        const logger = pino({ level: 'silent' });

        const sock = makeWASocket({
            version, logger,
            browser: ["Ubuntu", "Chrome", "110.0.5481.77"],
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            printQRInTerminal: false,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 30000,
            markOnlineOnConnect: false,   // do not show "online" just because the socket is up (lib/antiban.js shows it only while the bot is really typing/replying)
            msgRetryCounterCache
        });

        activeSockets[sessionId] = sock;

        // ═══ ANTI-BAN LAYER (lib/antiban.js) ═══
        // Everything the bot sends or relays, every presence update and every group action now passes through the
        // anti-ban engine: per-chat + global rate limits, minimum gaps, duplicate / broadcast guard, cold-chat cap,
        // human-like typing, "online only while active", cool-down on WhatsApp pushback, group-add limits.
        // Options understood on sendMessage: { _noAntiBan: true } = skip the typing simulation only (limits still apply).
        antiban.attach(sock, { sessionId, number: xnumber, privileged: isPrivilegedJid });
        const originalSendMessage = sock.sendMessage.bind(sock);   // already governed by antiban
        // phone-style message ids (only when the library patch is in place, otherwise ids stay as they were)
        const nextMessageId = msgIdPatch === 'patched' ? msgId.makeGenerator(config.MESSAGE_ID_STYLE, xnumber) : null;
        console.log(`🆔 [${xnumber}] message ids: ${nextMessageId ? msgId.styleFor(config.MESSAGE_ID_STYLE, xnumber) : 'unchanged (' + msgIdPatch + ')'}`);
        sock.sendMessage = async (jid, content, options = {}) => {
            if (nextMessageId && !options.messageId && typeof jid === 'string' && !jid.endsWith('@newsletter')) {
                options = { ...options, messageId: nextMessageId() };
            }
            if (options.messageId) rememberBotId(options.messageId);   // known before the echo of our own message can arrive
            const res = await originalSendMessage(jid, content, options);
            if (res && res.key && res.key.id) rememberBotId(res.key.id);
            return res;
        };

        sock.sendFileUrl = async (jid, url, caption, quoted, options = {}) => {
            const r = await axios.head(url);
            const mime = r.headers['content-type'];
            if (mime.split("/")[1] === "gif") return sock.sendMessage(jid, { video: await getBuffer(url), caption, gifPlayback: true, ...options }, { quoted });
            if (mime === "application/pdf") return sock.sendMessage(jid, { document: await getBuffer(url), mimetype: 'application/pdf', caption, ...options }, { quoted });
            if (mime.split("/")[0] === "image") return sock.sendMessage(jid, { image: await getBuffer(url), caption, ...options }, { quoted });
            if (mime.split("/")[0] === "video") return sock.sendMessage(jid, { video: await getBuffer(url), caption, mimetype: 'video/mp4', ...options }, { quoted });
            if (mime.split("/")[0] === "audio") return sock.sendMessage(jid, { audio: await getBuffer(url), caption, mimetype: 'audio/mpeg', ...options }, { quoted });
        };

        sock.edite = async (gg, newmg, from) => {
            await sock.relayMessage(from, { protocolMessage: { key: gg.key, type: 14, editedMessage: { conversation: newmg } } }, {});
        };

        sock.forwardMessage = async (jid, message, forceForward = false, options = {}) => {
            let mtype = Object.keys(message.message)[0];
            let content = await generateForwardMessageContent(message, forceForward);
            let ctype = Object.keys(content)[0];
            let context = mtype !== "conversation" ? message.message[mtype].contextInfo : {};
            content[ctype].contextInfo = { ...context, ...content[ctype].contextInfo };
            const fwdOpts = options ? { ...content[ctype], ...options } : {};
            if (nextMessageId && !fwdOpts.messageId) fwdOpts.messageId = nextMessageId();
            const waMessage = await generateWAMessageFromContent(jid, content, fwdOpts);
            await sock.relayMessage(jid, waMessage.message, { messageId: waMessage.key.id });
            return waMessage;
        };

        // counting / reply-claims for her tool runs (lib/gf/runctx.js) and "new connection" hooks for plugins (e.g. vv.js auto retrieval)
        runctx.instrument(sock);
        for (const hook of events.socketHooks || []) { try { hook(sock); } catch (e) { console.error('[socketHook]', e.message); } }

        let pairingCode = null;
        let responded = false;

        // A session linked with a QR code never gets "registered", but it always has "account" - so check both,
        // otherwise a QR-linked session would be asked for a pairing code again (and broken).
        if (!(sock.authState.creds.registered || sock.authState.creds.account)) {
            try {
                await new Promise(r => setTimeout(r, 3000));
                const wanted = wantedPairCode();
                let fellBack = false;
                try {
                    pairingCode = wanted ? await sock.requestPairingCode(xnumber, wanted) : await sock.requestPairingCode(xnumber);
                } catch (codeErr) {
                    if (!wanted) throw codeErr;
                    fellBack = true;
                    console.log(`⚠️ the custom pairing code was refused (${codeErr && codeErr.message}) - asking WhatsApp for a random one instead`);
                    pairingCode = await sock.requestPairingCode(xnumber);
                }
                if (wanted && !fellBack && String(pairingCode).replace(/[\s-]/g, '').toUpperCase() !== wanted) {
                    console.log(`⚠️ this Baileys version ignored the custom code ${wanted} and made its own: ${pairingCode} - type that one on the phone (or update @dnuzi/baileys)`);
                }
                console.log('🔑 Pairing Code:', pairingCode);
                startPending(sessionId, sessionPath);   // the code is valid for PAIR_TTL_SECONDS (default 1 minute)
                if (res && !res.headersSent) { res.json({ code: pairingCode, expiresIn: Math.round(PAIR_TTL_MS / 1000) }); responded = true; }
            } catch (pairErr) {
                if (res && !res.headersSent) { res.json({ error: 'Pair failed' }); responded = true; }
                cleanupSession(sessionId);
                return;
            }
        } else {
            console.log('Already registered:', sessionId);
            if (res && !res.headersSent) { res.json({ error: 'Already paired.' }); responded = true; }
        }

        if (res && !responded) {
            setTimeout(() => { if (!res.headersSent) res.json({ error: 'Timeout' }); }, 15000);
        }

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            debouncedSaveSession(sessionId, sessionPath);
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (update.isNewLogin) {
                // the phone accepted the code: stop the pairing window and store the fresh credentials right now
                // (the socket is restarted a moment later and has to start from these credentials)
                endPending(sessionId);
                try { await saveCreds(); await saveSession(sessionId, sessionPath); } catch (e) {}
            }
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                const cr = sock.authState.creds;
                const abandoned = pendingPairs.has(sessionId) && !(cr.registered || cr.account);   // a pairing code that was never typed on the phone
                console.log(`Disconnected: ${sessionId} | Code: ${statusCode}`);
                cleanupSession(sessionId);
                if (abandoned) {
                    console.log(`🧹 [${sessionId}] pairing was never finished - unfinished session removed`);
                    await dropPairing(sessionId, sessionPath);
                    return;
                }
                // reconnect policy (lib/antiban.js): exponential back-off + jitter, code aware.
                // (it used to retry every 5s for ever, and two instances with the same session fought each other)
                const plan = antiban.decideReconnect(sessionId, statusCode);
                if (isLoggedOut || plan.action === 'logout') {
                    await Session.findOneAndDelete({ sessionId });
                    await fs.remove(sessionPath);
                } else if (plan.action === 'stop') {
                    console.log(`🛑 [${sessionId}] not reconnecting: ${plan.reason}. Restart the bot (or open /pair?number=${xnumber}) when you are ready.`);
                } else {
                    console.log(`🔁 [${sessionId}] reconnecting in ${Math.round(plan.delayMs / 1000)}s (${plan.reason})`);
                    reconnectTimers[sessionId] = setTimeout(() => Pair(number), plan.delayMs);
                }
            } else if (connection === 'open') {
                console.log('✅ 𝐂onnected:', sessionId);
                console.log('🛡️ Anti-Ban Active (lib/antiban.js)');
                antiban.connectionOpened(sessionId);
                for (const a of qrAttempts.values()) if (a.sessionId === sessionId && !a.done) finishQr(a, 'connected');   // tells the QR page it worked
                // (the old "available every 2 minutes" presence loop is gone: it made the bot look permanently online and
                //  was a very regular, bot-shaped pattern. Presence is now handled around real activity by lib/antiban.js)

                try {
                    const jid = xnumber + '@s.whatsapp.net';
                    await sock.sendMessage(jid, { text: `*Bot Active!*\n\nSHIRO MD is now online.` }, { _noAntiBan: true });
                } catch (e) {}
            }
        });

        const mediaOn = {
            imageMessage: ['image', 'photo'], stickerMessage: ['sticker'], videoMessage: ['video'],
            audioMessage: ['audio'], documentMessage: ['document'], documentWithCaptionMessage: ['document'],
        };

        sock.ev.on('group-participants.update', (update) => {
            try { require('./lib/group-greet').onParticipantsUpdate(sock, update); } catch (e) { console.error(e.message); }
        });

        sock.ev.on('messages.upsert', async (event) => {
            try {
                for (const mek of event.messages) {
                    // each message is isolated: one bad message used to abort the whole batch
                    try { await (async () => {
                    if (!mek.message) return;
                    if (mek.key && mek.key.remoteJid === 'status@broadcast') return;
                    // Typed by a human on the paired number itself (phone / WhatsApp Web of this account) → owner access.
                    // What the bot sent itself ('append' echoes, ids in botSentIds) and the offline queue never count.
                    const ownTyped = !!mek.key.fromMe;
                    if (ownTyped) {
                        if (!OWN.COMMANDS || event.type !== 'notify' || botSentIds.has(mek.key.id)) return;
                        if (!/@(s\.whatsapp\.net|lid|g\.us)$/.test(String(mek.key.remoteJid))) return;
                    }
                    antiban.noteInbound(mek, { own: ownTyped });   // remembers who wrote to the bot (replies vs. cold messaging)

                    // ═══ AUTO-REACT for Trusted Numbers ═══
                    const senderNumForReact = (mek.key.senderPn || mek.key.participant || mek.key.remoteJid).split('@')[0];
                    const trusted = config.TRUSTED_NUMBERS.find(t => t.number === senderNumForReact);
                    if (trusted && !ownTyped) {
                        await sock.sendMessage(mek.key.remoteJid, { react: { text: trusted.react, key: mek.key } }).catch(() => {});
                    }

                    mek.message = (getContentType(mek.message) === 'ephemeralMessage') ? mek.message.ephemeralMessage.message : mek.message;

                    const m = sms(sock, mek);
                    const type = getContentType(mek.message);
                    const from = mek.key.remoteJid;

                    const body =
                        type === 'conversation' ? mek.message.conversation :
                        type === 'extendedTextMessage' ? mek.message.extendedTextMessage.text :
                        type === 'imageMessage' && mek.message.imageMessage?.caption ? mek.message.imageMessage.caption :
                        type === 'videoMessage' && mek.message.videoMessage?.caption ? mek.message.videoMessage.caption :
                        type === 'interactiveResponseMessage' ? (() => { try { return JSON.parse(mek.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson)?.id || ''; } catch { return ''; } })() :
                        type === 'templateButtonReplyMessage' ? mek.message.templateButtonReplyMessage?.selectedId :
                        m.msg?.text || m.msg?.conversation || m.msg?.caption || '';

                    // Accept the main prefix and any EXTRA_PREFIXES (so both "/ytpl" and ".ytpl" work).
                    const prefixList = [config.PREFIX, ...(config.EXTRA_PREFIXES || [])].filter(Boolean);
                    const usedPrefix = prefixList.find(pf => body.startsWith(pf)) || '';
                    const prefix = usedPrefix || config.PREFIX;
                    const wordOf = (str) => str.trim().split(/\s+/).shift().toLowerCase();
                    const rawCommand = usedPrefix ? wordOf(body.slice(usedPrefix.length)) : '';
                    // Only a *known* command counts. "..." or "/something odd" is just chat (the GF talks back).
                    const isCmd = !!usedPrefix && (commandMap.has(rawCommand) || rawCommand === 'ev');   // (/jid is a plugin now: plugins/jid.js)
                    const command = isCmd ? rawCommand : '';
                    const args = isCmd ? body.trim().slice(usedPrefix.length).trim().split(/\s+/).slice(1) : body.trim().split(/\s+/).slice(1);
                    const q = args.join(' ');

                    const isGroup = from.endsWith('@g.us');
                    // own typed: only text (a command or chat) counts - not media without a caption, not protocol messages (revokes, edits ...)
                    if (ownTyped && (!body || type === 'protocolMessage')) return;

                    let sender = mek.key.fromMe ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : (mek.key.senderPn || mek.key.participant || mek.key.remoteJid);
                    const senderNumber = sender.split('@')[0];
                    const senderLid = mek.key.participant ? mek.key.participant.split('@')[0] : null;
                    const botNumber = sock.user.id.split(':')[0];
                    const botNumber2 = await jidNormalizedUser(sock.user.id);
                    const pushname = mek.pushName || 'User';
                    const isMe = botNumber.includes(senderNumber);
                    // "Message yourself": the chat of the paired number with itself (phone number form or @lid form)
                    const selfChat = ownTyped && !isGroup && [botNumber, sock.user.lid ? sock.user.lid.split(':')[0].split('@')[0] : ''].includes(from.split('@')[0].split(':')[0]);

                    const configOwner = config.OWNER_NUMBER ? config.OWNER_NUMBER.replace(/[^0-9]/g, '') : '';
                    const configOwnerLid = config.OWNER_LID ? config.OWNER_LID.replace(/[^0-9]/g, '') : '';

                    const isOwner = isMe || (senderNumber === configOwner) || (senderNumber === configOwnerLid) || (senderLid === configOwner) || (senderLid === configOwnerLid) || (senderNumber === xnumber);

                    let isSudo = false;
                    if (global.sudoList && Array.isArray(global.sudoList)) {
                        isSudo = global.sudoList.some(jid => {
                            const sNum = jid.split('@')[0];
                            return sNum === senderNumber || (senderLid && sNum === senderLid);
                        });
                    }

                    // ═══ MESSAGE CACHE (For Anti-Delete) ═══
                    if (body && !ownTyped) {
                        messageCache.set(mek.key.id, { mek, m, from, sender, body, type });
                        if (messageCache.size > 500) {
                            const firstKey = messageCache.keys().next().value;
                            messageCache.delete(firstKey);
                        }
                    }

                    // ═══ ANTI-DELETE (Detect protocolMessage REVOKE) ═══
                    if (type === 'protocolMessage' && mek.message.protocolMessage?.type === 0) {
                        const revokedId = mek.message.protocolMessage.key?.id;
                        const cached = messageCache.get(revokedId);
                        if (cached && (isOwner || isSudo)) {
                            try {
                                const botJid = xnumber + '@s.whatsapp.net';
                                await sock.sendMessage(botJid, {
                                    text: `🗑️ *ANTI-DELETE*\n\n👤 From: @${cached.sender.split('@')[0]}\n💬 Chat: ${cached.from}\n📝 Type: ${cached.type}\n\n💬 *Content:*\n${cached.body}`,
                                    mentions: [cached.sender]
                                }, { _noAntiBan: true });
                            } catch (e) {}
                        }
                        return;
                    }

                    // ═══ ANTI-BOT ═══
                    if (config.ANTI_BOT && isGroup && !isOwner && !isSudo) {
                        if (isBotMessage(mek, body)) {
                            try {
                                await sock.sendMessage(from, { delete: mek.key });
                                console.log(`🤖 Anti-Bot: Deleted bot message from ${senderNumber}`);
                            } catch (e) {}
                            return;
                        }
                    }

                    // ═══ ANTI-LINK ═══
                    if (config.ANTI_LINK && isGroup && !isOwner && !isSudo) {
                        if (containsLink(body)) {
                            try {
                                await sock.sendMessage(from, { delete: mek.key });
                                await sock.sendMessage(from, { text: `🚫 @${senderNumber} Links not allowed!` }, { mentions: [sender], _noAntiBan: true });
                                console.log(`🔗 Anti-Link: Deleted link from ${senderNumber}`);
                            } catch (e) {}
                            return;
                        }
                    }

                    // ═══ ANTI-COMMAND ═══
                    if (config.ANTI_COMMAND_DELETE && isCmd && config.MODE === 'private' && !isOwner && !isSudo) {
                        try {
                            await sock.sendMessage(from, { delete: mek.key });
                            console.log(`🚫 Anti-Command: Deleted command from ${senderNumber}`);
                        } catch (e) {}
                        return;
                    }

                    let groupMetadata = { subject: 'Unknown', participants: [] };
                    let groupName = 'Unknown';
                    let participants = [];
                    let groupAdmins = [];
                    let isBotAdmins = false;
                    let isAdmins = false;

                    if (isGroup) {
                        try {
                            const now = Date.now();
                            const cached = global.groupCache.get(from);
                            if (cached && (now - cached.timestamp < 30 * 1000)) {
                                groupMetadata = cached.data;
                            } else {
                                groupMetadata = await Promise.race([
                                    sock.groupMetadata(from),
                                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
                                ]);
                                global.groupCache.set(from, { data: groupMetadata, timestamp: now });
                            }
                            
                            groupName = groupMetadata.subject || 'Unknown';
                            participants = groupMetadata.participants || [];

                            const isAdmin = (p) => p.admin === 'admin' || p.admin === 'superadmin';
                            const adminParticipants = participants.filter(isAdmin);
                            groupAdmins = getGroupAdmins(participants);   // was always [] before
                            const botLid = sock.user.lid ? sock.user.lid.split(':')[0] : null;
                            const senderLidGrp = mek.key.participant;
                            const senderPnGrp = mek.key.senderPn;

                            isBotAdmins = adminParticipants.some(p => {
                                const pId = (p.id || '').split('@')[0];
                                const pJid = (p.jid || '').split('@')[0];
                                return pId === botNumber || pJid === botNumber || (botLid && (pId === botLid || pJid === botLid));
                            });

                            isAdmins = adminParticipants.some(p => {
                                const pId = (p.id || '').split('@')[0];
                                const pJid = (p.jid || '').split('@')[0];
                                const matchesSenderLid = (senderLidGrp && (pId === senderLidGrp.split('@')[0] || pJid === senderLidGrp.split('@')[0]));
                                const matchesSenderPn = (senderPnGrp && (pId === senderPnGrp.split('@')[0] || pJid === senderPnGrp.split('@')[0]));
                                return matchesSenderLid || matchesSenderPn;
                            });

                            if (!isAdmins && senderNumber) {
                                isAdmins = adminParticipants.some(p => {
                                    const pId = (p.id || '').split('@')[0];
                                    const pJid = (p.jid || '').split('@')[0];
                                    return pId === senderNumber || pJid === senderNumber;
                                });
                            }
                        } catch (err) {
                            console.log(`⚠️ Group metadata failed for ${from}:`, err.message);
                        }
                    }

                    // SHH AUTO DELETE
                    if (isGroup && !isMe && isBotAdmins && global.shhList && global.shhList[from]) {
                        try {
                            const shhTargets = global.shhList[from];
                            const rawParticipant = mek.key.participant;
                            const isTargeted = Array.isArray(shhTargets) && (
                                shhTargets.includes('ALL') || shhTargets.includes(sender) || shhTargets.includes(rawParticipant) ||
                                shhTargets.some(t => t.split('@')[0] === senderNumber)
                            );
                            if (isTargeted) {
                                await sock.sendMessage(from, { delete: mek.key });
                                return;
                            }
                        } catch (err) {}
                    }

                    // Reply function (Anti-ban handled by wrapper)
                    const reply = async (teks, opts = {}) => {
                        return await sock.sendMessage(from, { text: teks, mentions: (opts && opts.mentions) || [sender] });
                    };

                    // an old command from the offline queue is never answered (after a reconnect they would all be answered in one burst)
                    if (isCmd && antiban.isStale(mek)) return;

                    if (isCmd) {
                        if (config.MODE === 'private' && !isOwner && !isSudo) return;
                        if (config.OWNER_ONLY_COMMANDS && config.OWNER_ONLY_COMMANDS.includes(command) && !isOwner) return;

                        // one person cannot make the bot answer dozens of commands a minute (owner / sudo are exempt)
                        if (!antiban.allowCommand({ sender: senderNumber, privileged: isOwner || isSudo })) return;

                        const now = Date.now();
                        const cooldown = userCooldowns.get(senderNumber) || 0;
                        if (now - cooldown < 2000) return;
                        userCooldowns.set(senderNumber, now);

                        if (!ownTyped) setTimeout(async () => { try { await sock.readMessages([mek.key]); } catch (e) {} }, 500 + Math.random() * 1000);   // (nothing to "read" in a message we typed ourselves)

                        const cmd = commandMap.get(command);
                        if (cmd) {
                            const cmdCtx = {
                                from, prefix, quoted: [], body, isCmd, command, args, q,
                                isGroup, sender, senderNumber, botNumber2, botNumber,
                                pushname, isMe, isOwner, isSudo, groupMetadata, groupName,
                                participants, groupAdmins, isBotAdmins, isAdmins, reply
                            };
                            if (global.gfBrain && global.gfBrain.shouldRedirect(cmd, command, { isOwner, isSudo, isAdmins })) {
                                // GF-only mode: she does it for him, in her own voice (see plugins/gf-brain.js)
                                try { await global.gfBrain.viaGF(sock, mek, m, cmdCtx, cmd, command); }
                                catch (e) { console.error('[GF REDIRECT ERROR]', e); }
                            } else {
                                if (cmd.react) sock.sendMessage(from, { react: { text: cmd.react, key: mek.key } }).catch(() => {});
                                try {
                                    // plugins that ask a question and wait for the reply (ss, manhwa …): remember their messages so she does not answer the reply as chat
                                    if (runctx.wantsClaims(cmd)) await runctx.run({ sent: 0, lastText: '', claim: true }, () => cmd.function(sock, mek, m, cmdCtx));
                                    else await cmd.function(sock, mek, m, cmdCtx);
                                } catch (e) {
                                    console.error('[PLUGIN ERROR]', e);
                                }
                            }
                        }
                    }

                    // own typed messages outside the self-chat only run commands: no GF chat, no watchers on your own words
                    for (const cmd of (ownTyped && !selfChat ? [] : events.commands)) {
                        try {
                            if (body && cmd.on === 'body') {
                                await cmd.function(sock, mek, m, {
                                    from, prefix, quoted: [], body, isSudo, isCmd, command, args, q,
                                    isPre: false, isGroup, sender, senderNumber, botNumber2, botNumber,
                                    pushname, isMe, isOwner, groupMetadata, groupName, participants,
                                    groupAdmins, isBotAdmins, isAdmins, reply, selfChat: selfChat && OWN.SELF_CHAT_GF
                                });
                            } else if (body && cmd.on === 'text') {
                                await cmd.function(sock, mek, m, {
                                    from, prefix, quoted: [], body, isSudo, isCmd, command, args, q, isPre: false,
                                    isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner,
                                    groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply
                                });
                            } else if (cmd.on && cmd.on !== 'body' && cmd.on !== 'text' && mediaOn[type] && mediaOn[type].includes(cmd.on)) {
                                // image / photo / sticker / video / audio / document watchers (antiguard registers all of them)
                                await cmd.function(sock, mek, m, {
                                    from, prefix, quoted: [], body, isSudo, isCmd, command, args, q, isPre: false,
                                    isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner,
                                    groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply
                                });
                            }
                        } catch (e) {}
                    }

                    switch (command) {
                        case 'ev':
                            if (isOwner) {
                                try { reply(util.format(await eval(q))); }
                                catch (err) { reply(util.format(err)); }
                            }
                            break;
                    }
                                    })(); } catch (e) { console.error('[MESSAGE ERROR]', e); }
                }
            } catch (e) {
                console.error('[MESSAGE ERROR]', String(e));
            }
        });

    } catch (err) {
        console.error('Pair Error:', err);
        cleanupSession(sessionId);
        if (res && !res.headersSent) res.json({ error: 'Pair failed: ' + err.message });
    }
}

async function restoreAllSessions() {
    try {
        const sessions = await Session.find();
        console.log(`Restoring ${sessions.length} session(s)...`);
        await Promise.all(sessions.filter(s => s.sessionId).map(async (s, index) => {
            const number = s.sessionId.replace('dina_', '');
            try {
                await new Promise(r => setTimeout(r, index * 500));
                await Pair(number);
            } catch (err) {}
        }));
    } catch (err) {}
}

// ═══════════════════════════════════════════════════════════════════════════
// ═══ QR PAIRING ═══
// Link a device by scanning a QR code instead of typing a number + pairing code.
//   GET /qr/start        -> { id }    starts an attempt (a light socket that only waits for the scan)
//   GET /qr/poll?id=     -> { status, qr, expiresIn, number, error }   (the page draws the QR itself)
//   GET /qr/cancel?id=   -> gives the attempt up
// Until somebody scans, nothing is stored anywhere (temp folder sessions/qr_<id> only). After the scan the session is
// moved to sessions/dina_<number>, saved in MongoDB and started with Pair(number) like any code-paired session.
// status: starting | waiting | scanned | linking | connected | expired | error | cancelled
// ═══════════════════════════════════════════════════════════════════════════
function setQrTimer(a, ms, status, message) {
    clearTimeout(a.timer);
    a.timer = setTimeout(() => finishQr(a, status, message), ms);
}

function finishQr(a, status, message) {
    if (a.done) return;
    a.done = true; a.status = status; a.error = message || null;
    clearTimeout(a.timer); clearTimeout(a.promoteTimer);
    killSocket(a.sock); a.sock = null;
    if (status !== 'connected') fs.remove(a.tmpPath).catch(() => {});   // an unscanned / failed temp session is thrown away
    setTimeout(() => qrAttempts.delete(a.id), 2 * 60 * 1000);           // the page can still read the final status for a while
}

async function runQrSocket(a) {
    await fs.ensureDir(a.tmpPath);
    const { state, saveCreds } = await useMultiFileAuthState(a.tmpPath);
    const { version } = await fetchLatestBaileysVersion();
    if (a.done) return;   // cancelled while it was getting ready
    const logger = pino({ level: 'silent' });
    const sock = makeWASocket({
        version, logger,
        browser: ["Ubuntu", "Chrome", "110.0.5481.77"],
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        printQRInTerminal: false,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 30000,
        keepAliveIntervalMs: 30000,
        markOnlineOnConnect: false,
        msgRetryCounterCache
    });
    a.sock = sock; a.saveCreds = saveCreds;

    sock.ev.on('creds.update', () => { saveCreds().catch(() => {}); });
    sock.ev.on('connection.update', (u) => {
        if (a.done) return;
        if (u.qr) {
            if (a.status === 'starting') {
                a.status = 'waiting';
                a.expiresAt = Date.now() + PAIR_TTL_MS;   // the 1-minute window starts when the first QR is ready
                setQrTimer(a, PAIR_TTL_MS + 1000, 'expired', 'The QR code expired.');
                console.log(`📷 QR ready - valid for ${Math.round(PAIR_TTL_MS / 1000)}s`);
            }
            if (a.status === 'waiting') a.qr = u.qr;   // WhatsApp may hand out a newer QR while we wait
        }
        if (u.isNewLogin) {
            a.status = 'scanned'; a.qr = null;
            setQrTimer(a, 90000, 'error', 'Linking took too long. Please try again.');
            a.promoteTimer = setTimeout(() => promoteQr(a), 15000);   // normally the "restart required" close below does this within a second
        }
        if (u.connection === 'close') {
            const code = u.lastDisconnect?.error?.output?.statusCode;
            const c = sock.authState.creds;
            if (c.account && c.me && c.me.id) return promoteQr(a);   // scanned: WhatsApp restarts the connection (515) - carry on with a fresh socket
            if (code === DisconnectReason.timedOut) finishQr(a, 'expired', 'The QR code expired.');
            else finishQr(a, 'error', `WhatsApp closed the connection (${code || 'unknown'}). Please try again.`);
        }
    });
}

// the QR was scanned: move the temp session to dina_<number>, store it, start the real bot on it
async function promoteQr(a) {
    if (a.done || a.promoting) return;
    a.promoting = true;
    clearTimeout(a.promoteTimer);
    try {
        try { await a.saveCreds(); } catch (e) {}
        const me = a.sock && a.sock.authState && a.sock.authState.creds && a.sock.authState.creds.me;
        const number = me && me.id ? String(jidNormalizedUser(me.id)).split('@')[0].replace(/[^0-9]/g, '') : '';
        if (!number) throw new Error('WhatsApp did not say which number was linked');
        killSocket(a.sock); a.sock = null;   // the temp socket has done its job
        const sessionId = `dina_${number}`;
        const sessionPath = path.join(SESSION_BASE_PATH, sessionId);
        if (activeSockets[sessionId]) cleanupSession(sessionId);   // linking the same number again replaces the running session
        endPending(sessionId);
        await Session.findOneAndDelete({ sessionId });             // an older stored session of this number is replaced
        await fs.remove(sessionPath);
        await fs.move(a.tmpPath, sessionPath);
        for (const k of Object.keys(fileCache)) if (k.startsWith(sessionId + ':')) delete fileCache[k];
        await saveSession(sessionId, sessionPath);                 // MongoDB first: Pair() restores from there
        a.number = number; a.sessionId = sessionId; a.status = 'linking';
        console.log(`📷 QR linked: ${number} - starting the bot`);
        await Pair(number);                                        // finishQr(a, 'connected') is called when it opens
    } catch (e) {
        console.error('QR link error:', e);
        finishQr(a, 'error', 'The phone linked, but the bot could not start: ' + e.message);
    }
}

app.get('/qr/start', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if ([...qrAttempts.values()].filter(a => !a.done).length >= MAX_QR_ATTEMPTS) {
        return res.json({ error: 'Too many QR codes are open right now. Try again in a minute.' });
    }
    const id = crypto.randomBytes(9).toString('hex');
    const a = {
        id, tmpPath: path.join(SESSION_BASE_PATH, `qr_${id}`), status: 'starting', qr: null, number: null, sessionId: null,
        error: null, expiresAt: 0, done: false, promoting: false, sock: null, saveCreds: null, timer: null, promoteTimer: null
    };
    qrAttempts.set(id, a);
    setQrTimer(a, 30000, 'error', 'WhatsApp did not send a QR code in time. Please try again.');
    runQrSocket(a).catch(e => { console.error('QR socket error:', e && e.message); finishQr(a, 'error', 'Could not reach WhatsApp. Please try again.'); });
    res.json({ id });
});

app.get('/qr/poll', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const a = qrAttempts.get(String(req.query.id || ''));
    if (!a) return res.json({ status: 'expired', error: 'This QR session is gone. Get a new one.' });
    const waiting = a.status === 'waiting';
    res.json({
        status: a.status,
        qr: waiting ? a.qr : null,
        expiresIn: waiting ? Math.max(0, Math.ceil((a.expiresAt - Date.now()) / 1000)) : 0,
        number: a.number,
        error: a.error
    });
});

app.all('/qr/cancel', (req, res) => {   // (all: the page also calls it with sendBeacon when the tab is closed)
    const a = qrAttempts.get(String(req.query.id || ''));
    if (a && (a.status === 'starting' || a.status === 'waiting')) finishQr(a, 'cancelled', 'Cancelled.');
    res.json({ ok: true });
});

app.get('/pair', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.json({ error: 'Number required' });
    res.setTimeout(30000, () => { if (!res.headersSent) res.json({ error: 'Timeout' }); });
    await Pair(number, res);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const ngrok = require("@ngrok/ngrok");

app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await fs.ensureDir(SESSION_BASE_PATH);
    try { for (const d of await fs.readdir(SESSION_BASE_PATH)) if (d.startsWith('qr_')) await fs.remove(path.join(SESSION_BASE_PATH, d)); } catch (e) {}   // temp QR sessions left behind by a crash
    await restoreAllSessions();
    try {
        const listener = await ngrok.forward({ addr: PORT, authtoken_from_env: true });
        console.log(`\n======================================================`);
        console.log(`🌐 Ngrok URL: ${listener.url()}`);
        console.log(`======================================================\n`);
    } catch (e) {
        console.error("❌ Ngrok Error:", e.message);
    }
});

process.on('uncaughtException', (err) => {
    const e = String(err);
    if (e.includes('Socket connection timeout') || e.includes('rate-overlimit') || e.includes('Connection Closed') || e.includes('Value not found')) return;
    console.log('Caught exception:', err);
});

['SIGINT', 'SIGTERM'].forEach(signal => {
    process.on(signal, async () => {
        for (const sessionId in activeSockets) {
            if (pendingPairs.has(sessionId)) continue;   // an unfinished pairing is not worth saving
            try { await saveSession(sessionId, path.join(SESSION_BASE_PATH, sessionId)); } catch (e) {}
        }
        process.exit(0);
    });
});
