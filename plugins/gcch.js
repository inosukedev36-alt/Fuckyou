// plugins/gcch.js — /gcch : do the Gemini cookies work?   (owner only)
//
//   /gcch        cookies found? · does Google accept them? · one real test message
//   /gcch mem    the same + a second message in the SAME conversation (does Gemini remember the first? = her memory)
//
// It makes real calls to Gemini (lib/gf/ai.js → check()). Nothing secret is ever printed: only cookie NAMES, counts and timings.
// Every failure is shown WITH its codes:  [NETWORK · ECONNRESET] · [AUTH · HTTP 302] · [HTTP 500] · [TIMEOUT] · [TypeError · UND_ERR_…]
//   first = what kind of failure (AUTH, NETWORK, HTTP, TIMEOUT, RATE_LIMIT, EMPTY, NO_COOKIES, BAD_INPUT), then the low-level code, then the HTTP status.
// No `use:` line on purpose: she must never start this one herself (and `gf: false` keeps it that way).
const path = require('path');
const { cmd } = require('../command');
const AI = require('../lib/gf/ai');

const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
const tick = (ok) => (ok ? '✅' : '❌');
const clock = (iso) => {
    try { return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
};

const ago = (s) => (s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)}h ago`);
const shown = (x) => `${AI.tagOf(x)} ${x.message}`;          // "[NETWORK · ECONNRESET] read ECONNRESET"

function where(source) {
    if (!source || source.startsWith('env ')) return source;
    const rel = path.relative(process.cwd(), source);
    return rel && !rel.startsWith('..') ? rel : source;
}

// what to do, by the failure (Sinhala, short): the low-level code first, then the kind
function advice(x) {
    const sys = String(x.sys || '');
    if (/HEADERS?_OVERFLOW/i.test(sys)) {
        return 'Google ගේ response headers ලොකු වැඩියි. අලුත් lib/gemini.js එක (https.request + header limit 256KB) දාලාද බලන්න; තාමත් එනවා නම් GEMINI_MAX_HEADER_BYTES=1048576 දාන්න.';
    }
    if (/^(ENOTFOUND|EAI_AGAIN)$/.test(sys)) return 'DNS error → server එකට gemini.google.com හොයාගන්න බෑ. internet / DNS බලන්න.';
    if (x.code === 'AUTH' && /SNlM0e|WIZ_global_data/.test(String(x.message))) {
        return 'Google ඒ cookies ලොග් වුණු ඒවා විදිහට සලකන්නේ නෑ (signed-out page එකක් එනවා) → cookies මැරිලා / Google block කරලා. විසඳුම: incognito window එකක gemini.google.com එකේ login වෙලා cookies export කරන්න, ඊට පස්සේ ඒ window එක log out නොකර close කරලා lib/Geminicook.txt replace කරන්න (browser එකෙන් ආයෙ rotate නොවෙන්න). Restart ඕනේ නෑ, ආයෙ /gcch කරන්න.';
    }
    switch (x.code) {
        case 'BAD_INPUT':
            return 'cookies වල header එකකට දාන්න බැරි character එකක් තියෙනවා. lib/Geminicook.txt එක ආයෙ copy කරන්න.';
        case 'NO_COOKIES':
            return 'cookies නෑ → lib/Geminicook.txt හදන්න (Cookie header / cookies.txt / JSON export), නැත්නම් GEMINI_COOKIES / GEMINI_COOKIE_FILE දාන්න.';
        case 'AUTH':
            return 'Google ඒ cookies පිළිගන්නේ නෑ (expire වෙලා / logout වෙලා). gemini.google.com එකේ login වෙච්ච browser එකකින් අලුත් cookies export කරලා lib/Geminicook.txt replace කරන්න. Restart ඕනේ නෑ, ආයෙ /gcch කරන්න.';
        case 'RATE_LIMIT':
            return 'Google rate-limit කරනවා (ඔය account එක / IP එක). ටිකක් ඉඳලා ආයෙ try කරන්න.';
        case 'TIMEOUT':
        case 'NETWORK':
            return 'Google වෙත ගිහින් එන්න බැරි වුණා (timeout / network). server එකේ internet එක බලන්න.';
        case 'EMPTY':
            return 'Gemini හිස් answer එකක් දුන්නා. ආයෙ /gcch කරලා බලන්න; නැවත නැවත එහෙමයි නම් cookies අලුත් කරන්න.';
        default:
            return 'Gemini request එක fail වුණා. ඉහළ error එක බලන්න, නැත්නම් ටිකකින් ආයෙ try කරන්න.';
    }
}

function format(r) {
    const L = ['🍪 *Gemini cookies check*', ''];
    const c = r.cookies;

    if (r.fatal) {
        L.push(`❌ ${shown(r.fatal)}`);
        L.push('', 'ඇය දැන් ai.dnuz.top endpoint එකෙන් විතරක් උත්තර දෙනවා.');
        return L.join('\n');
    }

    // 1) cookies
    if (!c || !c.count) {
        L.push('📄 Cookies: ❌ none found');
    } else {
        const age = c.ageHours == null ? '' : ` · file ${c.ageHours >= 48 ? `${Math.round(c.ageHours / 24)} days` : `${c.ageHours}h`} old`;
        L.push(`📄 Cookies: ✅ ${c.count} found · ${where(c.source)}${age}`);
        L.push('   ' + Object.entries(c.has).map(([n, ok]) => `${n} ${tick(ok)}`).join('  '));
    }
    // 2) login, 3) test message, 4) memory
    if (r.login) L.push(r.login.ok ? `🔑 Login: ✅ accepted (${sec(r.login.ms)})` : `🔑 Login: ❌ ${shown(r.login)}`);
    if (r.ping) L.push(r.ping.ok ? `💬 Test message: ✅ "${r.ping.text}" (${sec(r.ping.ms)})` : `💬 Test message: ❌ ${shown(r.ping)}`);
    if (r.memory) {
        if (r.memory.ok) L.push(`🧠 Memory: ✅ it remembered "${r.memory.word}" in the same conversation (${sec(r.memory.ms)})`);
        else if (r.memory.code) L.push(`🧠 Memory: ❌ ${shown(r.memory)}`);
        else L.push(`🧠 Memory: ❌ ${r.memory.sameThread ? 'same conversation, but it forgot the word' : 'Gemini started a NEW conversation instead of continuing'}`);
    }

    // the route she really uses right now
    const rt = r.route || {};
    L.push('');
    L.push(`⚙️ Route: ${rt.mode || '?'} · conversations ${rt.threads ? 'ON' : 'OFF'} (${rt.conversations || 0} active) · cookie route ${rt.cookieRouteSleeping ? `😴 sleeping until ${clock(rt.sleepsUntil)}` : 'awake'}`);
    if (rt.mode === 'endpoint') L.push('⚠️ GF_AI=endpoint → the bot ignores the cookies, whatever this test says.');
    if (rt.lastError) L.push(`⚠️ Last error while chatting (${ago(rt.lastError.agoSec)}): ${rt.lastError.tag} ${rt.lastError.message}`);

    // the keep-alive: rotates the cookies every few minutes so they do not go stale
    const ka = r.keepAlive;
    if (ka) {
        L.push(!ka.enabled ? '🔄 Keep-alive: OFF (GEMINI_ROTATE=off)'
            : ka.error ? `🔄 Keep-alive: ⚠️ rotation failed (${ago(ka.error.agoSec)}): ${shown(ka.error)}`
            : ka.lastOkAgoSec != null ? `🔄 Keep-alive: ✅ cookies rotated ${ago(ka.lastOkAgoSec)} (every ${ka.everyMin} min)`
            : ka.running ? `🔄 Keep-alive: on, the first rotation comes within a minute (then every ${ka.everyMin} min)`
            : '🔄 Keep-alive: starts after the first successful login');
    }

    // verdict
    L.push('');
    const bad = !c || !c.count ? { code: 'NO_COOKIES' } : r.login && !r.login.ok ? r.login : r.ping && !r.ping.ok ? r.ping : null;
    if (bad) {
        L.push(`❌ ${advice(bad)}`);
        L.push('ඒ වෙනකම් ඇය ai.dnuz.top endpoint එකෙන් උත්තර දෙනවා.');
    } else {
        L.push('✅ Cookies හරි, ඇයට උත්තර දෙන්නේ Gemini.');
        if (r.healed) L.push('(cookie route නිදාගෙන හිටියා, දැන් ආයෙ ඇහැරුවා.)');
        if (r.memory && !r.memory.ok && !r.memory.code) L.push('⚠️ Gemini conversation එක continue වෙන්නේ නෑ → ඇය chat history එක prompt එකේම යවනවා (auto).');
        if (!r.memory) L.push('ඇගේ memory එකත් test කරන්න: /gcch mem');
    }
    return L.join('\n');
}

let busy = false;

cmd({
    pattern: 'gcch',
    desc: 'Check that the Gemini cookies work (owner only). "/gcch mem" also tests her memory',
    category: 'owner',
    react: '🍪',
    gf: false,
    filename: __filename,
}, async (conn, mek, m, { args, isOwner, reply }) => {
    if (!isOwner) return reply('🔒 This command is only for the bot owner.');
    if (busy) return reply('⏳ A cookie check is already running, one moment...');
    busy = true;
    try {
        const memory = /^(mem|memory|full)$/i.test(String((args && args[0]) || ''));
        await reply(format(await AI.check({ memory })));
    } catch (e) {
        console.error('[gcch]', e);
        await reply(`❌ The check itself crashed: ${shown(AI.errInfo(e))}`);
    } finally {
        busy = false;
    }
});
