// Audio Sticker command  (cmd({ pattern, alias, ... }) style)  -- "sticker with sound"
//
// Usage:
//  • Send or reply to a VIDEO with .saudio      -> sticker that plays the video's sound
//  • Reply to a PHOTO or STICKER with .saudio   -> starts a 60-second session,
//    then reply to a voice note / audio / video with .saudio to merge them
//  • Custom pack info: .saudio Pack|Author
//  • Cancel a session: .saudio cancel
//
// Requires: ffmpeg (with libwebp + libopus) on the host, and a Baileys package
// (@dnuzi/baileys / @whiskeysockets/baileys / baileys - whichever your bot already uses).
// No node-webpmux needed.

const { cmd } = require('../command') // adjust this path to match your bot
const crypto = require('crypto')
const { execFile, execFileSync } = require('child_process')
const { promisify } = require('util')
const fsp = require('fs/promises')
const nodePath = require('path')
const nodeOs = require('os')

const execFileAsync = promisify(execFile)

/* ---------------- Config ---------------- */

const AUDIO_LIMIT_SEC = 25
const SESSION_TTL_SEC = 60
const TARGET_STICKER_BYTES = 880 * 1024 // try to stay under this
const HARD_STICKER_BYTES = 1000 * 1000 // refuse above this (WhatsApp ~1 MB ceiling)
const STATIC_STICKER_BYTES = 100 * 1024

const audioSessions = globalThis.__audioStickerSessions || (globalThis.__audioStickerSessions = new Map())

// [size, fps, quality] ladder: first one that fits TARGET_STICKER_BYTES wins
const STICKER_PROFILES = [
  { size: 512, fps: 10, quality: 50 },
  { size: 512, fps: 8, quality: 36 },
  { size: 512, fps: 6, quality: 24 },
  { size: 512, fps: 5, quality: 16 },
  { size: 384, fps: 6, quality: 20 },
  { size: 320, fps: 5, quality: 14 }
]

const MEDIA_TYPES = {
  stickerMessage: 'sticker',
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio'
}

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/3gpp': '3gp', 'video/quicktime': 'mov',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm'
}
const DEFAULT_EXT = { sticker: 'webp', image: 'jpg', video: 'mp4', audio: 'ogg' }

/* ---------------- Baileys (any fork, loaded lazily) ---------------- */

const BAILEYS_CANDIDATES = ['@dnuzi/baileys', '@whiskeysockets/baileys', 'baileys', '@adiwajshing/baileys']
let baileysLib = null

function baileysApi() {
  if (!baileysLib) {
    let chosen = null
    let firstInstalled = null
    for (const name of BAILEYS_CANDIDATES) {
      let resolved
      try { resolved = require.resolve(name) } catch { continue }
      // the copy the bot already loaded is the one its socket encodes messages with
      if (require.cache[resolved]) { chosen = name; break }
      if (!firstInstalled) firstInstalled = name
    }
    chosen = chosen || firstInstalled
    if (!chosen) throw new Error('No Baileys package found (tried: ' + BAILEYS_CANDIDATES.join(', ') + ')')
    const mod = require(chosen)
    baileysLib = mod && mod.proto ? mod : (mod && mod.default && mod.default.proto ? mod.default : mod)
  }
  const { proto, prepareWAMessageMedia, downloadMediaMessage, normalizeMessageContent } = baileysLib
  for (const [k, v] of Object.entries({ proto, prepareWAMessageMedia, downloadMediaMessage, normalizeMessageContent })) {
    if (!v) throw new Error(`Baileys export "${k}" is missing in this version`)
  }
  return { proto, prepareWAMessageMedia, downloadMediaMessage, normalizeMessageContent }
}

/* ---------------- Session helpers ---------------- */

function endSession(key) {
  const s = audioSessions.get(key)
  if (s) clearTimeout(s.timer)
  audioSessions.delete(key)
}

/* ---------------- Media extraction ---------------- */

function describeMedia(content, download) {
  if (!content) return null
  for (const [field, kind] of Object.entries(MEDIA_TYPES)) {
    const part = content[field]
    if (part) {
      const mime = String(part.mimetype || '').split(';')[0].trim().toLowerCase()
      return {
        kind,
        ext: EXT_BY_MIME[mime] || DEFAULT_EXT[kind],
        seconds: Number(part.seconds || 0),
        animated: Boolean(part.isAnimated),
        download
      }
    }
  }
  return null
}

function extractMedia(sock, msg) {
  const { downloadMediaMessage, normalizeMessageContent } = baileysApi()
  const fetchBuffer = (m) =>
    downloadMediaMessage(m, 'buffer', {}, {
      logger: sock.logger,
      reuploadRequest: sock.updateMediaMessage
    })

  const content = normalizeMessageContent(msg.message)
  const direct = describeMedia(content, () => fetchBuffer(msg))
  if (direct) return direct

  const ctxInfo = content?.extendedTextMessage?.contextInfo
  if (!ctxInfo?.quotedMessage) return null

  return describeMedia(normalizeMessageContent(ctxInfo.quotedMessage), () =>
    fetchBuffer({
      key: {
        remoteJid: msg.key.remoteJid,
        id: ctxInfo.stanzaId,
        participant: ctxInfo.participant
      },
      message: ctxInfo.quotedMessage
    })
  )
}

/* ---------------- ffmpeg ---------------- */

let ffmpegInfo = null

function packagedFfmpegPath(name) {
  try {
    const m = require(name)
    const p = typeof m === 'string' ? m : m && m.path
    return typeof p === 'string' ? p : null
  } catch {
    return null
  }
}

// Finds a working ffmpeg that has libwebp + libopus (PATH, FFMPEG_PATH, ffmpeg-static, @ffmpeg-installer)
function getFfmpeg() {
  if (ffmpegInfo) return ffmpegInfo
  const candidates = [process.env.FFMPEG_PATH, 'ffmpeg', packagedFfmpegPath('ffmpeg-static'), packagedFfmpegPath('@ffmpeg-installer/ffmpeg')].filter(Boolean)
  let problem = null
  for (const bin of candidates) {
    try {
      const list = execFileSync(bin, ['-hide_banner', '-encoders'], {
        encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, windowsHide: true
      })
      const hasOpus = /\blibopus\b/.test(list)
      const hasWebp = /\blibwebp\b/.test(list)
      const hasAnim = /\blibwebp_anim\b/.test(list)
      if (hasOpus && (hasWebp || hasAnim)) {
        ffmpegInfo = {
          bin,
          animCodec: hasAnim ? 'libwebp_anim' : 'libwebp',
          stillCodec: hasWebp ? 'libwebp' : 'libwebp_anim'
        }
        return ffmpegInfo
      }
      problem = `ffmpeg ("${bin}") was found but it was built without ${hasOpus ? 'libwebp' : 'libopus'}`
    } catch (e) {
      problem = problem || 'ffmpeg was not found'
    }
  }
  throw new Error(`${problem}. Install a full ffmpeg build and add it to PATH (or set FFMPEG_PATH).`)
}

function ffmpegError(err) {
  const raw = String((err && err.stderr) || (err && err.message) || err)
  if (/matches no streams|does not contain any stream/i.test(raw)) {
    return Object.assign(new Error('The video has no audio track.'), { code: 'NO_AUDIO' })
  }
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  return new Error('ffmpeg failed: ' + lines.slice(-2).join(' | ').slice(0, 300))
}

async function runFfmpeg(inputBuffer, inExt, outExt, args) {
  const { bin } = getFfmpeg()
  const tag = crypto.randomBytes(6).toString('hex')
  const src = nodePath.join(nodeOs.tmpdir(), `aud_${tag}.${inExt}`)
  const dst = nodePath.join(nodeOs.tmpdir(), `aud_${tag}_out.${outExt}`)

  try {
    await fsp.writeFile(src, inputBuffer)
    const { stderr } = await execFileAsync(bin, ['-hide_banner', '-nostdin', '-y', '-i', src, ...args, dst], {
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
    })
    return { data: await fsp.readFile(dst), stderr }
  } catch (err) {
    throw ffmpegError(err)
  } finally {
    await fsp.unlink(src).catch(() => {})
    await fsp.unlink(dst).catch(() => {})
  }
}

/* ---------------- WebP + EXIF (pure Node, no node-webpmux needed) ---------------- */

function readRiffChunks(buf) {
  if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('Sticker data is not a WebP file.')
  }
  const end = Math.min(buf.length, 8 + buf.readUInt32LE(4))
  const chunks = []
  let pos = 12
  while (pos + 8 <= end) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    chunks.push({ id, data: buf.subarray(pos + 8, Math.min(pos + 8 + size, buf.length)) })
    pos += 8 + size + (size & 1)
  }
  return chunks
}

function writeRiff(chunks) {
  const parts = [Buffer.from('WEBP', 'ascii')]
  for (const c of chunks) {
    const head = Buffer.alloc(8)
    head.write(c.id, 0, 'ascii')
    head.writeUInt32LE(c.data.length, 4)
    parts.push(head, c.data)
    if (c.data.length & 1) parts.push(Buffer.alloc(1))
  }
  const body = Buffer.concat(parts)
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

// width / height / alpha of a "simple" (non-VP8X) WebP
function simpleWebpInfo(chunks) {
  const lossless = chunks.find((c) => c.id === 'VP8L')
  if (lossless && lossless.data.length >= 5 && lossless.data[0] === 0x2f) {
    const bits = lossless.data.readUInt32LE(1)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, alpha: ((bits >>> 28) & 1) === 1 }
  }
  const lossy = chunks.find((c) => c.id === 'VP8 ')
  if (lossy && lossy.data.length >= 10 && lossy.data[3] === 0x9d && lossy.data[4] === 0x01 && lossy.data[5] === 0x2a) {
    return { width: lossy.data.readUInt16LE(6) & 0x3fff, height: lossy.data.readUInt16LE(8) & 0x3fff, alpha: false }
  }
  throw new Error('Unsupported WebP layout.')
}

// Writes (or replaces) the EXIF chunk that carries the sticker pack name / author
function setWebpExif(webp, exif) {
  const chunks = readRiffChunks(webp)
  const oldHead = chunks.find((c) => c.id === 'VP8X')
  const rest = chunks.filter((c) => c.id !== 'VP8X' && c.id !== 'EXIF')

  const head = Buffer.alloc(10)
  if (oldHead && oldHead.data.length >= 10) {
    oldHead.data.copy(head, 0, 0, 10)
    head[0] |= 0x08 // EXIF flag
  } else {
    const info = simpleWebpInfo(rest)
    head[0] = 0x08 | (info.alpha ? 0x10 : 0)
    head.writeUIntLE(info.width - 1, 4, 3)
    head.writeUIntLE(info.height - 1, 7, 3)
  }

  const exifChunk = { id: 'EXIF', data: exif }
  const xmp = rest.findIndex((c) => c.id === 'XMP ')
  const ordered = xmp === -1 ? [...rest, exifChunk] : [...rest.slice(0, xmp), exifChunk, ...rest.slice(xmp)]
  return writeRiff([{ id: 'VP8X', data: head }, ...ordered])
}

function buildExif(pack, author) {
  const meta = {
    'sticker-pack-id': `audio.sticker.${crypto.randomBytes(4).toString('hex')}`,
    'sticker-pack-name': pack,
    'sticker-pack-publisher': author,
    emojis: ['🔊']
  }
  const header = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00
  ])
  const json = Buffer.from(JSON.stringify(meta), 'utf-8')
  const exif = Buffer.concat([header, json])
  exif.writeUIntLE(json.length, 14, 4)
  return exif
}

/* ---------------- Sticker building ---------------- */

function scaleFilter(size) {
  return `scale=${size}:${size}:force_original_aspect_ratio=decrease,format=rgba,` +
    `pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=#00000000,setsar=1`
}

async function videoToWebp(buffer, inExt) {
  const { animCodec } = getFfmpeg()
  let best = null

  for (const p of STICKER_PROFILES) {
    const { data } = await runFfmpeg(buffer, inExt || 'mp4', 'webp', [
      '-t', String(AUDIO_LIMIT_SEC),
      '-vf', `fps=${p.fps},${scaleFilter(p.size)}`,
      '-c:v', animCodec,
      '-lossless', '0',
      '-compression_level', '6',
      '-q:v', String(p.quality),
      '-loop', '0',
      '-preset', 'picture',
      '-an'
    ])
    if (!best || data.length < best.length) best = data
    if (data.length <= TARGET_STICKER_BYTES) { best = data; break }
  }

  if (best.length > HARD_STICKER_BYTES) {
    throw new Error(`This video is too long / detailed for a sticker (${Math.round(best.length / 1024)} KB). Try a shorter clip.`)
  }
  return best
}

async function imageToWebp(buffer, inExt) {
  const { stillCodec } = getFfmpeg()
  let out = null
  for (const quality of [80, 60, 40]) {
    const { data } = await runFfmpeg(buffer, inExt || 'jpg', 'webp', [
      '-vf', scaleFilter(512),
      '-frames:v', '1',
      '-c:v', stillCodec,
      '-lossless', '0',
      '-q:v', String(quality),
      '-an'
    ])
    out = data
    if (data.length <= STATIC_STICKER_BYTES) break
  }
  return out
}

async function buildSticker(buffer, media, pack, author) {
  let webp = buffer
  if (media.kind === 'video') webp = await videoToWebp(buffer, media.ext)
  else if (media.kind === 'image') webp = await imageToWebp(buffer, media.ext)
  return setWebpExif(webp, buildExif(pack, author))
}

/* ---------------- Embedded audio (Ogg/Opus) ---------------- */

async function buildEmbeddedAudio(sock, buffer, ext, fallbackSec = 0) {
  const { prepareWAMessageMedia } = baileysApi()
  const limit = String(AUDIO_LIMIT_SEC - 0.1) // keep audio a hair shorter than the sticker

  // pass 1: whatever we got -> stereo Opus (normalises container / timestamps)
  const first = await runFfmpeg(buffer, ext || 'ogg', 'ogg', [
    '-vn',
    '-map', '0:a:0',
    '-t', limit,
    '-af', 'aresample=48000:async=1:first_pts=0',
    '-c:a', 'libopus',
    '-b:a', '64k',
    '-ac', '2',
    '-ar', '48000',
    '-f', 'ogg'
  ])

  // pass 2: -> mono Opus 32k, which is what WhatsApp sound stickers expect
  const { data, stderr } = await runFfmpeg(first.data, 'ogg', 'ogg', [
    '-vn',
    '-c:a', 'libopus',
    '-b:a', '32k',
    '-vbr', 'on',
    '-compression_level', '10',
    '-ac', '1',
    '-ar', '48000',
    '-application', 'audio',
    '-f', 'ogg'
  ])

  if (data.length < 200) throw Object.assign(new Error('The audio is empty or too short.'), { code: 'NO_AUDIO' })

  const lastTime = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop()
  const measured = lastTime ? +lastTime[1] * 3600 + +lastTime[2] * 60 + +lastTime[3] : 0
  const seconds = Math.max(1, Math.min(AUDIO_LIMIT_SEC, Math.round(measured || fallbackSec || 5)))

  const { audioMessage } = await prepareWAMessageMedia(
    { audio: data, mimetype: 'audio/ogg; codecs=opus', ptt: false, seconds },
    { upload: sock.waUploadToServer }
  )
  audioMessage.seconds = seconds
  audioMessage.ptt = false // sound stickers carry a normal audio clip, not a voice note
  audioMessage.mimetype = 'audio/ogg; codecs=opus'
  return audioMessage
}

/* ---------------- Protobuf patch + sending ---------------- */

// Baileys' compiled protobuf does not know the sound-sticker fields yet:
//   Message.audioStickerMessage (134, FutureProofMessage) -> stickerMessage -> StickerMessage.audioMessage (26)
// so the two encoders are wrapped; every other message is encoded exactly as before.
function patchProtobuf(proto) {
  const Msg = proto && proto.Message
  if (!Msg) throw new Error('Baileys proto.Message was not found')
  if (Msg.__audioStickerPatched) return
  if (!Msg.StickerMessage || !Msg.AudioMessage || !Msg.FutureProofMessage) {
    throw new Error('This Baileys version has no StickerMessage / AudioMessage / FutureProofMessage in its protobuf')
  }

  const stickerEncode = Msg.StickerMessage.encode
  Msg.StickerMessage.encode = function (message, writer) {
    const audio = message && message.audioMessage
    if (!audio) return stickerEncode.call(this, message, writer)
    const rest = Object.assign({}, message)
    delete rest.audioMessage
    const w = stickerEncode.call(this, rest, writer)
    Msg.AudioMessage.encode(audio, w.uint32(210).fork()).ldelim() // field 26
    return w
  }

  const messageEncode = Msg.encode
  Msg.encode = function (message, writer) {
    const wrapper = message && message.audioStickerMessage
    if (!wrapper) return messageEncode.call(this, message, writer)
    const rest = Object.assign({}, message)
    delete rest.audioStickerMessage
    const w = messageEncode.call(this, rest, writer)
    Msg.FutureProofMessage.encode(wrapper, w.uint32(1074).fork()).ldelim() // field 134
    return w
  }

  Msg.__audioStickerPatched = true
}

async function sendAudioSticker(sock, chatId, stickerBuffer, animated, audioMessage) {
  const { proto, prepareWAMessageMedia } = baileysApi()
  patchProtobuf(proto)

  const prepared = await prepareWAMessageMedia(
    { sticker: stickerBuffer, isAnimated: Boolean(animated) },
    { upload: sock.waUploadToServer }
  )
  const sticker = prepared.stickerMessage
  sticker.isAnimated = Boolean(animated)
  sticker.audioMessage = audioMessage

  return sock.relayMessage(
    chatId,
    {
      audioStickerMessage: { message: { stickerMessage: sticker } },
      messageContextInfo: { messageSecret: crypto.randomBytes(32) }
    },
    {}
  )
}

/* ---------------- Command logic (shared) ---------------- */

async function handleSaudio(ctx) {
  const { sock, msg, from, reply } = ctx
  const sender = ctx.sender || msg.key.participant || from
  const sessionKey = `${from}:${sender}`
  const args = (ctx.text || '').trim()
  const cmdName = `${ctx.prefix || '.'}${ctx.command || 'saudio'}`
  const react = (emoji) =>
    Promise.resolve()
      .then(() => (ctx.react ? ctx.react(emoji) : sock.sendMessage(from, { react: { text: emoji, key: msg.key } })))
      .catch(() => {})

  try {
    const activeSession = audioSessions.get(sessionKey)

    // --- cancel ---
    if (/^(cancel|stop)$/i.test(args)) {
      if (!activeSession) return await reply('There is no active Audio Sticker session.')
      endSession(sessionKey)
      return await reply('Audio Sticker session cancelled.')
    }

    // --- find media (own message or quoted) ---
    const media = extractMedia(sock, msg)

    if (!media) {
      return await reply(
        `Send or reply to a video / photo / sticker with *${cmdName}*\n\n` +
        `• Video: becomes a sticker with sound right away\n` +
        `• Photo / sticker: then reply to an audio / VN with *${cmdName}* (within ${SESSION_TTL_SEC} seconds)\n` +
        `• Pack info: *${cmdName} Pack|Author*\n` +
        `• Cancel: *${cmdName} cancel*`
      )
    }

    // --- session active + audio/video reply -> merge ---
    if (activeSession && (media.kind === 'audio' || media.kind === 'video')) {
      react('⏳')
      const voice = await buildEmbeddedAudio(sock, await media.download(), media.ext, media.seconds)
      await sendAudioSticker(sock, from, activeSession.sticker, activeSession.animated, voice)
      endSession(sessionKey)
      return await react('✅')
    }

    // --- audio sent without a sticker session ---
    if (media.kind === 'audio') {
      return await reply(`Send a photo / sticker first with *${cmdName}*, then reply to it with the audio.`)
    }

    // --- build the sticker ---
    react('⏳')
    let [pack, author] = args.split('|').map((v) => v.trim())
    pack = pack || global.stickpack || '🅢🅗🅘🅡🅞-🅜🅓'
    author = author || global.stickauth || 'ᵇʸ ⁱⁿᵒˢᵘᵏᵉ'

    const original = await media.download()
    const stickerBuf = await buildSticker(original, media, pack, author)
    const isAnimated = media.kind === 'video' || (media.kind === 'sticker' && media.animated)

    // --- video: use its own audio track ---
    if (media.kind === 'video') {
      let voice = null
      try {
        voice = await buildEmbeddedAudio(sock, original, media.ext, media.seconds)
      } catch (err) {
        if (err.code !== 'NO_AUDIO') throw err
        console.error('[saudio] video has no usable audio, opening a session instead:', err.message)
      }
      if (voice) {
        await sendAudioSticker(sock, from, stickerBuf, true, voice)
        return await react('✅')
      }
    }

    // --- photo / sticker / silent video: wait for audio ---
    endSession(sessionKey)
    const timer = setTimeout(() => {
      if (audioSessions.delete(sessionKey)) {
        sock.sendMessage(
          from,
          { text: 'Audio Sticker session expired. Send the photo again to restart.' },
          { quoted: msg }
        ).catch(() => {})
      }
    }, SESSION_TTL_SEC * 1000)
    audioSessions.set(sessionKey, { sticker: stickerBuf, animated: isAnimated, timer })

    return await reply(
      `*Audio Sticker session started* (${SESSION_TTL_SEC} seconds)\n\n` +
      `Now reply to a voice note / audio / video with *${cmdName}*\n` +
      `Cancel with *${cmdName} cancel*`
    )
  } catch (e) {
    console.error('[saudio]', e)
    react('❌')
    return Promise.resolve(reply('❌ Error: ' + String((e && e.message) || e).slice(0, 300))).catch(() => {})
  }
}

/* ---------------- Command ---------------- */

cmd({
    pattern: 'saudio',
    alias: ['audiosticker', 'audsticker'],
    desc: 'Audio sticker (audio embedded inside the sticker)',
    category: 'convert',
    react: '🔊',
    filename: __filename
}, async (conn, mek, m, { from, sender, q, prefix, command, reply }) => {
    await handleSaudio({
        sock: conn,
        msg: mek,
        from,
        sender: sender || mek.key.participant || from,
        text: q,
        prefix,
        command,
        reply
    })
})
