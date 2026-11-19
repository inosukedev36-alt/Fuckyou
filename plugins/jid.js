// plugins/jid.js
//
//  .jid                      → inbox: that user's JID + LID | group: the group's JID
//  .jid 94711234567          → that number's JID + LID
//  .jid <channel link>       → the channel's JID (...@newsletter)
//  (reply to a message) .jid → the JID + LID of the person you replied to
//  .jid all                  → JIDs of every member in the group
//
//  හැම output එකකටම "📋 Copy" button එකක් එනවා – tap කළාම JID / LID එක කෙලින්ම copy වෙනවා.

const { cmd } = require('../command')

// bot ගේ prefix එක (usage message එකේ පෙන්නන්න විතරයි)
const PREFIX = '.'

// true කළොත් `.jid all` පාවිච්චි කරන්න පුළුවන් group admins / owner ට විතරයි
const ALL_ADMINS_ONLY = false

// Copy button එක යවන විදිහ:
//   'auto'               → bot එකේ Baileys එක බලලා තනියෙන්ම තෝරගන්නවා (නිර්දේශිතයි)
//   'nativeFlow'         → sendMessage({ nativeFlow })           (@dnuzi/baileys, @itsliaaa/baileys වලට)
//   'interactiveButtons' → sendMessage({ interactiveButtons })   (@itsukichan වගේ fork වලට)
//   'relay'              → අතින් හදලා relayMessage කරනවා          (vanilla @whiskeysockets/baileys වලට)
// Button එක නොපෙනුනොත් මේවා එකින් එක try කරලා බලන්න.
const BUTTON_MODE = 'auto'

// button message එකේ යටින් පෙන්නන කුඩා footer එක (උදා: 'Rashu-XMD'). හිස් නම් footer එකක් නෑ.
const FOOTER = ''

// `.jid all` list එක මේ characters ගණනට වඩා දිග නම් button එක දාන්නේ නෑ (plain text විතරක් යනවා)
const MAX_COPY_LENGTH = 5000

// LID ↔ number lookup එකකට රැඳී ඉන්න උපරිම වෙලාව (ms)
const LOOKUP_TIMEOUT = 6000

// WhatsApp monospace block (tap කරලා copy කරන්න ලේසියි)
const mono = (text) => '```' + text + '```'

// phone-number JID එකක්ද? (@lid නෙවෙයි)
const isPN = (jid) => !!jid && jid.endsWith('@s.whatsapp.net')

// LID එකක්ද?
const isLID = (jid) => !!jid && jid.endsWith('@lid')

// device කෑල්ල අයින් කරනවා  (94711234567:5@s.whatsapp.net → 94711234567@s.whatsapp.net)
const clean = (jid) => (jid ? String(jid).replace(/:\d+@/, '@') : null)

// group member කෙනෙකුගේ number JID එක
// (අලුත් Baileys වල LID group වලදී real number එක තියෙන්නේ `phoneNumber` එකේ)
const memberJid = (p) => p.phoneNumber || p.jid || p.id

const withTimeout = (promise, ms = LOOKUP_TIMEOUT) => {
    let timer
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms) })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}


// ───────────────────────── Message design ─────────────────────────
//
//   ╭━━━〔 🆔 *USER INFO* 〕━━━
//   ┃
//   ┃ 👤 *Replied User*
//   ┃
//   ┃ 📱 *JID*
//   ┃ ```94711234567@s.whatsapp.net```
//   ┃
//   ┃ 🔗 *LID*
//   ┃ ```123456789012345@lid```
//   ┃
//   ╰━━━━━━━━━━━━━━━━

// ලස්සන box එකක් හදනවා (lines වල හිස් '' = හිස් පේළියක්)
const box = (title, lines) => [
    `╭━━━〔 ${title} 〕━━━`,
    '┃',
    ...lines.map((l) => (l ? '┃ ' + l : '┃')),
    '┃',
    '╰━━━━━━━━━━━━━━━━'
].join('\n')

// user කෙනෙකුගේ JID + LID card එක (නැති එකට "not found")
const userBox = (who, { jid, lid }, extra = []) => box('🆔 *USER INFO*', [
    who,
    ...extra,
    '',
    '📱 *JID*',
    jid ? mono(jid) : '_not found_',
    '',
    '🔗 *LID*',
    lid ? mono(lid) : '_not found_'
])

// හොයාගත්ත ඒවාට විතරක් Copy button එකක්
const userButtons = ({ jid, lid }) => [
    jid && { label: '📋 Copy JID', copy: jid },
    lid && { label: '📋 Copy LID', copy: lid }
].filter(Boolean)

const groupBox = (meta, jid) => box('👥 *GROUP INFO*', [
    ...(meta ? [`🏷️ *Name* : ${meta.subject}`, `👤 *Members* : ${meta.participants?.length ?? '?'}`, ''] : []),
    '🆔 *Group JID*',
    mono(jid)
])

const channelBox = (name, jid) => box('📢 *CHANNEL INFO*', [
    ...(name ? [`🏷️ *Name* : ${name}`, ''] : []),
    '🆔 *Channel JID*',
    mono(jid)
])

const usageBox = () => box('📖 *USAGE*', [
    `• *${PREFIX}jid* ➜ this chat`,
    `• *${PREFIX}jid all* ➜ every group member`,
    `• *${PREFIX}jid 94711234567* ➜ a number`,
    `• *${PREFIX}jid <channel link>* ➜ a channel`,
    `• reply to a message + *${PREFIX}jid* ➜ that user`
])


// ───────────────────────── JID + LID ─────────────────────────

// JID එකක් හෝ LID එකක් දුන්නාම → { jid, lid } දෙකම හොයලා දෙනවා (හොයාගන්න බැරි එක null)
async function resolveIds(conn, id, { meta, alt } = {}) {
    id = clean(id)
    const ids = { jid: null, lid: null }
    if (!id) return ids

    // දන්න JID / LID එකකින් අඩු එක පුරවනවා
    const fill = (x) => {
        x = clean(x)
        if (isPN(x) && !ids.jid) ids.jid = x
        if (isLID(x) && !ids.lid) ids.lid = x
    }
    fill(id)
    fill(alt)

    // 1) group members ලගේ data (LID group → phoneNumber, number group → lid)
    const p = meta?.participants?.find((x) => [x.id, x.lid, x.phoneNumber, x.jid].map(clean).includes(id))
    if (p) [p.id, p.lid, p.phoneNumber, p.jid].forEach(fill)

    // 2) bot ගේම account එක
    const me = conn.user || {}
    if ([me.id, me.lid].map(clean).includes(id)) [me.id, me.lid].forEach(fill)

    // 3) Baileys ගේ LID ↔ number mapping
    const map = conn.signalRepository?.lidMapping
    if (map) {
        if (ids.lid && !ids.jid) {
            try { fill(await withTimeout(map.getPNForLID(ids.lid))) } catch (_) { /* not found */ }
        }
        if (ids.jid && !ids.lid) {
            try { fill(await withTimeout(map.getLIDForPN(ids.jid))) } catch (_) { /* not found */ }
        }
    }
    return ids
}


// ───────────────────────── Copy button ─────────────────────────
// WhatsApp native-flow `cta_copy` button (.pair command එකේ "Copy Code" button එකම වර්ගයයි)

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
    nativeFlow: { text: '.', nativeFlow: [{ text: '.', copy: '.' }] },
    interactiveButtons: { text: '.', interactiveButtons: [{ name: 'cta_copy', buttonParamsJson: '{}' }] }
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

// text message එකක් + "Copy" button(s) යවනවා. බැරි වුනොත් සාමාන්‍ය text එක යවනවා.
// buttons = [{ label, copy }, ...]
async function sendCopyButton({ conn, mek, from, text, buttons, fallback }) {
    if (!buttons.length) return fallback(text)
    try {
        const flow = buttons.map((b, i) => ({
            name: 'cta_copy',
            buttonParamsJson: JSON.stringify({ display_text: b.label, id: 'copy_' + i, copy_code: b.copy })
        }))
        const bl = await getBaileys()
        const api = BUTTON_MODE !== 'auto' ? BUTTON_MODE : (bl ? await detectApi(bl) : 'nativeFlow')

        // A) button support එක built-in තියෙන Baileys fork (dnuzi, itsliaaa, itsukichan ...) – සරලම විදිහ
        if (api === 'nativeFlow' || api === 'interactiveButtons') {
            const content = api === 'nativeFlow'
                ? { text, nativeFlow: buttons.map((b) => ({ text: b.label, copy: b.copy })) }
                : { text, interactiveButtons: flow }
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
                        nativeFlowMessage: IM.NativeFlowMessage.create({ buttons: flow })
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
    desc: 'Get the JID / LID of a user, or the JID of a group or channel',
    category: 'main',
    use: `${PREFIX}jid | ${PREFIX}jid all | ${PREFIX}jid 94711234567 | ${PREFIX}jid <channel link> | reply + ${PREFIX}jid`,
    filename: __filename
},
async (conn, mek, m, { from, q, isGroup, isAdmins, isOwner, reply }) => {
    try {
        const input = (q || '').trim()

        // message එකක් විදිහට + "Copy" button(s) එක්ක යවනවා
        const send = (text, buttons) => sendCopyButton({ conn, mek, from, text, buttons, fallback: reply })

        // group metadata (fail වුනොත් null – ඒත් LID mapping එකෙන් තවම හොයන්න පුළුවන්)
        const getMeta = async () => {
            if (!isGroup) return null
            try { return await conn.groupMetadata(from) } catch (_) { return null }
        }

        // 1) .jid all → every member's JID (groups only)
        if (input.toLowerCase() === 'all') {
            if (!isGroup) return reply('❌ `all` can only be used inside a group.')
            if (ALL_ADMINS_ONLY && !isAdmins && !isOwner) return reply('❌ Only group admins can use this.')

            const meta = await conn.groupMetadata(from)
            const jids = meta.participants.map(memberJid)
            const list = jids.join('\n')
            const text = box('👥 *GROUP MEMBERS*', [`🏷️ *Group* : ${meta.subject}`, `👤 *Members* : ${jids.length}`])
                + '\n\n' + mono(list)

            if (list.length > MAX_COPY_LENGTH) return reply(text) // ලොකු list එකකට button එක නෑ
            return send(text, [{ label: '📋 Copy All JIDs', copy: list }])
        }

        // 2) .jid <channel link> → channel JID
        const channel = input.match(/whatsapp\.com\/channel\/([\w-]+)/i)
        if (channel) {
            if (typeof conn.newsletterMetadata !== 'function') {
                return reply('❌ This Baileys version has no channel support. Please update Baileys.')
            }
            const meta = await conn.newsletterMetadata('invite', channel[1])
            if (!meta?.id) return reply('❌ Channel not found. Check the link and try again.')
            const name = meta.name || meta.thread_metadata?.name?.text
            return send(channelBox(name, meta.id), [{ label: '📋 Copy JID', copy: meta.id }])
        }

        // 3) .jid 94711234567 → that number's JID + LID
        if (input) {
            if (!/^[@+]?[\d\s()-]+$/.test(input)) return reply('❌ *Invalid input*\n\n' + usageBox())

            let number = input.replace(/\D/g, '').replace(/^00/, '')
            if (number.startsWith('0')) number = '94' + number.slice(1) // 0711234567 → 94711234567
            if (number.length < 8 || number.length > 15) {
                return reply('❌ *Invalid number*\nExample: ' + PREFIX + 'jid 94711234567')
            }

            let jid = number + '@s.whatsapp.net'
            let lidHint = null
            let missing = false
            try {
                const [res] = (await conn.onWhatsApp(number)) || []
                if (res?.exists) { jid = res.jid; lidHint = res.lid } // සමහර Baileys වල lid එකත් එනවා
                else missing = true
            } catch (_) { /* lookup failed – still return the JID */ }

            const ids = missing ? { jid, lid: null } : await resolveIds(conn, jid, { alt: lidHint })
            const extra = missing ? ['⚠️ _This number does not seem to be on WhatsApp_'] : []
            return send(userBox(`📞 *Number* : +${number}`, ids, extra), userButtons(ids))
        }

        // 4) reply + .jid → JID + LID of the person you replied to
        const quotedId = m.quoted?.sender || mek.message?.extendedTextMessage?.contextInfo?.participant
        if (quotedId) {
            const ids = await resolveIds(conn, quotedId, { meta: await getMeta() })
            return send(userBox('👤 *Replied User*', ids), userButtons(ids))
        }

        // 5) plain .jid → this chat's JID (inbox = that user's JID + LID, group = the group's JID)
        if (isGroup) return send(groupBox(await getMeta(), from), [{ label: '📋 Copy JID', copy: from }])

        const ids = await resolveIds(conn, from, { alt: mek.key?.remoteJidAlt })
        return send(userBox('👤 *This Chat*', ids), userButtons(ids))

    } catch (e) {
        console.log(e)
        reply('❌ Error: ' + e.message)
    }
})
