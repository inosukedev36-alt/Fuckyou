// plugins/autoblock.js — /autoblock : the owner's remote control for lib/autoblock.js   (owner only)
//
//   /autoblock                     status: on / off, the allow-list, the numbers blocked last
//   /autoblock on | off            switch it
//   /autoblock allow <number>      never block this number   (or reply to / @mention the person)
//   /autoblock deny <number>       take a number off the allow-list again
//   /autoblock unblock <number>    unblock it on WhatsApp AND allow it from now on
//   /autoblock notify on | off     a WhatsApp message to the owner every time somebody is blocked
//
// What it does: pair.js calls lib/autoblock.js for every private message of a person who is not owner / sudo / trusted — that number is blocked.
// No `use:` line on purpose: she must never run this one herself (and `gf: false` keeps it that way).
const { cmd } = require('../command');
const AB = require('../lib/autoblock');

const ago = (date) => {
    const s = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 1000));
    return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)} days ago`;
};

const HELP = [
    '/autoblock on | off',
    '/autoblock allow <number>  (or reply to the person)',
    '/autoblock deny <number>',
    '/autoblock unblock <number>  (also allows it from now on)',
    '/autoblock notify on | off',
].join('\n');

/** the number the owner means: written after the word, or the person he replied to / @mentioned */
function targetOf(args, m) {
    if (args[1]) return AB.normNumber(args[1]);
    const jid = (m && m.quoted && m.quoted.sender) || (m && m.mentionUser && m.mentionUser[0]) || '';
    return String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
}

function format(s) {
    if (!s.loaded) return '⏳ MongoDB is not ready yet, so nothing is blocked right now. Try again in a moment.';
    const L = [`🚫 *Auto-block*: ${s.enabled ? 'ON ✅' : 'OFF ⛔'}${s.envOff ? ' (env AUTO_BLOCK=off)' : ''}`];
    L.push('sudo / owner / trusted නෙමෙයි නම් inbox එකට ආපු ගමන් block වෙනවා. Groups වලට බලපාන්නේ නෑ.');
    if (s.warmingUp) L.push('🕐 bot එක අලුතින් start වුණා: පළවෙනි විනාඩිය block කරන්නේ නෑ (sudo list එක load වෙනවා).');
    if (s.paused) L.push(`⏸️ Paused: පැයක් ඇතුළත ${s.lastHour} දෙනෙක් block වුණා (limit ${s.maxPerHour}). අලුතින් block කරන්නේ නෑ.`);
    L.push('');
    L.push(`✅ Allow-list: ${s.allow.length ? s.allow.join(', ') : 'empty'}`);
    L.push(`📊 Blocked: ${s.blockedTotal} (last 50 kept) · last hour ${s.lastHour}/${s.maxPerHour}`);
    L.push(`🔔 Tell me on WhatsApp: ${s.notify ? 'yes' : 'no'}`);
    if (s.blocked.length) {
        L.push('', 'Last blocked:');
        for (const b of s.blocked) L.push(`• ${b.number}${b.name ? ` (${b.name})` : ''} · ${ago(b.at)}${b.text ? ` · "${b.text}"` : ''}`);
    }
    L.push('', HELP);
    return L.join('\n');
}

cmd({
    pattern: 'autoblock',
    desc: 'Auto-block everybody who is not sudo and writes to the bot in private (owner only): /autoblock on | off | allow | deny | unblock',
    category: 'owner',
    react: '🚫',
    gf: false,
    filename: __filename,
}, async (conn, mek, m, { args, isOwner, reply }) => {
    if (!isOwner) return reply('🔒 This command is only for the bot owner.');
    try {
        const sub = String((args && args[0]) || 'status').toLowerCase();
        const on = /^(on|yes|true|1)$/i.test(String((args && args[1]) || ''));

        if (sub === 'status') return await reply(format(await AB.status()));

        if (sub === 'on' || sub === 'off') {
            await AB.setEnabled(sub === 'on');
            return await reply(sub === 'on'
                ? '✅ Auto-block ON — sudo නැති කවුරුහරි inbox එකට ආවොත් block වෙනවා.'
                : '⛔ Auto-block OFF — කවුරුවත් block කරන්නේ නෑ.');
        }

        if (sub === 'notify') {
            await AB.setNotify(on);
            return await reply(on ? '🔔 හැම block එකකටම මට WhatsApp message එකක් එනවා.' : '🔕 block වෙද්දී message එවන්නේ නෑ (/autoblock status එකේ list එක තියෙනවා).');
        }

        if (sub === 'allow' || sub === 'deny' || sub === 'unblock') {
            const number = targetOf(args || [], m);
            if (number.length < 7) return await reply(`❌ Number එක දෙන්න (94771234567 හෝ 0771234567), නැත්නම් ඒ කෙනාගේ message එකකට reply කරන්න.\n\n${HELP}`);
            if (sub === 'allow') {
                await AB.allow(number);
                return await reply(`✅ ${number} allow-list එකට දැම්මා: ඒ number එක කවදාවත් auto-block වෙන්නේ නෑ.`);
            }
            if (sub === 'deny') {
                await AB.deny(number);
                return await reply(`↩️ ${number} allow-list එකෙන් අයින් කළා (sudo නෙමෙයි නම් ඊළඟ message එකට block වෙනවා).`);
            }
            await AB.unblock(conn, number);
            return await reply(`✅ ${number} unblock කළා, ඒ වගේම allow-list එකටත් දැම්මා (නැත්නම් ඊළඟ message එකට ආයෙ block වෙනවා).`);
        }

        return await reply(`❓ තේරුණේ නෑ.\n\n${HELP}`);
    } catch (e) {
        console.error('[autoblock cmd]', e);
        await reply(`❌ ${e && e.message ? e.message : e}`);
    }
});
