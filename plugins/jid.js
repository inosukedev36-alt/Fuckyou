// plugins/jid.js
const { cmd } = require('../command')

// 🚨 ඔබේ sendNative සහ copy තියෙන file එකේ path එක මෙතනට දාන්න.
// උදාහරණයක් විදිහට: require('../lib/button') හෝ require('../lib/msg')
let sendNative, copy;
try {
    const btnLib = require('../lib/button'); // <--- ඔබේ path එක වැරදි නම් මෙතන වෙනස් කරන්න
    sendNative = btnLib.sendNative;
    copy = btnLib.copy;
} catch (e) {
    // Path එක වැරදි නම් හෝ එහෙම file එකක් නැත්නම් bot එක crash නොවී මේක පාවිච්චි කරයි
    console.log("⚠️ Button library not found at path, using fallback...");
    
    // Fallback copy function
    copy = (text, value) => ({
        name: "cta_copy",
        buttonParamsJson: JSON.stringify({ display_text: text, copy_code: value })
    });

    // Fallback sendNative function
    sendNative = async (conn, from, mek, options) => {
        return conn.sendMessage(from, {
            interactiveMessage: {
                header: { title: options.text, hasMediaAttachment: false },
                body: { text: "Tap to copy 👇" },
                footer: { text: "Powered by Bot" },
                nativeFlowMessage: { buttons: options.buttons }
            }
        }, { quoted: mek });
    };
}

const ALL_ADMINS_ONLY = false
const isPN  = (jid) => !!jid && jid.endsWith('@s.whatsapp.net')
const isLID = (jid) => !!jid && jid.endsWith('@lid')
const memberJid = (p) => p.phoneNumber || p.jid || p.id

function buildJidButtons(pn, lid, fallback) {
    const buttons = []
    if (pn)  buttons.push({ label: '📋 Copy PN JID', value: pn })
    if (lid) buttons.push({ label: '🆔 Copy LID',   value: lid })
    if (!buttons.length && fallback) {
        buttons.push({ label: '📋 Copy JID', value: fallback })
    }
    return buttons
}

function collectJids(...candidates) {
    let pn = null, lid = null
    for (const c of candidates) {
        if (!c) continue
        if (isPN(c) && !pn) pn = c
        else if (isLID(c) && !lid) lid = c
    }
    return { pn, lid }
}

cmd({
    pattern: 'jid',
    desc: 'Get the JID (and LID) of a user, group or channel',
    category: 'main',
    use: '/jid | /jid all | /jid 94711234567 | /jid <channel link> | reply + /jid',
    filename: __filename
},
async (conn, mek, m, { from, q, isGroup, isAdmins, isOwner, reply }) => {
    try {
        const input = (q || '').trim()
        const key = mek.key || {}
        const ctx = mek.message?.extendedTextMessage?.contextInfo

        // 1) /jid all
        if (input.toLowerCase() === 'all') {
            if (!isGroup) return reply('❌ `all` can only be used inside a group.')
            if (ALL_ADMINS_ONLY && !isAdmins && !isOwner) return reply('❌ Only group admins can use this.')

            const meta = await conn.groupMetadata(from)
            const lines = meta.participants.map(p => {
                const pn  = isPN(p.phoneNumber) ? p.phoneNumber : isPN(p.jid) ? p.jid : isPN(p.id) ? p.id : null
                const lid = isLID(p.lid) ? p.lid : isLID(p.id) ? p.id : null
                if (pn && lid) return `${pn}  |  ${lid}`
                return pn || lid || String(p.id || '')
            })

            return conn.sendMessage(from, {
                text: `👥 *${meta.subject}*\nMembers: ${lines.length}\n\n\`\`\`${lines.join('\n')}\`\`\``
            }, { quoted: mek })
        }

        // 2) /jid <channel link>
        const channel = input.match(/whatsapp\.com\/channel\/([\w-]+)/i)
        if (channel) {
            if (typeof conn.newsletterMetadata !== 'function') {
                return reply('❌ This Baileys version has no channel support.')
            }
            const meta = await conn.newsletterMetadata('invite', channel[1])
            if (!meta?.id) return reply('❌ Channel not found. Check the link and try again.')
            const name = meta.name || meta.thread_metadata?.name?.text
            
            return sendNative(conn, from, mek, {
                text: `📢 *Channel JID*${name ? ` — ${name}` : ''}\n\nTap to copy 👇`,
                buttons: [copy('📋 Copy Channel JID', meta.id)]
            })
        }

        // 3) /jid 94711234567
        if (input) {
            if (!/^[@+]?[\d\s()-]+$/.test(input)) {
                return reply('❌ Invalid input.\n\n*Usage*\n/jid\n/jid all\n/jid 94711234567\n/jid <channel link>\nReply to a message + /jid')
            }
            let number = input.replace(/\D/g, '').replace(/^00/, '')
            if (number.startsWith('0')) number = '94' + number.slice(1)
            if (number.length < 8 || number.length > 15) {
                return reply('❌ Invalid number.\nExample: /jid 94711234567')
            }

            let jid = number + '@s.whatsapp.net'
            let exists = true
            try {
                const [res] = (await conn.onWhatsApp(number)) || []
                if (res?.exists) jid = res.jid
                else exists = false
            } catch (_) { }

            if (!exists) {
                return conn.sendMessage(from, {
                    text: `👤 *User JID*\n\n\`\`\`${jid}\`\`\`\n\n⚠️ This number does not seem to be on WhatsApp.`
                }, { quoted: mek })
            }
            return sendNative(conn, from, mek, {
                text: `👤 *User JID*\n\nTap to copy 👇`,
                buttons: [copy('📋 Copy PN JID', jid)]
            })
        }

        // 4) reply + /jid
        const replySender    = m.quoted?.sender || ctx?.participant
        const replySenderAlt = ctx?.participantAlt || m.quoted?.senderAlt

        if (replySender) {
            let { pn, lid } = collectJids(replySender, replySenderAlt)

            if (isGroup && (!pn || !lid)) {
                try {
                    const meta = await conn.groupMetadata(from)
                    const p = meta.participants.find(x =>
                        x.id === replySender || x.lid === replySender ||
                        x.id === replySenderAlt || x.lid === replySenderAlt ||
                        x.phoneNumber === replySender
                    )
                    if (p) {
                        const extra = collectJids(p.id, p.lid, p.phoneNumber, p.jid)
                        pn  = pn  || extra.pn
                        lid = lid || extra.lid
                    }
                } catch (_) {}
            }

            const rawButtons = buildJidButtons(pn, lid, replySender)
            const formattedButtons = rawButtons.map(b => copy(b.label, b.value))

            return sendNative(conn, from, mek, {
                text: `👤 *Replied user JIDs*\n\nTap to copy 👇`,
                buttons: formattedButtons
            })
        }

        // 5) plain /jid
        if (isGroup) {
            return sendNative(conn, from, mek, {
                text: `👥 *Group JID*\n\nTap to copy 👇`,
                buttons: [copy('📋 Copy Group JID', from)]
            })
        }

        const { pn, lid } = collectJids(key.remoteJid, key.remoteJidAlt)
        const rawButtons = buildJidButtons(pn, lid, from)
        const formattedButtons = rawButtons.map(b => copy(b.label, b.value))
        
        return sendNative(conn, from, mek, {
            text: `👤 *User JIDs*\n\nTap to copy 👇`,
            buttons: formattedButtons
        })

    } catch (e) {
        console.log("JID Command Error:", e)
        reply('❌ Error: ' + e.message)
    }
})
