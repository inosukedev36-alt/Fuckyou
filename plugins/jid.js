// plugins/jid.js
//
//  /jid                      → inbox: that user's JID | group: the group's JID
//  /jid 94711234567          → that number's JID
//  /jid <channel link>       → the channel's JID (...@newsletter)
//  (reply to a message) /jid → the JID of the person you replied to
//  /jid all                  → JIDs of every member in the group
//
//  හැම output එකකටම "📋 Copy JID" button එකක් එනවා – tap කළාම JID එක කෙලින්ම copy වෙනවා.

const { cmd } = require('../command')

// true කළොත් `/jid all` පාවිච්චි කරන්න පුළුවන් group admins / owner ට විතරයි
const ALL_ADMINS_ONLY = false

// Copy button එක යවන විදිහ:
//   'auto'               → bot එකේ Baileys එක බලලා තනියෙන්ම තෝරගන්නවා (නිර්දේශිතයි)
//   'interactiveButtons' → sendMessage({ interactiveButtons })   (@itsukichan වගේ fork වලට)
//   'nativeFlow'         → sendMessage({ nativeFlow })           (@itsliaaa වගේ fork වලට)
//   'relay'              → අතින් හදලා relayMessage කරනවා          (vanilla @whiskeysockets/baileys වලට)
// Button එක නොපෙනුනොත් මේවා එකින් එක try කරලා බලන්න.
const BUTTON_MODE = 'auto'

// button message එකේ යටින් පෙන්නන footer එක (ඕනේ නැත්නම් '' ලෙස තියන්න)
const FOOTER = ''

// `/jid all` list එක මේ characters ගණනට වඩා දිග නම් button එක දාන්නේ නෑ (plain text විතරක් යනවා)
const MAX_COPY_LENGTH = 5000

// WhatsApp monospace block (tap කරලා copy කරන්න ලේසියි)
const mono = (text) => '```' + text + '```'

// phone-number JID එකක්ද? (@lid නෙවෙයි)
const isPN = (jid) => !!jid && jid.endsWith('@s.whatsapp.net')

// group member කෙනෙකුගේ number JID එක
// (අලුත් Baileys වල LID group වලදී real number එක තියෙන්නේ `phoneNumber` එකේ)
const memberJid = (p) => p.phoneNumber || p.jid || p.id


// ───────────────────────── Copy button ─────────────────────────
// WhatsApp native-flow `cta_copy` button එකක් (.pair command එකේ "Copy Code" button එකම වර්ගයයි)

// bot එක පාවිච්චි කරන Baileys එකම හොයාගන්නවා (package නම මොකක් වුනත් හරි)
let _baileys
async function getBaileys() {
    if (_baileys !== undefined) return _baileys
    _baileys = null
    const ok = (x) => !!x && !!x.proto && typeof x.generateWAMessageFromContent === 'function'

    // 1) require() කරලා දැනටමත් load වෙලා තියෙන එක
    for (const mod of Object.values(require.cache)) {
        try { if (ok(mod && mod.exports)) return (_baileys = mod.exports) } catch (_) { /* ignore */ }
    }
    // 2) package.json එකේ තියෙන baileys package (ESM වලටත් වැඩ කරනවා)
    const names = ['@whiskeysockets/baileys', 'baileys', '@adiwajshing/baileys']
    try {
        const pkg = require(process.cwd() + '/package.json')
        const deps = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })
        names.unshift(...deps.filter((n) => /baileys|bail/i.test(n)))
    } catch (_) { /* ignore */ }
    for (const name of names) {
        try {
            const x = await import(name)
            const lib = ok(x.default) ? x.default : x
            if (ok(lib)) return (_baileys = lib)
        } catch (_) { /* ignore */ }
    }
    return _baileys
}

// ඒ Baileys එකේ button API එක මොකක්ද? (dry-run එකකින් බලනවා – message එකක් යවන්නේ නෑ)
const PROBES = {
    interactiveButtons: { text: '.', interactiveButtons: [{ name: 'cta_copy', buttonParamsJson: '{}' }] },
    nativeFlow: { text: '.', nativeFlow: [{ text: '.', copy: '.' }] }
}
let _api
async function detectApi(bl) {
    if (_api !== undefined) return _api
    _api = 'relay' // දෙකම නැත්නම් vanilla Baileys
    for (const [name, probe] of Object.entries(PROBES)) {
        try {
            const out = await bl.generateWAMessageContent(probe, { upload: async () => ({}) })
            if (JSON.stringify(out).includes('interactiveMessage')) return (_api = name)
        } catch (_) { /* ignore */ }
    }
    return _api
}

// text message එකක් + "Copy" button එකක් යවනවා. බැරි වුනොත් සාමාන්‍ය text එක යවනවා.
async function sendCopyButton({ conn, mek, from, text, copy, label, fallback }) {
    try {
        const button = {
            name: 'cta_copy',
            buttonParamsJson: JSON.stringify({ display_text: label, id: 'copy_jid', copy_code: copy })
        }
        const bl = await getBaileys()
        const api = BUTTON_MODE !== 'auto' ? BUTTON_MODE : (bl ? await detectApi(bl) : 'interactiveButtons')

        // A) button support එක built-in තියෙන Baileys fork – සරලම විදිහ
        if (api === 'interactiveButtons' || api === 'nativeFlow') {
            const content = api === 'nativeFlow'
                ? { text, nativeFlow: [{ text: label, copy }] }
                : { text, interactiveButtons: [button] }
            if (FOOTER) content.footer = FOOTER
            return await conn.sendMessage(from, content, { quoted: mek })
        }

        // B) vanilla Baileys – native flow message එක අතින් හදලා relay කරනවා
        if (api !== 'relay') throw new Error('Unknown BUTTON_MODE: ' + api)
        if (!bl) throw new Error('Baileys library not found')
        const { proto, generateWAMessageFromContent } = bl
        const IM = proto.Message.InteractiveMessage

        const msg = generateWAMessageFromContent(from, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                    interactiveMessage: IM.create({
                        body: IM.Body.create({ text }),
                        footer: IM.Footer.create({ text: FOOTER }),
                        nativeFlowMessage: IM.NativeFlowMessage.create({ buttons: [button] })
                    })
                }
            }
        }, { quoted: mek, userJid: conn.user.id })

        // button එක render වෙන්න WhatsApp ට ඕන "business" nodes
        const additionalNodes = [{
            tag: 'biz', attrs: {},
            content: [{
                tag: 'interactive', attrs: { type: 'native_flow', v: '1' },
                content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
            }]
        }]
        if (!from.endsWith('@g.us')) additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } }) // inbox වලට

        return await conn.relayMessage(from, msg.message, { messageId: msg.key.id, additionalNodes })
    } catch (e) {
        console.log('[jid] copy button failed → sending plain text:', e.message)
        return fallback(text)
    }
}


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

        // JID එක message එකක් විදිහට + "Copy" button එකත් එක්ක යවනවා
        const send = (text, copy, label = '📋 Copy JID') =>
            sendCopyButton({ conn, mek, from, text, copy, label, fallback: reply })

        // 1) /jid all → every member's JID (groups only)
        if (input.toLowerCase() === 'all') {
            if (!isGroup) return reply('❌ `all` can only be used inside a group.')
            if (ALL_ADMINS_ONLY && !isAdmins && !isOwner) return reply('❌ Only group admins can use this.')

            const meta = await conn.groupMetadata(from)
            const jids = meta.participants.map(memberJid)
            const list = jids.join('\n')
            const text = `👥 *${meta.subject}*\nMembers: ${jids.length}\n\n` + mono(list)

            if (list.length > MAX_COPY_LENGTH) return reply(text) // ලොකු list එකකට button එක නෑ
            return send(text, list, '📋 Copy All JIDs')
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
            return send('📢 *Channel JID*' + (name ? ` (${name})` : '') + '\n\n' + mono(meta.id), meta.id)
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

            return send('👤 *User JID*\n\n' + mono(jid) + note, jid)
        }

        // 4) reply + /jid → JID of the person you replied to
        let quotedJid = m.quoted?.sender || mek.message?.extendedTextMessage?.contextInfo?.participant
        if (quotedJid) {
            if (isGroup && !isPN(quotedJid)) { // @lid → try to find the real number
                const meta = await conn.groupMetadata(from)
                const p = meta.participants.find(x => x.id === quotedJid || x.lid === quotedJid)
                if (p) quotedJid = memberJid(p)
            }
            return send('👤 *Replied user JID*\n\n' + mono(quotedJid), quotedJid)
        }

        // 5) plain /jid → this chat's JID (inbox = that user, group = the group)
        const alt = mek.key?.remoteJidAlt
        const chatJid = (!isGroup && !isPN(from) && isPN(alt)) ? alt : from
        return send((isGroup ? '👥 *Group JID*' : '👤 *User JID*') + '\n\n' + mono(chatJid), chatJid)

    } catch (e) {
        console.log(e)
        reply('❌ Error: ' + e.message)
    }
})
