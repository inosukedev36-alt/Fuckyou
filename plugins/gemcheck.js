'use strict';
/**
 * plugins/gemcheck.js — .gemcheck : tells (from WhatsApp) whether the Gemini cookies in lib/Geminicook.txt work.
 * Owner only. Cookie values are never sent to the chat — only names, counts and a verdict.
 *
 *   .gemcheck          full test: cookie file → Google login → real chat → chat memory → resumes the web path
 *   .gemcheck status   quick look at the girlfriends' Gemini-web state (conversations, cool-down, last error)
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { cmd } = require('../command');

let webchat = null;
try { webchat = require('../lib/gf/webchat'); } catch { /* optional */ }

const LIB = path.join(__dirname, '..', 'lib');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MUST = ['SID', '__Secure-1PSID', '__Secure-3PSID', 'SAPISID', '__Secure-1PSIDTS', '__Secure-3PSIDTS'];

async function loadGem() {
    let err;
    for (const f of ['gemini.mjs', 'gemini.js']) {
        try { return await import(pathToFileURL(path.join(LIB, f)).href); } catch (e) { err = e; }
    }
    throw err;
}

const ago = (ms) => ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${(ms / 3_600_000).toFixed(1)} h`;

async function runCheck() {
    const out = [];
    const ok = (m) => out.push(`✅ ${m}`);
    const bad = (m) => out.push(`❌ ${m}`);
    const info = (m) => out.push(`ℹ️ ${m}`);
    const done = (good, verdict) => ({ good, text: `${out.join('\n')}\n\n${good ? '🟢' : '🔴'} *${verdict}*` });

    let gem;
    try { gem = await loadGem(); }
    catch (e) { bad(`lib/gemini.mjs load වුණේ නැහැ: ${e.message}`); return done(false, 'Module error'); }

    // 1) cookie file
    out.push('*1) Cookie file*');
    const file = path.join(LIB, 'Geminicook.txt');
    if (process.env.GEMINI_COOKIES) info('GEMINI_COOKIES (.env) පාවිච්චි කරනවා');
    else {
        try {
            const st = fs.statSync(file);
            info(`lib/Geminicook.txt — ${st.size} bytes, ${ago(Date.now() - st.mtimeMs)} කලින් save කළා`);
            if (Date.now() - st.mtimeMs > 6 * 3_600_000) info('file එක පැය ගණනක් පරණයි — Google cookies rotate කරන නිසා ඒවා ඉක්මනින් කැඩෙන්න පුළුවන්');
        } catch { bad('lib/Geminicook.txt හොයාගන්න බැහැ'); }
    }
    const cookie = await gem.loadCookiesFromFile();
    if (!cookie) return done(false, 'Cookies නැහැ');
    const names = cookie.split(';').map((c) => c.trim().split('=')[0]).filter(Boolean);
    ok(`cookies ${names.length}ක් (${cookie.length} අකුරු)`);
    const miss = MUST.filter((n) => !names.includes(n));
    if (miss.length) bad(`වැදගත් cookies නැහැ: ${miss.join(', ')}`); else ok('වැදගත් login cookies ඔක්කොම තියෙනවා');

    // 2) Google + login
    out.push('\n*2) Google සම්බන්ධතාව / login*');
    let res, html = '';
    try {
        res = await fetch('https://gemini.google.com/app', { redirect: 'manual', headers: { 'User-Agent': UA, Cookie: cookie }, signal: AbortSignal.timeout(15000) });
        html = await res.text();
    } catch (e) {
        const code = e.cause?.code || e.cause?.errors?.[0]?.code || e.name;
        bad(`gemini.google.com වෙත සම්බන්ධ වෙන්න බැහැ (${code}) — මේක network ප්‍රශ්නයක්, cookies නෙවෙයි`);
        return done(false, 'Network block');
    }
    const loc = res.headers.get('location') || '';
    info(`HTTP ${res.status}${loc ? ' → ' + loc.replace(/\?.*$/, '').slice(0, 60) : ''}`);
    const signedOut = /accounts\.google\.com/i.test(loc) || /ServiceLogin|accounts\.google\.com\/(v3\/)?signin/i.test(html);
    if (signedOut) { bad('Google sign-in page එකට redirect වෙනවා → cookies expire වෙලා'); return done(false, 'Cookies EXPIRED — අලුත් ඒවා දාන්න'); }
    if (!html.includes('SNlM0e')) { bad('Page එක ආවා, ඒත් access token නැහැ → cookies Gemini වලට වලංගු නැහැ'); return done(false, 'Cookies වැඩ නැහැ'); }
    ok('login වෙලා තියෙනවා (access token හම්බුණා)');

    // 3) real chat + memory
    out.push('\n*3) සැබෑ chat එකක් සහ memory*');
    gem.clearSessionCache();
    const chat = gem.createSession({ language: 'en' });
    try {
        const a = await chat.send('My secret number is 4821. Reply with just the word OK.');
        if (!a.text) throw new Error('empty reply');
        ok(`reply 1: ${a.text.replace(/\s+/g, ' ').slice(0, 60)}`);
        const b = await chat.send('What is my secret number? Answer with the number only.');
        ok(`reply 2: ${b.text.replace(/\s+/g, ' ').slice(0, 60)}`);
        if (!/4821/.test(b.text)) { bad('Gemini කලින් පණිවිඩය මතක තියාගත්තේ නැහැ'); return done(false, 'Cookies වැඩ, ඒත් chat memory නැහැ'); }
        ok('කලින් පණිවිඩය මතකයි — user කෙනෙක්ට එක chat එකක් වැඩ කරනවා');
    } catch (e) {
        bad(`chat එක fail: ${e.message}`);
        return done(false, 'Login හරි, ඒත් chat request එක fail');
    }

    if (webchat) { webchat.retry(); info('Girlfriends ගේ Gemini-web නැවත ක්‍රියාත්මක කළා (cool-down අයින් කළා)'); }
    return done(true, 'Cookies වැඩ! 🎉');
}

let running = false;

cmd({
    pattern: 'gemcheck',
    alias: ['cookiecheck', 'gcheck'],
    desc: 'Gemini cookies වැඩ ද කියලා බලන්න (owner only)',
    category: 'owner',
    react: '🔎',
    filename: __filename,
}, async (conn, mek, m, { q, reply, isOwner }) => {
    if (!isOwner) return reply('❌ Owner ට විතරයි.');

    if (/^status$/i.test((q || '').trim())) {
        if (!webchat) return reply('webchat module එක load වෙලා නැහැ.');
        const s = webchat.status();
        return reply(
            `🌐 *Gemini-web status*\n\n` +
            `• ක්‍රියාත්මකද: ${s.enabled ? 'ඔව්' : 'නැහැ (GF_WEB=0)'}\n` +
            `• ක්‍රියාත්මක chats: ${s.conversations}\n` +
            `• Pause: ${s.downForMs ? Math.ceil(s.downForMs / 60_000) + ' min (ai.dnuz.top පාවිච්චි කරනවා)' : 'නැහැ'}\n` +
            `• අන්තිම error: ${s.lastError || '-'}`
        );
    }

    if (running) return reply('⏳ Check එකක් දැනටමත් ධාවනය වෙනවා.');
    running = true;
    try {
        await reply('🔎 Cookies පරීක්ෂා කරනවා... (තත්පර 10-30ක් යනවා)');
        const r = await runCheck();
        await reply(r.text);
    } catch (e) {
        await reply(`❌ Check එක කැඩුණා: ${e.message}`);
    } finally {
        running = false;
    }
});
