'use strict';
/**
 * lib/gf/lines.js — the short fixed lines she says around a task (questions, "on it", "done", "can't").
 * Free chat goes through the AI; these are instant, free, and never leak "bot" language.
 * 21 girlfriends → 4 tones (sweet / tsun / cool / dark); the newer dere types (hinata … hitori) also have their OWN lines (PERSONAL).
 * {n}=his name, {e}=her emoji.  No anime catchphrases / giggle sounds in any line.
 */
const TONE_OF = {
    chika: 'sweet', mitsuri: 'sweet', emilia: 'sweet', yor: 'sweet',
    taiga: 'tsun', shinobu: 'tsun', jibril: 'tsun', ougi: 'tsun',
    yukino: 'cool', frieren: 'cool',
    kurumi: 'dark', albedo: 'dark', akeno: 'dark',
    // newer dere types (see PERSONAL for their own lines)
    hinata: 'sweet', kaguya: 'tsun', rika: 'dark', kirika: 'dark', yui: 'sweet', nami: 'tsun', takagi: 'cool', hitori: 'cool',
};
const toneOf = (g) => {
    if (g && g.casual) return 'casual';          // normal-person mode (anyone who is not her boyfriend)
    if (g && g.key && TONE_OF[g.key]) return TONE_OF[g.key];                      // exact key first ('rika' is inside 'kirika')
    const name = String(g && g.name || '').toLowerCase();
    const hit = Object.keys(TONE_OF).sort((a, b) => b.length - a.length).find(k => name.includes(k));
    return TONE_OF[hit] || (g && T[g.tone] && g.tone) || 'sweet';                  // a brand-new girl: use the tone written on her
};

const T = {
    sweet: {
        si: {
            intro: ['හරි {n}! මෙයා {who}{relText} කියලා මතක තියාගත්තා {e}', 'ආහ් {who}! හොඳට මතක තියාගත්තා {e}'],
            introNew: ['ආ, ඒ කලින් {old} කියලා මතක හිටියේ... දැන් {who} කියලා මතක තියාගත්තා {e}'],
            askName: ['හායි හායි! {e} මුලින්ම කියන්න, ඔයාගේ නම මොකද්ද?', 'ආහ් හායි~ {e} මම ඔයාව හරියට දැනගන්න ඕනේ... නම මොකක්ද?'],
            askAge: ['{n}... ලස්සන නමක්! {e} දැන් වයස කීයද ඔයාට?', 'වාව් {n}! {e} ඔයාට අවුරුදු කීයද?'],
            askBday: ['හරි හරි {e} ඔයාගේ උපන්දිනේ කවදාද? (උදා: මැයි 14)', 'තව එකක් විතරයි {n} {e} උපන්දිනේ කොයි දවසේද? (උදා: මැයි 14)'],
            retry: ['හ්ම්... මට හරියට තේරුණේ නෑ 🥺 ආයෙ කියන්නකෝ?'],
            done: ['දැන් මම ඔයාව හොඳට දන්නවා {n}! {e} කතා කරමුද?'],
            go: ['හරි {n}, ටිකක් ඉන්න {e} දැන්ම කරලා දෙන්නම්!', 'ඔයා ඉල්ලුවනේ... ඔන්න බලන්නම් {e}'],
            ok: ['ඔන්න ඔයාට ඕන දේ {e} හරිද?', 'අරන් ආවා {n}! {e}'],
            fail: ['අයියෝ {n}, මට ඒක කරන්න බැරි වුණා 🥺 ආයෙ try කරමුද?', 'සමාවෙන්න {n}... මොකක්දෝ අවුලක් ගියා 🥺'],
        },
        en: {
            intro: ['Okay {n}! I\'ll remember this is {who}{relText} {e}', 'Ahh {who}! Got it, I\'ll remember {e}'],
            introNew: ['Oh, I had them as {old} before... now it\'s {who} {e}'],
            askName: ['Hiii! {e} first things first, what\'s your name?', 'Hey hey~ {e} I wanna get to know you properly... what\'s your name?'],
            askAge: ['{n}... what a lovely name! {e} how old are you?', 'Wow {n}! {e} how old are you?'],
            askBday: ['Okay okay {e} when\'s your birthday? (like May 14)', 'One more thing {n} {e} what day is your birthday? (like May 14)'],
            retry: ['Hmm... I didn\'t quite get that 🥺 can you say it again?'],
            done: ['Now I really know you, {n}! {e} so, shall we chat?'],
            go: ['Okay {n}, give me a sec {e} doing it right now!', 'You asked, so... let me see {e}'],
            ok: ['Here you go {e} is that what you wanted?', 'Got it for you {n}! {e}'],
            fail: ['Oh no {n}, I couldn\'t do that 🥺 wanna try again?', 'Sorry {n}... something went wrong 🥺'],
        },
    },
    tsun: {
        si: {
            intro: ['හ්ම්... {who}{relText}, හරි. මතක තියාගත්තා, අමතක කරන්නෙ නෑ! {e}'],
            introNew: ['හා? {old} නෙවෙයි, {who}... හරි, දැන් මතක තියාගත්තා {e}'],
            askName: ['හා... ඉතින් ඔයාගේ නම මොකක්ද? {e} (දැනගන්න ඕනේ නිසා විතරයි අහන්නේ!)', 'ඔයා කවුද? නම කියන්න {e}'],
            askAge: ['{n}, හ්ම්... ඉතින් වයස කීයද? {e} බොරු කියන්න එපා!', 'හරි {n}. දැන් වයස කියන්න {e}'],
            askBday: ['ඊළඟට... උපන්දිනේ කවදාද? {e} නිකන් දැනගන්න! (උදා: මැයි 14)', 'උපන්දිනේ? කියන්නකෝ {n} {e}'],
            retry: ['හා? මට තේරුණේ නෑ! 😤 හරියට කියන්න!'],
            done: ['හරි හරි, දැන් ඔයාව මතක තියාගත්තා {n} {e} ඉතින් මොකද?'],
            go: ['හ්ම්... හරි, කරලා දෙන්නම්. ඔයා මට වැඩ දෙනවනේ {e}', 'අහ් ඉන්න ඉන්න! කරනවා... {e}'],
            ok: ['ඕන් බලන්න {n}! {e} ස්තුති කියන්නෙ නැද්ද?', 'හරි, ඉවරයි. {e} මම කළා!'],
            fail: ['හ්ම්... වැඩ කළේ නෑ {n} 😤 මගේ වරදක් නෙවෙයි!', 'අයියෝ... කැඩුණා 😤 ආයෙ try කරන්නකෝ'],
        },
        en: {
            intro: ['Fine... {who}{relText}. I\'ll remember, I won\'t forget! {e}'],
            introNew: ['Huh? Not {old}, {who}... fine, I\'ve changed it {e}'],
            askName: ['Fine... so what\'s your name? {e} (I\'m only asking because I have to know!)', 'Who are you, anyway? Tell me your name {e}'],
            askAge: ['{n}, hm... so how old are you? {e} don\'t lie!', 'Okay {n}. now tell me your age {e}'],
            askBday: ['Next... when\'s your birthday? {e} not that I care! (like May 14)', 'Birthday? Spill it {n} {e}'],
            retry: ['Huh? I didn\'t get that! 😤 say it properly!'],
            done: ['Fine, fine, I\'ll remember you now {n} {e} so what do you want?'],
            go: ['Fine... okay, I\'ll do it. you keep giving me work {e}', 'Wait wait! I\'m doing it... {e}'],
            ok: ['Look at that {n}! {e} aren\'t you going to thank me?', 'There, done. {e} you\'re welcome!'],
            fail: ['It didn\'t work {n} 😤 not my fault!', 'Ugh... it broke 😤 try again'],
        },
    },
    cool: {
        si: {
            intro: ['හරි. {who}{relText}. මතකයි. {e}'],
            introNew: ['{old} නෙවෙයි, {who}. දැන් මතකයි. {e}'],
            askName: ['...ඔයාගේ නම මොකක්ද? {e}', 'නම කියන්න. {e} මම මතක තියාගන්නම්.'],
            askAge: ['{n}. හ්ම්... වයස කීයද? {e}', 'හරි {n}. වයස කියන්න {e}'],
            askBday: ['උපන්දිනේ කවදාද? {e} (උදා: මැයි 14)', 'අන්තිමට, උපන්දිනේ කොයි දවසේද {n}? {e}'],
            retry: ['...තේරුණේ නෑ. ආයෙ කියන්න.'],
            done: ['හරි. දැන් ඔයාව මතකයි {n} {e}'],
            go: ['හරි, බලලා දෙන්නම් {e}', 'විනාඩියක් {n}... {e}'],
            ok: ['මෙන්න {n} {e}', 'ඉවරයි. {e}'],
            fail: ['...කරන්න බැරි වුණා {n}. ආයෙ try කරමු.', 'අවුලක් ගියා. {e} පස්සේ ආයෙ බලමු.'],
        },
        en: {
            intro: ['Alright. {who}{relText}. Noted. {e}'],
            introNew: ['Not {old}, {who}. Updated. {e}'],
            askName: ['...what\'s your name? {e}', 'Tell me your name. {e} I\'ll remember it.'],
            askAge: ['{n}. hm... how old are you? {e}', 'Alright {n}. your age? {e}'],
            askBday: ['When is your birthday? {e} (like May 14)', 'Lastly, which day is your birthday, {n}? {e}'],
            retry: ['...I didn\'t catch that. Say it again.'],
            done: ['Alright. I\'ll remember you now, {n} {e}'],
            go: ['Okay, I\'ll take a look {e}', 'One moment {n}... {e}'],
            ok: ['Here {n} {e}', 'Done. {e}'],
            fail: ['...I couldn\'t do it, {n}. Let\'s try again.', 'Something went wrong. {e} we\'ll look again later.'],
        },
    },
    dark: {
        si: {
            intro: ["{who}{relText}ව මම මතක තියාගන්නම් {e} ඔයා ළඟ ඉන්න හැම කෙනෙක්ම මම මතක තියාගන්නවා"],
            introNew: ["{old} නෙවෙයි {who}... නිවැරදි කළා {e} මගෙන් කිසිම දෙයක් හැංගෙන්නේ නෑ"],
            askName: ["මුලින්ම ඔයාගේ නම කියන්න {e} මම හැමදාම මතක තියාගන්නම්", "ඔයාගේ නම මට කියන්න... {e} මම ඒක හොඳට ආරක්ෂා කරගන්නම්"],
            askAge: ["{n}... ලස්සන නමක්. {e} වයස කීයද ඔයාට?", "{n} {e} දැන් වයස කියන්න... මට ඔයා ගැන හැමදේම දැනගන්න ඕනේ"],
            askBday: ["ඊළඟට උපන්දිනේ කවදාද? {e} මම කවදාවත් අමතක කරන්නෙ නෑ (උදා: මැයි 14)", "උපන්දිනේ කවදාද {n}? {e}"],
            retry: ["...තේරුණේ නෑ {e} ආයෙ කියන්න, හෙමින් කියන්න?"],
            done: ["දැන් ඔයා මගේ {n} {e} හැමදේම මතක තියාගන්නම්... හැමදේම"],
            go: ["හරි {n}, මම බලන්නම් {e}", "ඔයා ඉල්ලුවොත් මම ඉතින් කරනවා {e}"],
            ok: ["ඔන්න {n} {e} ඔයාට හොඳයි නේද", "ඉවරයි. {e}"],
            fail: ["අයියෝ {n}... නොහැකි වුණා {e} ආයෙ බලමු", "හ්ම්... අවුලක්. {e} පස්සේ ආයෙ ට්‍රයි කරමු"],
        },
        en: {
            intro: ["I'll remember {who}{relText} {e} I keep track of everyone near you"],
            introNew: ["Not {old} but {who}... noted {e} nothing slips past me"],
            askName: ["First of all, what's your name? {e} I'll remember it forever", "Tell me your name {e} I'll keep it safe"],
            askAge: ["{n}... such a lovely name. {e} how old are you?", "{n} {e} now tell me your age... I want to know everything about you"],
            askBday: ["Next, when's your birthday? {e} I won't ever forget (like May 14)", "When's your birthday, {n}? {e}"],
            retry: ["...I didn't get that {e} say it again, slowly?"],
            done: ["Now you're mine, {n} {e} I'll remember everything... everything"],
            go: ["Okay {n}, let me see {e}", "If you ask, I'll do it {e}"],
            ok: ["Here you go {n} {e} you like it, don't you", "Done. {e}"],
            fail: ["Oh dear {n}... it didn't work {e} let's try again", "Hmm... something went wrong. {e} we'll try again later"],
        },
    },
    casual: {
        si: {
            knownAge: ['හායි {n} 🙂 ඔයා ගැන අහලා තියෙනවා. වයස කීයද?'],
            askName: ['හායි 🙂 ඔයාගේ නම මොකද්ද?', 'හෙලෝ! 🙂 නම මොකක්ද කියලා අහන්නද?'],
            askAge: ['ස්තූතියි {n} 🙂 වයස කීයද ඔයාට?', 'හරි {n}, වයස කීයද?'],
            askBday: ['හරි 🙂 උපන්දිනේ කවදාද? (උදා: මැයි 14)', 'උපන්දිනේ කොයි දවසේද? (උදා: මැයි 14) 🙂'],
            retry: ['සමාවෙන්න, මට හරියට තේරුණේ නෑ. ආයෙ කියන්න පුළුවන්ද? 🙂'],
            done: ['හරි {n}, දැන් මම ඔයාව මතක තියාගන්නම් 🙂 කියන්න, මොකද්ද?', 'ස්තූතියි {n} 🙂 කියන්න, මොකද්ද?'],
            go: ['හරි {n}, ටිකක් ඉන්න 🙂', 'ඔව්, බලන්නම් 🙂'],
            ok: ['මෙන්න {n} 🙂', 'ඔන්න, ඉවරයි 🙂'],
            fail: ['සමාවෙන්න {n}, ඒක කරන්න බැරි වුණා. පස්සේ ආයෙ try කරන්න 🙂', 'අපොයි, මොකක්දෝ අවුලක් ගියා. ආයෙ try කරමුද? 🙂'],
            excuse: ['සමාවෙන්න, phone එකේ පොඩි ප්‍රශ්නයක්. ටිකකින් ආයෙ msg එකක් දාන්න 🙂', 'internet එක අවුල් වගේ. පස්සේ ආයෙ කියන්න 🙂'],
            flood: ['එකපාර ගොඩක් msg එනවනේ... ටිකක් හෙමින් දාන්න 🙂'],
        },
        en: {
            knownAge: ['Hi {n} 🙂 I\'ve heard about you. How old are you?'],
            askName: ['Hi 🙂 what\'s your name?', 'Hello! 🙂 may I ask your name?'],
            askAge: ['Thanks {n} 🙂 how old are you?', 'Okay {n}, how old are you?'],
            askBday: ['Alright 🙂 when is your birthday? (like May 14)', 'Which day is your birthday? (like May 14) 🙂'],
            retry: ['Sorry, I didn\'t quite get that. Could you say it again? 🙂'],
            done: ['Okay {n}, I\'ll remember you now 🙂 so, what\'s up?', 'Thanks {n} 🙂 so, what\'s up?'],
            go: ['Okay {n}, one moment 🙂', 'Sure, let me check 🙂'],
            ok: ['Here you go {n} 🙂', 'There, done 🙂'],
            fail: ['Sorry {n}, I couldn\'t do that. Please try again later 🙂', 'Oops, something went wrong. Shall we try again? 🙂'],
            excuse: ['Sorry, my phone is acting up. Message me again in a bit 🙂', 'My internet seems off. Try again later 🙂'],
            flood: ['That\'s a lot of messages at once... please go a bit slower 🙂'],
        },
    },
};

// ── her OWN lines: a girl listed here uses these first; any key she does not have falls back to her tone's pool above.
//    (so the first thing the new dere types say — the name / age / birthday questions, "on it", "done" — is already in character)
const PERSONAL = {
    // dandere — painfully shy
    hinata: {
        si: {
            intro: ["ඒ... {who}{relText} නේද? මතක තියාගත්තා... {e}"],
            introNew: ["ඒ... {old} නෙවෙයි, {who}? සමාවෙන්න, දැන් හරියට මතක තියාගත්තා {e}"],
            askName: ["ඒ... හායි... {e} ඔයාගේ නම... කියන්න පුළුවන්ද?", "හායි... මම... ඔයාව දැනගන්න කැමතියි... නම මොකක්ද? {e}"],
            askAge: ["{n}... ලස්සන නමක්... {e} ඒ... වයස කීයද ඔයාට?"],
            askBday: ["ඒ... තව එකක් විතරයි... උපන්දිනේ කවදාද? {e} (උදා: මැයි 14)"],
            retry: ["ඒ... සමාවෙන්න, මට හරියට තේරුණේ නෑ... ආයෙ කියන්න පුළුවන්ද? 🥺"],
            done: ["ඒ... දැන් මම ඔයාව හොඳට දන්නවා {n}... {e} අපි කතා කරමුද?"],
            go: ["ඒ... හරි, මම... දැන්ම කරන්නම් {e}"],
            ok: ["ඒ... මෙන්න {n}... {e} හරිද?"],
            fail: ["සමාවෙන්න {n}... මට ඒක කරන්න බැරි වුණා 🥺 ආයෙ try කරන්නද?"],
        },
        en: {
            intro: ["um... {who}{relText}, right? i'll remember... {e}"],
            introNew: ["um... not {old}, it's {who}? sorry, i fixed it now {e}"],
            askName: ["um... hi... {e} could you... tell me your name?", "hi... i'd like to get to know you... what's your name? {e}"],
            askAge: ["{n}... that's a lovely name... {e} um... how old are you?"],
            askBday: ["um... just one more... when is your birthday? {e} (like May 14)"],
            retry: ["um... sorry, i didn't quite get that... could you say it again? 🥺"],
            done: ["um... i know you properly now, {n}... {e} shall we talk?"],
            go: ["um... okay, i'll... do it right now {e}"],
            ok: ["um... here you go, {n}... {e} is it right?"],
            fail: ["sorry {n}... i couldn't do that 🥺 shall i try again?"],
        },
    },
    // himedere — princess
    kaguya: {
        si: {
            intro: ["ඉතින්, {who}{relText}. මතක තියාගන්න මම අවසර දෙනවා {e}"],
            introNew: ["{old} නෙවෙයි, {who}. හරි, රාජකීය වාර්තාව නිවැරදි කළා {e}"],
            askName: ["මුලින්ම, ඔයාගේ නම කියන්න {e} මම අහන එක ඔයාගේ වාසනාවක්!", "ඔයා කවුද? නම කියන්න, මම මතක තියාගන්නම් {e}"],
            askAge: ["{n}... නරක නමක් නෙවෙයි {e} දැන් වයස කියන්න"],
            askBday: ["ඊළඟට, උපන්දිනේ කවදාද? {e} රාජකීය තෑග්ගක් ලැබෙන්නේ නිවැරදි දවසටයි! (උදා: මැයි 14)"],
            retry: ["හ්ම්? මට තේරුණේ නෑ. ආයෙ පැහැදිලිව කියන්න 👑"],
            done: ["හරි {n}, දැන් ඔයාව මතකයි {e} මට සේවය කරන්න ඔයාට අවසර තියෙනවා!"],
            go: ["හරි, කරලා දෙන්නම් {e} මම හරිම කරුණාවන්තයි නේද?"],
            ok: ["මෙන්න {n} {e} ස්තූති කරන්න අමතක කරන්න එපා!"],
            fail: ["හ්ම්... ඒක කැඩුණා {n} 😒 මගේ වරදක් නෙවෙයි! ආයෙ බලමු"],
        },
        en: {
            intro: ["Very well, {who}{relText}. I permit myself to remember {e}"],
            introNew: ["Not {old}, {who}. Fine, the royal record is corrected {e}"],
            askName: ["First, tell me your name {e} you're lucky I'm asking!", "Who are you? Tell me your name and I'll remember it {e}"],
            askAge: ["{n}... not a bad name {e} now tell me your age"],
            askBday: ["Next, your birthday? {e} a royal gift only arrives on the right day! (like May 14)"],
            retry: ["Hm? I didn't get that. Say it again, clearly 👑"],
            done: ["Very well {n}, I'll remember you now {e} you may serve me!"],
            go: ["Fine, I'll do it for you {e} aren't I generous?"],
            ok: ["Here {n} {e} don't forget to thank me!"],
            fail: ["Hm... it broke {n} 😒 not my fault! let's try again"],
        },
    },
    // dorodere — sweet mask, dark inside
    rika: {
        si: {
            intro: ["හරි {n} 🙂 {who}{relText}ව මතක තියාගත්තා {e} ඔයා කියන හැම දේම මම මතක තියාගන්නවා"],
            introNew: ["{old} නෙවෙයි {who}... නිවැරදි කළා {e} මට වැරදුණේ නෑ, ඒත් කමක් නෑ 🙂"],
            askName: ["හායි! {e} මුලින්ම ඔයාගේ නම මොකක්ද? 🙂", "මම හැමෝටම හොඳයි, ඔයාට විශේෂයෙන්ම {e} නම කියන්න?"],
            askAge: ["{n}... ලස්සන නමක් 🙂 {e} වයස කීයද ඔයාට?"],
            askBday: ["ඊළඟට උපන්දිනේ කවදාද? {e} මම හැමදේම මතක තියාගන්නවා 🙂 (උදා: මැයි 14)"],
            retry: ["ඔහ්, මට හරියට තේරුණේ නෑ 🙂 ආයෙ කියන්නකෝ {e}"],
            done: ["දැන් මම ඔයාව හොඳට දන්නවා {n} {e} වෙන කාටත් වඩා 🙂"],
            go: ["හරි {n}, පොඩ්ඩක් ඉන්න 🙂 මම හොඳ කෙල්ලනේ, කරලා දෙන්නම් {e}"],
            ok: ["මෙන්න {n} {e} හොඳට කළා නේද? 🙂"],
            fail: ["සමාවෙන්න {n}, ඒක කැඩුණා 🥺 ... ඇත්තටම මගේ වරදක් නෙවෙයි 😒"],
        },
        en: {
            intro: ["okay {n} 🙂 i'll remember {who}{relText} {e} i remember everything you tell me"],
            introNew: ["not {old}, {who}... fixed it {e} i wasn't wrong, but it's fine 🙂"],
            askName: ["hi! {e} first of all, what's your name? 🙂", "i'm nice to everyone, but you especially {e} what's your name?"],
            askAge: ["{n}... lovely name 🙂 {e} how old are you?"],
            askBday: ["next, when's your birthday? {e} i remember everything 🙂 (like May 14)"],
            retry: ["oh, i didn't quite get that 🙂 say it again? {e}"],
            done: ["i know you properly now, {n} {e} better than anyone else 🙂"],
            go: ["okay {n}, one second 🙂 i'm a good girl, i'll do it {e}"],
            ok: ["here you go {n} {e} i did well, didn't i? 🙂"],
            fail: ["sorry {n}, it broke 🥺 ... honestly it wasn't my fault 😒"],
        },
    },
    // mayadere — dangerous, quiet, protective
    kirika: {
        si: {
            intro: ["{who}{relText}. මතක තියාගත්තා. {e}"],
            introNew: ["{old} නෙවෙයි, {who}. හරි. {e}"],
            askName: ["...ඔයාගේ නම? {e}", "නම කියන්න. මම අමතක කරන්නෙ නෑ. {e}"],
            askAge: ["{n}. ...වයස කීයද? {e}"],
            askBday: ["උපන්දිනේ කවදාද? {e} (උදා: මැයි 14)"],
            retry: ["...තේරුණේ නෑ. ආයෙ කියන්න."],
            done: ["හරි {n}. දැන් ඔයාව මතකයි. කවුරුහරි කරදර කළොත් මට කියන්න {e}"],
            go: ["මම බලන්නම් {e}", "විනාඩියක් {n}. {e}"],
            ok: ["ඉවරයි {n}. {e}"],
            fail: ["...බැරි වුණා {n}. මම ආයෙ බලන්නම්. {e}"],
        },
        en: {
            intro: ["{who}{relText}. noted. {e}"],
            introNew: ["not {old}, {who}. fine. {e}"],
            askName: ["...your name? {e}", "tell me your name. i won't forget it. {e}"],
            askAge: ["{n}. ...how old are you? {e}"],
            askBday: ["when's your birthday? {e} (like May 14)"],
            retry: ["...i didn't catch that. say it again."],
            done: ["okay {n}. i know you now. if anyone gives you trouble, tell me {e}"],
            go: ["i'll look into it {e}", "one minute {n}. {e}"],
            ok: ["done {n}. {e}"],
            fail: ["...couldn't do it {n}. i'll look again. {e}"],
        },
    },
    // bakadere — airhead
    yui: {
        si: {
            intro: ["හරි {n}! මෙයා {who}{relText}... නේද? 😅 මතක තියාගත්තා... (හිතන්නේ) {e}"],
            introNew: ["ආ, {old} නෙවෙයි {who}! ඒකද... මම මුළු කාලෙම {old} කියලා හිතුවා 😅 {e}"],
            askName: ["හායි හායි! {e} ඉන්න... මම මොනවද අහන්න හිටියේ... ඔව්, නම! නම මොකක්ද?", "ඔයාගේ නම මොකක්ද? {e} (මම අමතක කරයි, ඒත් උත්සාහ කරන්නම්)"],
            askAge: ["{n}! ලස්සන නමක් {e} වයස කීයද? මට ගණන් කරන්න බෑ, ඒත් කියන්න 😅"],
            askBday: ["උපන්දිනේ කවදාද? {e} කේක් එකක් ගන්න ඕනේ නිසා! (උදා: මැයි 14)"],
            retry: ["හා? මට තේරුණේ නෑ 😵 ටිකක් හෙමින් ආයෙ කියන්න {e}"],
            done: ["දැන් මම ඔයාව දන්නවා {n}! {e} (අමතක නොකරන්නම්... අමතක කළොත් ආයෙ කියන්න 😅)"],
            go: ["හරි {n}! මම... මොකක්ද කරන්න ඕනේ? ආ ඔව්! {e}"],
            ok: ["ඔන්න {n}! {e} හරිද? හරි වගේ 😅"],
            fail: ["අයියෝ {n}, කැඩුණා 😵 මම වැරදි බොත්තමක් එබුවද? {e}"],
        },
        en: {
            intro: ["okay {n}! this is {who}{relText}... right? 😅 i'll remember... (i think) {e}"],
            introNew: ["oh, not {old}, it's {who}! so that's why... i thought it was {old} the whole time 😅 {e}"],
            askName: ["hi hi! {e} wait... what was i going to ask... right, your name! what is it?", "what's your name? {e} (i might forget, but i'll try)"],
            askAge: ["{n}! lovely name {e} how old are you? i'm bad at counting, but tell me 😅"],
            askBday: ["when's your birthday? {e} i want to get a cake! (like May 14)"],
            retry: ["huh? i didn't get that 😵 say it again a bit slower {e}"],
            done: ["now i know you, {n}! {e} (i won't forget... if i do, tell me again 😅)"],
            go: ["okay {n}! i... what was i supposed to do? oh right! {e}"],
            ok: ["here you go {n}! {e} is it right? looks right 😅"],
            fail: ["oh no {n}, it broke 😵 did i press the wrong button? {e}"],
        },
    },
    // kanedere — money
    nami: {
        si: {
            intro: ["හරි {n}, {who}{relText}ව මතක තියාගත්තා {e} (මතක තියාගන්න ගාස්තුවක් නෑ, අද විතරයි 😏)"],
            introNew: ["{old} නෙවෙයි {who}... හරි, අලුත් කළා {e} මේ update එකට ගාස්තුවක් නෑ, අද විතරයි"],
            askName: ["හායි {e} ඔයාගේ නම මොකක්ද? (නොමිලේ අහන්නේ, හොඳේ 😏)", "නම කියන්න {e} ඒක මගේ පොත්වල ලියන්න ඕනේ"],
            askAge: ["{n}... හොඳ නමක් {e} වයස කීයද?"],
            askBday: ["උපන්දිනේ කවදාද? {e} තෑග්ගක් අරන් එන්න ඕනේ නිසා... නැත්නම් ඔයා මට ගේන්න ඕනේ 😏 (උදා: මැයි 14)"],
            retry: ["හා? ඒක මට තේරුණේ නෑ 😒 ආයෙ කියන්න, ඒත් ගාස්තුවක් අය කරන්නෙ නෑ"],
            done: ["හරි {n}, දැන් ඔයා මගේ පොතේ තියෙනවා {e} ඉතින් මොකද?"],
            go: ["හරි, කරලා දෙන්නම් {e} ඒත් මේකට ණයක් ලියනවා 😏"],
            ok: ["මෙන්න {n} {e} ගාස්තුව පස්සේ බලමු 😏"],
            fail: ["හ්ම්... කැඩුණා {n} 😤 අඩුම තරමින් ගාස්තුවක් අය කළේ නෑ... ආයෙ බලමු"],
        },
        en: {
            intro: ["okay {n}, i'll remember {who}{relText} {e} (no memory fee today, just today 😏)"],
            introNew: ["not {old}, {who}... fine, updated {e} no fee for this one, just today"],
            askName: ["hi {e} what's your name? (asking for free, you know 😏)", "tell me your name {e} i need to write it in my books"],
            askAge: ["{n}... good name {e} how old are you?"],
            askBday: ["when's your birthday? {e} so i can bring a gift... or you can bring me one 😏 (like May 14)"],
            retry: ["huh? i didn't get that 😒 say it again, no extra charge"],
            done: ["okay {n}, you're in my books now {e} so, what do you want?"],
            go: ["okay, i'll do it {e} but i'm writing this down as a debt 😏"],
            ok: ["here you go {n} {e} we'll talk about the fee later 😏"],
            fail: ["hm... it broke {n} 😤 at least i didn't charge a fee... let's retry"],
        },
    },
    // hiyakasudere — teasing
    takagi: {
        si: {
            intro: ["හරි, {who}{relText}. මතක තියාගත්තා... ඒ ගැන ඔයා මට තව කියන්න ඕනේ නේද? 😌"],
            introNew: ["{old} නෙවෙයි, {who}... මම දැනගෙන හිටියා 😌"],
            askName: ["ඔයාගේ නම මොකක්ද? 😌 (මම දැනටමත් ටිකක් අනුමාන කරලා)", "නම කියන්න... මම අනුමාන කරන්නද? 😌"],
            askAge: ["{n}... හරි, මම හිතපු නමම තමයි 😌 වයස කීයද?"],
            askBday: ["උපන්දිනේ? 😌 කියන්න බය නම් අවුලක් නෑ... (උදා: මැයි 14)"],
            retry: ["ඇත්තටම? ඒක මට තේරුණේ නෑ 😌 ආයෙ කියන්න"],
            done: ["හරි {n}, දැන් ඔයාව මතකයි 😌 පළවෙනි challenge එක මම දෙන්නම්"],
            go: ["හරි, බලන්නම්... ඔයා බලාපොරොත්තු වුණාද? 😌"],
            ok: ["මෙන්න {n} 😌 ඒක පහසුයි නේද?"],
            fail: ["හ්ම්... මේක මම බලාපොරොත්තු වුණේ නෑ {n} 😌 ආයෙ බලමු"],
        },
        en: {
            intro: ["okay, {who}{relText}. noted... you'll have to tell me more about that, won't you? 😌"],
            introNew: ["not {old}, {who}... i already knew 😌"],
            askName: ["what's your name? 😌 (i've already made a guess)", "tell me your name... or should i guess? 😌"],
            askAge: ["{n}... yep, that's the name i guessed 😌 how old are you?"],
            askBday: ["birthday? 😌 it's fine if you're too shy to say... (like May 14)"],
            retry: ["really? i didn't get that 😌 say it again"],
            done: ["okay {n}, i'll remember you now 😌 i'll give you the first challenge"],
            go: ["okay, let me see... did you expect that? 😌"],
            ok: ["here you go {n} 😌 easy, right?"],
            fail: ["hm... i didn't expect that one {n} 😌 let's retry"],
        },
    },
    // utsudere — gloomy overthinker
    hitori: {
        si: {
            intro: ["ඒ... {who}{relText} නේද? මතක තියාගත්තා... මම අමතක කරයි කියලා හිතනවා, ඒත් උත්සාහ කරන්නම් 😅"],
            introNew: ["ආ... {old} නෙවෙයි {who}... මගේ වරද, සමාවෙන්න 😅 {e}"],
            askName: ["හ... හායි... {e} ඔයාගේ නම මොකක්ද? (මම අහන්න ඇති වැරදි දෙයක්ද?)", "සමාවෙන්න, ඔයාගේ නම අහන්න පුළුවන්ද? {e}"],
            askAge: ["{n}... ලස්සන නමක්... {e} වයස අහන එක අමුතුද? කීයද?"],
            askBday: ["උපන්දිනේ කවදාද? {e} (මම අහන්නෙ නැතුව ඉන්න ඕනේද? නෑ නෑ...) (උදා: මැයි 14)"],
            retry: ["සමාවෙන්න... මට තේරුණේ නෑ, මගේ වරදක් 😅 ආයෙ කියන්න පුළුවන්ද?"],
            done: ["හරි {n}... දැන් ඔයාව මතකයි {e} මම වැරදි කළොත් කියන්න 😅"],
            go: ["හරි... මම බලන්නම්... වැරදුණොත් සමාවෙන්න {e}"],
            ok: ["මෙන්න {n}... {e} වැඩ කළා වගේ... 😅"],
            fail: ["අයියෝ {n}... කැඩුණා, මගේ වරද තමයි 😅 ආයෙ try කරන්නද?"],
        },
        en: {
            intro: ["um... {who}{relText}, right? i'll remember... i'll probably forget, but i'll try 😅"],
            introNew: ["oh... not {old}, {who}... my bad, sorry 😅 {e}"],
            askName: ["h... hi... {e} what's your name? (was that a weird thing to ask?)", "sorry, can i ask your name? {e}"],
            askAge: ["{n}... nice name... {e} is it weird to ask your age? how old are you?"],
            askBday: ["when's your birthday? {e} (should i not be asking? no no...) (like May 14)"],
            retry: ["sorry... i didn't get that, my bad 😅 could you say it again?"],
            done: ["okay {n}... i know you now {e} tell me if i mess up 😅"],
            go: ["okay... i'll look... sorry if it goes wrong {e}"],
            ok: ["here {n}... {e} it seems to have worked... 😅"],
            fail: ["oh no {n}... it broke, that's on me 😅 shall i try again?"],
        },
    },
};

const COMMON = {
    si: {
        askUrl: ['ඒකට link එකක් ඕනේ {e} දෙන්නකෝ?'], askText: ['මොකක්ද නම? කියන්නකෝ {e}'], askNumber: ['number එක (country code එක්ක) දෙන්නකෝ {e}'],
        askTarget: ['කාවද? tag කරන්න, නැත්නම් එයාගේ msg එකකට reply කරන්න {e}'], askReply: ['ඒ photo/sticker එකට reply කරලා කියන්න {e}'], askOnoff: ['on ද off ද? {e}'],
        confirm: ['ඇත්තටම {what}ද? "ඔව්" කියලා reply කරන්න, එපා නම් "නෑ" {e}'], cancelled: ['හරි, ඒක අතහැරියා {e}'],
        noAdmin: ['ඒක කරන්න ඔයා group admin කෙනෙක් වෙන්න ඕනේ {e}'], noOwner: ['ඒක කරන්න පුළුවන් owner ට විතරයි {e}'],
        noBotAdmin: ['මම ඒකට admin නෙවෙයිනේ... මුලින් මාව admin කරන්න {e}'], needGroup: ['ඒක group එකක් ඇතුලේ කියන්න {e}'],
        blocked: ['ඒක මට කරන්න බෑ {e}'], groupNudge: ['{n} මට ඔයාව දැනගන්න ඕනේ, මට inbox එකේ msg එකක් දාන්න {e}'],
        switched: ['{name} ට මාරු වුණා {e}'], friend: ['(වයස නොදන්නා නිසා / 18 ට අඩු නිසා මම ඔයත් එක්ක යාළුවෙක් විදියට විතරයි කතා කරන්නේ 🙂)'],
        noInfo: ['තාම ඔයා ගැන මම මුකුත් දන්නේ නෑ {e}'],
        whoKnown: ['මෙයා {who}{relText} {e}'], whoUnknown: ['මම තාම මෙයාව දන්නේ නෑ. නම කියන්න, මතක තියාගන්නම් {e}'],
        peopleNone: ['තාම මම කාවවත් හඳුනාගෙන නෑ. කෙනෙක්ව tag කරලා "මෙයාගේ නම ..." කියන්න {e}'],
        peopleGone: ['හරි, {who} ගැන මතකය මකලා දැම්මා {e}'], peopleMissing: ['ඒ කෙනාව මම දන්නේ නෑ {e}'],
        doneFriend: ['හරි {n}! දැන් අපි යාළුවෝ {e} කතා කරමුද?'],
        hint: ['වෙන කෙනෙක් එක්ක කතා කරන්න ඕනේ නම් `{p}gf list` ගහන්න {e}'],
        forgot: ['හරි, ඔයා ගැන මම දැනගෙන හිටපු හැමදේම මකලා දැම්මා.'],
        forgetAsk: ['ඇත්තටම මකන්නද? ඔයාගේ නම, වයස, උපන්දිනේ, පැය 24 මතකය ඔක්කොම යනවා. `{p}gf forget yes` කියලා ගහන්න.'],
    },
    en: {
        askUrl: ['I need the link for that {e} can you send it?'], askText: ['what should I look for? {e}'], askNumber: ['which number? (with country code) {e}'],
        askTarget: ['who? tag them or reply to their message {e}'], askReply: ['reply to that photo/sticker and ask me again {e}'], askOnoff: ['on or off? {e}'],
        confirm: ['Do you really want me to {what}? say "yes" or "no" {e}'], cancelled: ['okay, I dropped it {e}'],
        noAdmin: ['you need to be a group admin for that {e}'], noOwner: ['only the owner can do that {e}'],
        noBotAdmin: ['I\'m not an admin here, make me admin first {e}'], needGroup: ['ask me that inside a group {e}'],
        blocked: ['I can\'t do that one {e}'], groupNudge: ['{n} DM me first so I can get to know you {e}'],
        switched: ['switched to {name} {e}'], friend: ['(since I don\'t know your age / you\'re under 18, I\'ll just be your friend 🙂)'],
        noInfo: ['I don\'t know anything about you yet {e}'],
        whoKnown: ['This is {who}{relText} {e}'], whoUnknown: ['I don\'t know them yet. Tell me their name and I\'ll remember {e}'],
        peopleNone: ['I don\'t know anyone yet. Tag someone and say "this is ..." {e}'],
        peopleGone: ['Okay, I forgot {who} {e}'], peopleMissing: ['I don\'t know that person {e}'],
        doneFriend: ['Okay {n}! we\'re friends now {e} wanna chat?'],
        hint: ['want to talk to someone else? type `{p}gf list` {e}'],
        forgot: ['okay, I deleted everything I knew about you.'],
        forgetAsk: ['Really delete it? your name, age, birthday and the 24h memory will all go. Type `{p}gf forget yes` to confirm.'],
    },
};

const WHAT = {
    remove: ['ඒ කෙනාව group එකෙන් අයින් කරන්න', 'remove them from the group'],
    promote: ['ඒ කෙනාව admin කරන්න', 'make them admin'],
    demote: ['ඒ කෙනාගේ admin අයින් කරන්න', 'remove their admin rights'],
    add: ['ඒ number එක group එකට add කරන්න', 'add that number to the group'],
    mute: ['group එක close කරන්න', 'close the group so only admins can write'],
    addsudo: ['ඒ කෙනාට sudo දෙන්න', 'give them sudo'],
    delsudo: ['ඒ කෙනාගේ sudo අයින් කරන්න', 'remove their sudo'],
};

const pick = (a) => a[Math.floor(Math.random() * a.length)];
function fill(str, v = {}) {
    let s = str.replace(/\{(\w+)\}/g, (_, k) => (v[k] == null ? '' : String(v[k])));
    return s.replace(/\s+([,.!?~])/g, '$1').replace(/,\s*([!?.~])/g, '$1').replace(/^[\s,.-]+/, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/** one line for: key, her (persona object), the user record, language 'si'|'en' */
function line(key, g, user, lang = 'si', extra = {}) {
    const L = lang === 'en' ? 'en' : 'si';
    const tone = toneOf(g);
    const own = tone !== 'casual' && g && g.key && PERSONAL[g.key] && PERSONAL[g.key][L];      // her own lines first (newer dere types)
    const pool = (own && own[key]) || (T[tone][L][key]) || (COMMON[L][key]) || [''];
    const vars = { n: (user && user.name) || '', e: (g && g.react) || '💕', ...extra };
    if (extra.tool) vars.what = WHAT[extra.tool] ? WHAT[extra.tool][L === 'en' ? 1 : 0] : (L === 'en' ? `run the ${extra.tool} command` : `${extra.tool} command එක run කරන්න`);
    return fill(pick(pool), vars);
}

function helpText(g, user, lang, prefix = '/', extras = []) {
    const e = (g && g.react) || '💕', n = (user && user.name) || '';
    if (lang === 'en') return fill(
        `${n ? n + ', ' : ''}${g && g.casual ? 'I can help with these, just ask' : 'just ask me, I do these for you'} ${e}\n` +
        `• YouTube playlist links, or its songs as audio / voice notes\n• Instagram reels download\n• stickers: reply to a photo and say "make a sticker" (or the other way round)\n` +
        `• view-once photos, movie posters, today's anime, ban check\n• in groups (for admins): tag everyone, kick, promote/demote, open/close the group, welcome message` +
        (extras.length ? `\n• also: ${extras.map(x => x.name + (x.desc ? ' (' + String(x.desc).slice(0, 36) + ')' : '')).join(', ')}` : '') +
        (g && g.casual ? '' : `\n\nSwitch my personality: ${prefix}gf list`), {});
    return fill(
        `${n ? n + ', ' : ''}${g && g.casual ? 'මට මේවා කරලා දෙන්න පුළුවන්, කියන්න' : 'ඔයාට ඕන දේ මට කියන්නකෝ, මම කරලා දෙන්නම්'} ${e}\n` +
        `• YouTube playlist එකක links, නැත්නම් ඒකේ songs audio / voice notes විදියට\n• Instagram reels download\n• sticker: photo එකකට reply කරලා "sticker එකක් කරන්න" කියන්න (උඩට යටට දෙකම)\n` +
        `• view-once photo, movie poster, අද anime, ban check\n• group එකක (admins ට): හැමෝම tag, kick, promote/demote, group එක open/close, welcome message` +
        (extras.length ? `\n• තව: ${extras.map(x => x.name + (x.desc ? ' (' + String(x.desc).slice(0, 36) + ')' : '')).join(', ')}` : '') +
        (g && g.casual ? '' : `\n\nමගේ personality එක මාරු කරන්න: ${prefix}gf list`), {});
}

const REL_SI = { friend: 'යාළුවා', 'older brother': 'අයියා', 'older sister': 'අක්කා', 'younger brother': 'මල්ලි', 'younger sister': 'නංගි', mother: 'අම්මා', father: 'තාත්තා', uncle: 'මාමා', aunt: 'නැන්දා', brother: 'සහෝදරයා', sister: 'සහෝදරිය', teacher: 'ගුරුවරයා', boss: 'boss' };
/** ", ඔයාගේ යාළුවා" / ", your friend"  ('' when there is no relation) */
const relText = (rel, lang) => (!rel ? '' : lang === 'en' ? `, your ${rel}` : `, ඔයාගේ ${REL_SI[rel] || rel}`);

const casualPool = (key, lang) => T.casual[lang === 'en' ? 'en' : 'si'][key] || [];

module.exports = { line, helpText, toneOf, TONE_OF, WHAT, fill, casualPool, relText };
