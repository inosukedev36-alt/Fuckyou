const { cmd } = require('../command');
const antiban = require('../lib/antiban');

// /antiban            → what the anti-ban layer is doing right now
// /antiban panic 30   → stop sending to everybody except the owner chat for 30 minutes (default 30, max 1440)
// /antiban resume     → clear a panic pause / cool-down
// /antiban off | on   → switch the layer off / on until the next restart
function formatStatus(s) {
    const left = antiban.fmtLeft;
    const state = s.mode === 'normal' ? '✅ normal'
        : s.mode === 'cooldown' ? `⏸️ cool-down after a WhatsApp warning — ${left(s.modeLeftMs)} left`
        : `🛑 paused — ${left(s.modeLeftMs)} left${s.panicReason ? ` (${s.panicReason})` : ''}`;
    const L = s.limits;
    const lines = [
        `🛡️ *ANTI-BAN* — ${s.enabled ? 'ON' : '⚠️ OFF (until restart)'}`,
        '',
        `*State:* ${state}`,
        `*Sent:* ${s.sent.lastMinute}/min · ${s.sent.lastHour}/hour · ${s.sent.last24h}/24h${s.sent.queued ? ` · ${s.sent.queued} waiting for their turn` : ''}`,
        `*Limits:* ${L.perMinute}/min · ${L.perHour}/hour · ${L.perDay}/day · ${L.perChatPerMinute}/min per chat`,
        `*New chats the bot started:* ${s.cold.lastHour}/hour (max ${L.coldPerHour}) · ${s.cold.last24h}/24h (max ${L.coldPerDay})`,
        `*Warm-up:* ${s.warmup.active ? `ON — limits at ${Math.round(s.warmup.factor * 100)}%` : 'off'}`,
        `*Refused:* ${s.stats.blocked} · *Held back in total:* ${left(s.stats.delayedMs)}`,
        `*WhatsApp warnings:* ${s.stats.pushbacks} (strikes now: ${s.strikes})`,
        `*Old queued commands skipped:* ${s.stats.staleSkipped} · *Flooding commands ignored:* ${s.stats.commandsIgnored}`,
    ];
    for (const c of s.sessions) lines.push(`*Presence ${c.id.replace(/^dina_/, '')}:* ${c.online ? '🟢 online (active right now)' : '⚪ offline (goes online only while replying)'}`);
    for (const r of s.reconnect) lines.push(`*Reconnects ${r.id.replace(/^dina_/, '')}:* ${r.attempts} in a row · ${r.lastHour} in the last hour`);
    return lines.join('\n');
}

cmd({
    pattern: 'antiban',
    alias: ['ab'],
    desc: 'Anti-ban status · panic pause · resume (owner only)',
    category: 'owner',
    react: '🛡️',
    gf: false,   // never something the AI girlfriend can start from chat
    filename: __filename,
}, async (conn, mek, m, { q, reply, isOwner }) => {
    // a paused bot may be unable to answer in a group; never let that crash the command
    const say = async (text) => { try { await reply(text); } catch (e) { console.log('[antiban cmd] reply refused:', e.message); } };
    if (!isOwner) return say('❌ Owner only.');

    const [sub = '', arg] = String(q || '').trim().toLowerCase().split(/\s+/);
    switch (sub) {
        case '':
        case 'status':
            return say(formatStatus(antiban.status()));
        case 'panic': {
            const minutes = Math.min(1440, Math.max(1, parseInt(arg, 10) || 30));
            antiban.panic(minutes, 'owner command');
            return say(`🛑 Paused for *${minutes} min*. Nothing is sent to anyone except the owner chat.\n\nUse */antiban resume* to continue earlier.`);
        }
        case 'resume':
            antiban.resume();
            return say('✅ Resumed. Pause, cool-down and warning strikes are cleared.');
        case 'off':
            antiban.setEnabled(false);
            return say('⚠️ Anti-ban is *OFF* until the next restart. Nothing is paced, capped or slowed down now.');
        case 'on':
            antiban.setEnabled(true);
            return say('✅ Anti-ban is *ON*.');
        default:
            return say('Usage:\n*/antiban* — status\n*/antiban panic [minutes]* — stop sending (owner chat excepted)\n*/antiban resume*\n*/antiban off* · *on*');
    }
});
