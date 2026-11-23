// plugins/wormgpt.js
//
//   .wormgpt <question>      (aliases: .worm  .wgpt)
//   or reply to any message with  .wormgpt
//
// All-language support
//  • Non-Latin scripts (Sinhala, Tamil, Hindi, Arabic, Thai, Chinese ...):
//      question -> English (Google Translate) -> WormGPT API -> answer -> user's language
//    The API writes very poor Sinhala/Tamil itself, but its English is fine.
//  • English / Latin-script text (incl. Singlish): sent straight to the API.
//  • If translation is unavailable the bot falls back to asking the API directly.
//
// Needs Node 18+ (built-in fetch). No extra npm packages.

const { cmd } = require('../command');

const API_URL     = 'https://apix.wolvarex.com/api/ai/wormgpt';
const API_KEY     = process.env.WORM_API_KEY || 'wxa_f_00f9396caa'; // never commit the real key
const GT_URL      = 'https://translate.googleapis.com/translate_a/single'; // free, unofficial
const COOLDOWN_MS = 5000;  // per-user anti-spam
const MAX_INPUT   = 600;   // both services are GET requests, so keep the URL short
const CHUNK_SIZE  = 1000;  // max characters per translate request

const LANG_HINT =
    'Answer in the same language and script the user writes in, unless they ask for another language.\n\n';
const NON_LATIN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
const lastUsed  = new Map();

// ---------- WormGPT API ----------
async function askWorm(prompt) {
    if (!API_KEY || API_KEY === 'YOUR_API_KEY_HERE') throw new Error('WORM_API_KEY is not set');

    const url = new URL(API_URL);
    url.searchParams.set('q', prompt);   // URLSearchParams handles UTF-8 encoding
    url.searchParams.set('key', API_KEY);

    const res  = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.status || !data.result) {
        throw new Error(data.message || data.error || `API error (HTTP ${res.status})`);
    }
    return String(data.result).trim();
}

// ---------- Google Translate (free endpoint) ----------
// response: [ [ [translated, original, ...], ... ], null, detectedLang, ... ]
async function translate(text, to, from = 'auto') {
    const qs  = new URLSearchParams({ client: 'gtx', sl: from, tl: to, dt: 't', q: text });
    const res = await fetch(`${GT_URL}?${qs}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`translate HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.[0])) throw new Error('unexpected translate response');
    return { text: data[0].map(s => s?.[0] ?? '').join(''), lang: data[2] };
}

// split on sentence / line boundaries so every piece stays under `max` characters
function chunkText(text, max = CHUNK_SIZE) {
    const pieces = text.match(/[^.!?\n]+[.!?]*\s*|\n+|[.!?]+\s*/g) || [text];
    const chunks = [];
    let cur = '';
    for (let piece of pieces) {
        while (piece.length > max) {                 // one huge sentence: hard split
            if (cur) { chunks.push(cur); cur = ''; }
            chunks.push(piece.slice(0, max));
            piece = piece.slice(max);
        }
        if (cur && (cur + piece).length > max) { chunks.push(cur); cur = ''; }
        cur += piece;
    }
    if (cur) chunks.push(cur);
    return chunks;
}

async function translateLong(text, to) {
    let out = '';
    for (const chunk of chunkText(text)) out += (await translate(chunk, to, 'en')).text;
    return out;
}

// ---------- main flow ----------
async function answer(input) {
    let lang = null, english = null;

    if (NON_LATIN.test(input)) {
        try {
            const t = await translate(input, 'en');
            if (t.lang && t.lang !== 'en' && t.text.trim()) { lang = t.lang; english = t.text; }
        } catch (e) {
            console.error('[wormgpt] translate-in failed:', e.message);
        }
    }

    // English / Latin script / translation unavailable -> ask the API directly
    if (!lang) return askWorm(LANG_HINT + input);

    const reply = await askWorm(english);            // API errors propagate to the command
    try {
        return await translateLong(reply, lang);
    } catch (e) {
        console.error('[wormgpt] translate-out failed, sending English reply:', e.message);
        return reply;
    }
}

// WhatsApp bold is *text*, not **text**
const toWhatsApp = (t) => t.replace(/\*\*\s*([^*]+?)\s*\*\*/g, '*$1*');

// text of the message the user replied to (raw Baileys structure, works in any bot base)
function getQuotedText(mek) {
    const qm = mek.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    return qm?.conversation
        || qm?.extendedTextMessage?.text
        || qm?.imageMessage?.caption
        || qm?.videoMessage?.caption
        || '';
}

cmd({
    pattern: 'wormgpt',
    alias: ['worm', 'wgpt'],
    desc: 'WormGPT AI chat (all languages supported)',
    category: 'ai',
    use: '.wormgpt <question>',
    filename: __filename,
    // [gf-integration] an uncensored AI should not be open to every stranger (or minor) who talks to her:
    // only the owner may use it (typed or by asking her). Change perm to 'any' to open it up.
    gf: { perm: 'owner', confirm: false, marker: false, hint: 'uncensored AI chat' },
}, async (conn, mek, m, { from, q }) => {
    const send  = (text)  => conn.sendMessage(from, { text }, { quoted: mek });
    const react = (emoji) => conn.sendMessage(from, { react: { text: emoji, key: mek.key } });

    const input = (q || getQuotedText(mek) || '').trim().slice(0, MAX_INPUT);
    if (!input) {
        return send(
            '🪱 *WormGPT* – ask in any language\n\n' +
            '.wormgpt AI කියන්නේ මොකක්ද?\n' +
            '.wormgpt AI என்றால் என்ன?\n' +
            '.wormgpt AI क्या है?\n' +
            '.wormgpt What is AI?\n\n' +
            '_You can also reply to a message with .wormgpt_'
        );
    }

    const sender = mek.key.participant || from;
    const wait   = COOLDOWN_MS - (Date.now() - (lastUsed.get(sender) || 0));
    if (wait > 0) return send(`⏳ Please wait ${Math.ceil(wait / 1000)}s before asking again.`);
    lastUsed.set(sender, Date.now());

    try {
        await react('⏳');
        await send(toWhatsApp(await answer(input)));
        await react('✅');
    } catch (err) {
        console.error('[wormgpt]', err.message);
        await react('❌');
        await send('❌ Could not get a reply from the API. Please try again later.');
    }
});
