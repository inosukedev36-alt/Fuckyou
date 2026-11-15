// plugins/jid.js
//
//  /jid                      → inbox: that user's JID | group: the group's JID
//  /jid 94711234567          → that number's JID
//  /jid <channel link>       → the channel's JID (...@newsletter)
//  (reply to a message) /jid → the JID of the person you replied to
//  /jid all                  → JIDs of every member in the group

const { cmd } = require('../command')

// true කළොත් `/jid all` පාවිච්චි කරන්න පුළුවන් group admins / owner ට විතරයි
const ALL_ADMINS_ONLY = false

// WhatsApp monospace block (tap කරලා copy කරන්න ලේසියි)
const mono = (text) => '```' + text + '```'

// phone-number JID එකක්ද? (@lid නෙවෙයි)
const isPN = (jid) => !!jid && jid.endsWith('@s.whatsapp.net')

// group member කෙනෙකුගේ number JID එක
// (අලුත් Baileys වල LID group වලදී real number එක තියෙන්නේ `phoneNumber` එකේ)
const memberJid = (p) => p.phoneNumber || p.jid || p.id

cmd({
    pattern: 'jid',
    desc: 'Get the JID of a user, group or channel',
    category: 'main',
    use: '/jid | /jid all | /jid 94711234567 | /jid <channel link> | reply + /jid',
    filename: __filename
},
async (conn, mek, m, { from, q, isGroup, isAdmins, isOwner, reply }) => {
    try {
        const input = (q || '').trim()

        // 1) /jid all → every member's JID (groups only)
        if (input.toLowerCase() === 'all') {
            if (!isGroup) return reply('❌ `all` can only be used inside a group.')
            if (ALL_ADMINS_ONLY && !isAdmins && !isOwner) return reply('❌ Only group admins can use this.')

            const meta = await conn.groupMetadata(from)
            const jids = meta.participants.map(memberJid)
            return reply(`👥 *${meta.subject}*\nMembers: ${jids.length}\n\n` + mono(jids.join('\n')))
        }

        // 2) /jid <channel link> → channel JID
        const channel = input.match(/whatsapp\.com\/channel\/([\w-]+)/i)
        if (channel) {
            if (typeof conn.newsletterMetadata !== 'function') {
                return reply('❌ This Baileys version has no channel support. Please update Baileys.')
            }
            const meta = await conn.newsletterMetadata('invite', channel[1])
            if (!meta?.id) return reply('❌ Channel not found. Check the link and try again.')
            const name = meta.name || meta.thread_metadata?.name?.text
            return reply('📢 *Channel JID*' + (name ? ` (${name})` : '') + '\n\n' + mono(meta.id))
        }

        // 3) /jid 94711234567 → that number's JID
        if (input) {
            if (!/^[@+]?[\d\s()-]+$/.test(input)) {
                return reply('❌ Invalid input.\n\n*Usage*\n/jid\n/jid all\n/jid 94711234567\n/jid <channel link>\nReply to a message + /jid')
            }
            let number = input.replace(/\D/g, '').replace(/^00/, '')
            if (number.startsWith('0')) number = '94' + number.slice(1) // 0711234567 → 94711234567
            if (number.length < 8 || number.length > 15) {
                return reply('❌ Invalid number.\nExample: /jid 94711234567')
            }

            let jid = number + '@s.whatsapp.net'
            let note = ''
            try {
                const [res] = (await conn.onWhatsApp(number)) || []
                if (res?.exists) jid = res.jid
                else note = '\n\n⚠️ This number does not seem to be on WhatsApp.'
            } catch (_) { /* lookup failed – still return the JID */ }

            return reply('👤 *User JID*\n\n' + mono(jid) + note)
        }

        // 4) reply + /jid → JID of the person you replied to
        let quotedJid = m.quoted?.sender || mek.message?.extendedTextMessage?.contextInfo?.participant
        if (quotedJid) {
            if (isGroup && !isPN(quotedJid)) { // @lid → try to find the real number
                const meta = await conn.groupMetadata(from)
                const p = meta.participants.find(x => x.id === quotedJid || x.lid === quotedJid)
                if (p) quotedJid = memberJid(p)
            }
            return reply('👤 *Replied user JID*\n\n' + mono(quotedJid))
        }

        // 5) plain /jid → this chat's JID (inbox = that user, group = the group)
        const alt = mek.key?.remoteJidAlt
        const chatJid = (!isGroup && !isPN(from) && isPN(alt)) ? alt : from
        return reply((isGroup ? '👥 *Group JID*' : '👤 *User JID*') + '\n\n' + mono(chatJid))

    } catch (e) {
        console.log(e)
        reply('❌ Error: ' + e.message)
    }
})
