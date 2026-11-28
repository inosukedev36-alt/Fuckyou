module.exports = {
    // Look like a phone: message ids that other bots (and /devicecheck) read as iPhone or Android instead of "web".
    // 'auto' = one fixed phone type per bot number · 'ios' · 'android' · 'mixed' (random per message) · 'off'
    // Only the id label changes; WhatsApp itself still sees a linked device. See lib/msgid.js
    MESSAGE_ID_STYLE: 'mixed',

    PREFIX: "/",
    EXTRA_PREFIXES: [],   // also accept these (so ".ytpl" and "/ytpl" both work). Set [] to disable.
    MODE: "private", 

    BOT_NAME: 'SHIRO MD',
    DESCRIPTION: 'Powered by SHIRO MD',
    OWNER_NAME: 'ᴵⁿᵒˢᵘᵏᵉ 𝙓 ',
    OWNER_NUMBER: '94760036688', 
    OWNER_LID: '6271289786544',
    OWNER_WEBSITE: 'https://inosuke.hashibira.workers.dev/',
    OWNER_GITHUB: '',
    OWNER_CHANNEL: 'https://whatsapp.com/channel/120363432680694902',

    MENU_IMAGE_URL: 'https://img3.pixhost.to/images/6927/798851472_img-20261101-wa0232.jpg',
    ALIVE_IMG: 'https://img3.pixhost.to/images/6927/798851472_img-20261101-wa0232.jpg',

    AUTO_READ_STATUS: false,
    AUTO_REACT: false,
    AUTO_TYPING: false,
    REACT_EMOJIS: ['❤','💕','😻','🧡','💛','💚','💙','💜','🎉','👋'],

    // 👇 ස්ථිර sudo ලැයිස්තුව (Trusted numbers - auto react + sudo) 👇
    TRUSTED_NUMBERS: [
        { number: '94711945686', react: '😘' },
        { number: '94769895314', react: '😘' },
        { number: '94723268506', react: '😽' },
        { number: '94752460283', react: '🖕🏿' }
    ],

    // 👇 Anti-Link සහ Anti-Bot සක්‍රීය කිරීම 👇
    ANTI_LINK: false,
    ANTI_BOT: true,
    ANTI_COMMAND_DELETE: false, // Private mode එකේදී non-sudo commands delete කරනවා

    // 👇 Known Bot Signatures (හඳුනාගැනීමට) 👇
    BOT_SIGNATURES: [
        'BAILEYS', 'WhiskeySockets', 'Baileys', 
        'SHIRO-MD', 'SHIRO MD'
    ],

    // ═══ 💕 AI GIRLFRIEND MODE ═══
    GF: {
        ENABLED: true,
        // true  → only group commands + the /gf command work as typed commands for normal users.
        //         Everything else ("/ytpl <url>", "/sticker" ...) is done BY HER when they just ask her.
        //         Owner / sudo can still type every command directly.
        ONLY_MODE: true,
        DEFAULT_GF: 'chika',          // who she is until her boyfriend picks someone else with /gf (13 to choose from)
        // She has ONE boyfriend: the owner (config.OWNER_NUMBER / OWNER_LID / the paired number).
        // Everybody else is a normal, polite acquaintance: no pet names, no flirting, no jealousy.
        BOYFRIEND_NUMBERS: [94716666886,94712805832,94752805835],        // extra numbers (digits only) that she should also treat as her boyfriend
        ASK_STRANGERS: false,          // ask everybody else for name / age / birthday too? (false = only her boyfriend is asked)
        STRANGERS_ADMIT_AI: false,     // someone who is not her boyfriend and sincerely asks "are you an AI?" gets an honest answer
        MEMORY_HOURS: 24,             // how long every message of a user is remembered
        CONFIRM_SECONDS: 60,          // how long she waits for "yes" before cancelling kick/promote/etc.
        // A new plugin with a `use:` line (or a gf: block) in its cmd({}) becomes something she can do — no other file to edit.
        AUTO_TOOLS: true,
        MARKER_MAX_CHARS: 600,        // size cap of the "tools she may start" line in the AI prompt (the AI endpoint is a GET url)
        // Typed commands that normal users may still use directly (besides category "group")
        DIRECT_COMMANDS: ['gf', 'jid'],
        // Never runnable from natural language, whoever asks (must be typed with the prefix by owner/sudo)
        NL_BLOCKED: ['eval', 'ev', 'exec', 'restart', 'update', 'shutdown'],
    },

    OWNER_ONLY_COMMANDS: [
         'remove', 'mute', 'unmute', 'addsudo', 'delsudo', 'boom',
        'eval', 'ev', 'restart', 'update', 
        'kick', 'add', 'promote', 'demote'
    ],

    // ═══ 🛡️ ANTI-BAN (lib/antiban.js) ═══
    // Every key is optional — lib/antiban.js has a default for all of them. Only what you want to change needs to stay here.
    ANTIBAN: {
        ENABLED: true,
        // 'YYYY-MM-DD' = the day this number was first linked. For its first ~3 weeks the limits are scaled down
        // (25% → 40% → 60% → 80% → 100%). Leave '' for a number that has been running for a long time.
        WARMUP: { LINKED_AT: '' },
        SEND: {
            PER_CHAT_PER_MIN: 30,      // messages per minute to ONE chat (after a burst of 8)
            GLOBAL_PER_MIN: 45,        // …to everybody together (after a burst of 15)
            GLOBAL_PER_HOUR: 900,
            GLOBAL_PER_DAY: 7000,
            MAX_WAIT_MS: 90000,        // a message that would have to wait longer than this is refused, not held
        },
        COLD: { PER_HOUR: 15, PER_DAY: 60 },   // NEW 1:1 chats the bot starts itself (people who never wrote first)
        // The same text again and again is what spam looks like. (/boom and the like run into this on purpose.)
        DUPLICATE: { ENABLED: true, PER_CHAT_MAX: 3, PER_CHAT_WINDOW_SEC: 60, ACROSS_CHATS_MAX: 8, ACROSS_WINDOW_SEC: 600 },
        TYPING: { ENABLED: true, MAX_MS: 3500 },
        PRESENCE: { ENABLED: true, IDLE_OFFLINE_SEC: [25, 75] },   // online only while active, offline after this idle time
        INBOUND: { STALE_SEC: 180, PER_USER_MAX: 8, PER_USER_WINDOW_SEC: 60, PENALTY_SEC: 120 },   // STALE_SEC: 0 = answer old queued commands too
        GROUP_ACTIONS: { ADD_PER_HOUR: 10 },
        RECONNECT: { ON_REPLACED: 'stop', ON_FORBIDDEN: 'stop' },   // 'stop' = do not fight / hammer · 'retry' = keep trying
    },

       ANIME_NEWS: {
    ENABLED: true, INTERVAL_MINUTES: 5, TARGET_JIDS: ['120363431533516657@newsletter'],
    VIEW_CHANNEL_JID: '120363431533516657@newsletter',   // button එක යන channel එක
    VIEW_CHANNEL_NAME: ' 𝓐𝓷𝓲𝓶𝓮 𝓝𝓮𝔀𝓼 𝓑𝔂 𝓘𝓷𝓸𝓼𝓾𝓴𝓮',
     VIEW_CHANNEL_LINK: 'https://whatsapp.com/channel/0029Vb9co3HFi8xjeHvhRI2m',  // JID නැත්නම් link එකෙන් auto හොයාගන්නවා
    SUMMARY_LANG: 'english',                                  // summary සිංහලෙන් ඕන නම්
       }
    }
