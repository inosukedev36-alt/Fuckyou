// Anti-delete toggle.
// (The view-once part that used to live in this file — the vv command, the 🔥/❤️/💖 aliases and the AntiViewOnce forwarder —
//  was replaced by plugins/vv.js, which also retrieves view-once media automatically.)
const { cmd } = require('../command');
const { getAnti, setAnti, initializeAntiDeleteSettings } = require('../lib/antidel');

initializeAntiDeleteSettings();

// ═══ Antidelete Toggle Command ═══
cmd({
    pattern: "antidelete", alias: ['antidel', 'ad'],
    desc: "Toggle Antidelete", category: "misc", filename: __filename
},
async (conn, mek, m, { reply, q, isOwner }) => {
    if (!isOwner) return reply('❌ Only bot owner');
    const cmdStr = (q || '').toLowerCase().trim();
    switch (cmdStr) {
        case 'on': setAnti('gc', true); setAnti('dm', true); return reply('✅ AntiDelete ON (GC + DM)');
        case 'off': setAnti('gc', false); setAnti('dm', false); return reply('❌ AntiDelete OFF');
        case 'on gc': setAnti('gc', true); return reply('✅ GC ON');
        case 'off gc': setAnti('gc', false); return reply('❌ GC OFF');
        case 'on dm': setAnti('dm', true); return reply('✅ DM ON');
        case 'off dm': setAnti('dm', false); return reply('❌ DM OFF');
        case 'status': return reply(`DM: ${getAnti('dm') ? 'ON ✅' : 'OFF ❌'}\nGC: ${getAnti('gc') ? 'ON ✅' : 'OFF ❌'}`);
        default: return reply('Usage: .antidelete on/off/on gc/off gc/on dm/off dm/status');
    }
});
