// plugins/jid.js
//
//  /jid                      → inbox: that user's JID + LID | group: the group's JID
//  /jid 94711234567          → that number's JID
//  /jid <channel link>       → the channel's JID (...@newsletter)
//  (reply to a message) /jid → the JID + LID of the person you replied to
//  /jid all                  → JIDs of every member in the group

const { cmd } = require('../command')

// ⚠️ ඔබේ framework එකේ sendNative සහ copy තියෙන තැන මෙතනින් import කරගන්න
// (ඔබේ අනිත් plugins වල තියෙන විදිහටම path එක වෙනස් කරන්න)
// උදාහරණයක් විදිහට:
// const { sendNative, copy } = require('../lib/button'); 

const ALL_ADMINS_ONLY = false

const isPN  = (jid) => !!jid && jid.endsWith('@s.whatsapp.net')
const isLID = (jid) => !!jid && jid.endsWith('@lid')

const memberJid = (p) => p.phoneNumber || p.jid || p.id

// ─── ඔබේ sendNative සහ copy පාවිච්චි කරන helper එක ───
async function sendJidButtons(conn, from, mek, { title, buttonsData }) {
    try {
        // buttonsData එකේ තියෙන දේවල් copy() ඇතුලට යවනවා
        const formattedButtons = buttonsData.map(b => copy(b.label, b.value));
        
        return await sendNative(conn, from, mek, {
            text: title + "\n\nTap to copy 👇",
            buttons: formattedButtons
        })
    } catch (e) {
        console.log('Button send failed, fallback:', e.message)
        // Error එකක් ආවොත් text විදිහට යවනවා
        const text = title + '\n\n' + buttonsData.map(b => `${b.label}\n${b.value}`).join('\n\n')
        return conn.sendMessage(from, { text }, { quoted: mek })
    }
}

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

        // 1) /jid all → every member's PN JID (groups only)
        if (input.toLowerCase() === 'all') {
            if (!isGroup) return reply('❌ `all` can only be used inside a group.')
            if (ALL_ADMINS_ONLY && !isAdmins && !isOwner) return reply('❌ Only group admins can use this.')

            const meta = await conn.groupMetadata(from)
            const lines = meta.participants.map(p => {
                const pn  = isPN(p.phoneNumber) ? p.phoneNumber
                          : isPN(p.jid)        ? p.jid
                          : isPN(p.id)         ? p.id : null
                const lid = isLID(p.lid) ? p.lid
                          : isLID(p.id)  ? p.id : null
                if (pn && lid) return `${pn}  |  ${lid}`
                return pn || lid || String(p.id || '')
            })

            // group එකේ ගොඩක් අය ඉන්න නිසා මේක text විදිහටම යවනවා
            return conn.sendMessage(from, {
                text: `👥 *${meta.subject}*\nMembers: ${lines.length}\n\n\`\`\`${lines.join('\n')}\`\`\``
            }, { quoted: mek })
        }

        // 2) /jid <channel link> → channel JID (LID නෑ)
        const channel = input.match(/whatsapp\.com\/channel\/([\w-]+)/i)
        if (channel) {
            if (typeof conn.newsletterMetadata !== 'function') {
                return reply('❌ This Baileys version has no channel support. Please update Baileys.')
            }
            const meta = await conn.newsletterMetadata('invite', channel[1])
            if (!meta?.id) return reply('❌ Channel not found. Check the link and try again.')
            const name = meta.name || meta.thread_metadata?.name?.text
            
            return sendJidButtons(conn, from, mek, {
                title: '📢 *Channel JID*' + (name ? ` — ${name}` : ''),
                buttonsData: [{ label: '📋 Copy Channel JID', value: meta.id }]
            })
        }

        // 3) /jid 94711234567 → that number's JID (LID derive කරන්න බෑ)
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
            return sendJidButtons(conn, from, mek, {
                title: '👤 *User JID*',
                buttonsData: [{ label: '📋 Copy PN JID', value: jid }]
            })
        }

        // 4) reply + /jid → replied user's PN + LID
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

            const buttons = buildJidButtons(pn, lid, replySender)
            return sendJidButtons(conn, from, mek, {
                title: '👤 *Replied user JIDs*',
                buttonsData: buttons
            })
        }

        // 5) plain /jid → this chat's JID (+ LID for inbox)
        if (isGroup) {
            return sendJidButtons(conn, from, mek, {
                title: '👥 *Group JID*',
                buttonsData: [{ label: '📋 Copy Group JID', value: from }]
            })
        }

        // inbox → remoteJid (often @lid) + remoteJidAlt (@s.whatsapp.net)
        const { pn, lid } = collectJids(key.remoteJid, key.remoteJidAlt)
        const buttons = buildJidButtons(pn, lid, from)
        return sendJidButtons(conn, from, mek, {
            title: '👤 *User JIDs*',
            buttonsData: buttons
        })

    } catch (e) {
        console.log(e)
        reply('❌ Error: ' + e.message)
    }
})
