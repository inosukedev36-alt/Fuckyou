'use strict';
// Run:  node --test test/newplugins.test.js
// The plugins that were added / updated from the user's upload: ss, manhwa, wormgpt, jid, vv, ytaudl (+ytvcdl), anime-calendar, vv-antidel.
process.env.GF_FAST = '1';
process.env.GF_NO_DB = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');

const config = require('../config');
const events = require('../command');

const errors = [];
const before = events.commands.length;
const _log = console.log; console.log = () => {};
// (anime-calendar.js is not loaded here: it starts a node-cron timer at load time, which would keep the test process alive)
for (const f of ['ss', 'manhwa', 'wormgpt', 'jid', 'vv', 'ytaudl', 'vv-antidel', 'playlist_links']) {
    try { require('../plugins/' + f); } catch (e) { errors.push(`${f}: ${e.message}`); }
}
require('../plugins/gf-brain');
console.log = _log;

const registry = require('../lib/gf/registry');
const tools = require('../lib/gf/tools');
const byName = new Map(); for (const c of events.commands) if (c.pattern) byName.set(c.pattern, c);
const sync = () => registry.sync(events.commands, config, { log() {} });

test('every new / updated plugin loads (also without pdf-lib, which is not installed here)', () => {
    assert.deepEqual(errors, []);
    for (const name of ['ss', 'manhwa', 'wormgpt', 'jid', 'vv', 'vvjid', 'ytaudl', 'ytvcdl', 'antidelete', 'plinks']) assert.ok(byName.has(name), name + ' is registered');
    const cal = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'anime-calendar.js'), 'utf8');
    assert.match(cal, /pattern:\s*['"]todayanime['"]/, 'anime-calendar.js still provides todayanime');
    assert.deepEqual(byName.get('wormgpt').alias, ['worm', 'wgpt']);
    assert.deepEqual(byName.get('vv').alias, ['viewonce', 'retrieve']);
});

test('no command name is registered twice (jid: plugin now, no built-in in pair.js; vv: only plugins/vv.js)', () => {
    const seen = new Map();
    for (const c of events.commands.slice(before)) {
        if (c.on) continue;
        for (const n of [c.pattern, ...(c.alias || [])].filter(Boolean)) { if (!seen.has(n)) seen.set(n, []); seen.get(n).push(c.filename); }
    }
    const dup = [...seen].filter(([, v]) => v.length > 1).map(([n]) => n);
    assert.deepEqual(dup.filter(n => !['remove'].includes(n)), [], 'duplicates');
    const pair = fs.readFileSync(path.join(__dirname, '..', 'pair.js'), 'utf8');
    assert.ok(!/case 'jid'/.test(pair), 'the old built-in jid case is gone');
    assert.ok(!/downloadContentFromMessage|retrieveViewOnce/.test(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'vv-antidel.js'), 'utf8')), 'the old vv code left vv-antidel.js');
});

test('what she is allowed to do with them', () => {
    sync(); const T = tools.TOOLS;
    assert.deepEqual([T.ss.auto, T.ss.arg, T.ss.req, T.ss.perm, T.ss.marker], [true, 'url', true, 'any', true], 'ss: a link, anybody, the AI may start it');
    assert.ok(T.ss.keywords.test('please take a screenshot of this site'));
    assert.ok(tools.route({ text: 'ස්ක්‍රීන්ෂොට් එකක් ඕනේ https://example.com', isGroup: false }).tool === 'ss', 'Sinhala keyword, typed with and without the invisible joiner');
    assert.ok(tools.route({ text: 'ස්ක්රීන්ෂොට් එකක් ඕනේ https://example.com', isGroup: false }).tool === 'ss');
    assert.deepEqual([T.wormgpt.auto, T.wormgpt.perm, T.wormgpt.confirm, T.wormgpt.marker], [true, 'owner', false, false], 'the uncensored AI: owner only');
    assert.equal(T.manhwa, undefined, 'the adult-content downloader is never one of her tools');
    assert.ok(registry.describe().skipped.some(s => s.name === 'manhwa' && /opted out/.test(s.reason)));
    assert.ok(T.jid && !T.jid.auto, 'jid: built-in meta (its use: line lists several forms, so it must not be guessed)');
    assert.equal(T.jid.arg, 'raw');
    assert.deepEqual([T.vv.perm, T.vv.quoted], ['owner', 1], 'vv now saves to the bot inbox → owner only');
    assert.deepEqual([T.ytvcdl.arg, T.ytvcdl.req], ['url', 1]);
    assert.equal(T.vvjid, undefined);
    assert.ok(config.GF.NL_BLOCKED.includes('manhwa'));
});

test('router: screenshot, voice notes, jid, wormgpt', () => {
    sync();
    const r = (text, extra = {}) => tools.route({ text, isGroup: false, ...extra });
    assert.deepEqual([r('take a screenshot of example.com').tool, r('take a screenshot of example.com').arg], ['ss', 'https://example.com']);
    assert.equal(r('screenshot https://example.com/a?b=1').arg, 'https://example.com/a?b=1');
    assert.equal(r('ස්ක්‍රීන්ෂොට් එකක් දෙන්න').missing, 'url');
    assert.equal(r('I took a screenshot yesterday and it was nice to see everything again, haha lol'), null, 'a story about screenshots is not a request');
    const v = r('මේ playlist එක voice notes විදියට දෙන්න https://www.youtube.com/playlist?list=PLabc123');
    assert.deepEqual([v.tool, v.missing], ['ytvcdl', null]);
    assert.equal(r('voice note https://youtu.be/dQw4w9WgXcQ').tool, 'ytvcdl');
    assert.equal(r('song mp3 https://youtu.be/dQw4w9WgXcQ').tool, 'ytaudl', 'plain audio is unchanged');
    assert.deepEqual([r('jid all', { isGroup: true }).tool, r('jid all', { isGroup: true }).arg], ['jid', 'all']);
    assert.equal(r('jid').tool, 'jid');
    assert.deepEqual([r('wormgpt what is AI').tool, r('wormgpt what is AI').arg], ['wormgpt', 'what is AI']);
});

test('the AI is told about ss, not about the owner-only / adult tools', () => {
    sync(); const p = tools.markerPrompt();
    assert.match(p, /ss\(url: website screenshot\)/);
    assert.match(p, /ytvcdl\(url\)/);
    for (const hidden of ['wormgpt', 'manhwa', 'vv,', 'jid']) assert.ok(!p.includes(hidden), hidden);
});

test('vv.js: auto retrieval is hooked for every new connection (events.socketHooks), with the project\'s baileys fork', () => {
    assert.ok(Array.isArray(events.socketHooks) && events.socketHooks.length >= 1);
    const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'vv.js'), 'utf8');
    assert.ok(src.includes("require('@dnuzi/baileys')") && !src.includes("require('@whiskeysockets/baileys')"));
    const calls = []; const conn = { ev: { on: (e) => calls.push(e) }, user: { id: '1:1@s.whatsapp.net' } };
    for (const h of events.socketHooks) h(conn);
    assert.ok(calls.includes('messages.upsert'), 'the hook attached its messages.upsert listener');
});

test('package.json lists what the new plugins need', () => {
    const pkg = require('../package.json');
    assert.ok(pkg.dependencies['pdf-lib']); assert.ok(pkg.optionalDependencies.sharp);
});

test('manhwa.js when pdf-lib is NOT installed (as in this project): it still loads and tells the owner what to do', () => {
    const script = `
        const Module = require('module'); const orig = Module._load;
        Module._load = function (req) { if (req === 'pdf-lib' || req === 'sharp') { const e = new Error("Cannot find module '" + req + "'"); e.code = 'MODULE_NOT_FOUND'; throw e; } return orig.apply(this, arguments); };
        const _l = console.log; console.log = () => {};
        const ev = require(${JSON.stringify(path.join(__dirname, '..', 'command'))});
        require(${JSON.stringify(path.join(__dirname, '..', 'plugins', 'manhwa.js'))});
        console.log = _l;
        const cmd = ev.commands.find(c => c.pattern === 'manhwa');
        const sent = [];
        const conn = { sendMessage: async (j, c) => { sent.push(c.text || ''); return { key: { id: 'x' } }; } };
        cmd.function(conn, { key: {} }, {}, { from: 'a@s.whatsapp.net', q: 'solo leveling', isOwner: true }).then(() => { console.log(JSON.stringify({ registered: !!cmd, sent, claim: cmd.claimReplies, gf: cmd.gf })); process.exit(0); });
    `;
    const r = require('child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.ok(out.registered); assert.equal(out.claim, true); assert.equal(out.gf, false);
    assert.equal(out.sent.length, 1); assert.match(out.sent[0], /pdf-lib package is not installed/); assert.match(out.sent[0], /npm install/);
});
