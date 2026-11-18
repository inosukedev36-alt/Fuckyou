const axios = require('axios');
const AdmZip = require('adm-zip');
const { cmd } = require('../command');
const { generateWAMessageFromContent, proto, prepareWAMessageMedia } = require('@dnuzi/baileys');

// ============================================================
// Global Variables & Sessions
// ============================================================
let globalConn = null;
const posterSessions = {};
global._posterSessions = posterSessions; 

const TMDB_API_KEY = '0e12f115cbb3449f4362df9b87f2348b'; // ඔයාගේ Key එක
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================
// Antiban Helper Functions
// ============================================================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

async function simulateTyping(conn, from, durationMs) {
  try {
    await conn.sendPresenceUpdate('composing', from);
    await sleep(durationMs);
    await conn.sendPresenceUpdate('paused', from);
  } catch (e) {}
}

function resetSessionTimeout(from) {
  const s = posterSessions[from];
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  s.timeout = setTimeout(() => {
    if (posterSessions[from]) {
      delete posterSessions[from];
      console.log(`[POSTER] Session expired for ${from}`);
    }
  }, SESSION_TIMEOUT_MS);
}

// ============================================================
// Interactive List Helper
// ============================================================
async function sendInteractiveList(conn, from, mek, headerTitle, bodyText, footerText, sections, imageUrl = null) {
  try {
    let media = {};
    if (imageUrl) {
      try {
        media = await prepareWAMessageMedia({ image: { url: imageUrl } }, { upload: conn.waUploadToServer });
      } catch (imgErr) { media = {}; }
    }

    const listParams = { title: headerTitle, sections };

    const msg = generateWAMessageFromContent(from, {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        header: proto.Message.InteractiveMessage.Header.fromObject({
          title: headerTitle, hasMediaAttachment: !!imageUrl && Object.keys(media).length > 0, ...media
        }),
        body: { text: bodyText },
        footer: { text: footerText },
        nativeFlowMessage: { buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify(listParams) }] }
      })
    }, { quoted: mek });

    await conn.relayMessage(from, msg.message, { messageId: msg.key.id });
    return true;
  } catch (e) {
    await conn.sendMessage(from, { text: bodyText + '\n\n' + footerText }, { quoted: mek });
    return false;
  }
}

// ============================================================
// Download and Send Posters Logic
// ============================================================
async function downloadAndSendPosters(conn, from, session, quotedMsg) {
  const { mediaTitle, releaseYear, posters } = session;
  
  const loadingText = `⏳ Found ${posters.length} posters for *${mediaTitle}* (${releaseYear}).\n📥 Downloading and zipping... Please wait.`;
  await conn.sendMessage(from, { text: loadingText }, { quoted: quotedMsg });

  const imageBaseUrl = 'https://image.tmdb.org/t/p/original'; 
  const postersPerZip = 15; 
  let zip = new AdmZip();
  let zipCount = 1;
  let posterCount = 0;

  const flush = async () => {
    if (posterCount === 0) return;
    const zipBuffer = zip.toBuffer();
    const safeFileName = `${mediaTitle.replace(/[^a-zA-Z0-9]/g, '_')}_(${releaseYear})_Part_${zipCount}.zip`;
    zip = new AdmZip();
    const count = posterCount;
    posterCount = 0;
    
    // Caption එක මෙතන තියෙනවා
    await conn.sendMessage(from, {
      document: zipBuffer,
      mimetype: 'application/zip',
      fileName: safeFileName,
      caption: `📦 *${mediaTitle}* (${releaseYear}) - Part ${zipCount} (${count} posters)`
    });
    zipCount++;
    await sleep(randomDelay(3000, 5000)); // Anti-ban delay
  };

  for (let i = 0; i < posters.length; i++) {
    try {
      const imgUrl = imageBaseUrl + posters[i].file_path;
      const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer' });
      zip.addFile(`poster_${i + 1}.jpg`, Buffer.from(imgRes.data, 'binary'));
      posterCount++;

      if (posters.length > 20 && i % 5 === 0) {
         await simulateTyping(conn, from, 1000); 
      }
      if (posterCount >= postersPerZip) await flush();
    } catch (err) {
      console.error('Poster download error:', err.message);
    }
  }
  
  try { await flush(); } catch (err) { console.error('Poster send error:', err.message); }

  // වැඩේ ඉවර වුණාම session එක delete කරනවා (messages delete වෙන්නේ නෑ)
  delete posterSessions[from];
}

// ============================================================
// Main Command
// ============================================================
cmd({
    pattern: "posters",
    alias: ["poster"],
    desc: "Download movie/TV show posters",
    category: "download",
    react: "🎬"
},
async (conn, mek, m, { from, reply, q }) => {
    globalConn = conn;
    const movieName = q;
    if (!movieName) return reply('Please provide a movie or TV show name.\nExample: .posters Interstellar');

    try {
        if (posterSessions[from]) {
            if (posterSessions[from].timeout) clearTimeout(posterSessions[from].timeout);
            delete posterSessions[from];
        }

        posterSessions[from] = { step: 'search' };
        resetSessionTimeout(from);

        await simulateTyping(conn, from, randomDelay(1500, 2500));

        // include_adult=true දාලා තියෙන නිසා 18+ ඒවත් එනවා
        const searchUrl = `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(movieName)}&include_adult=true`;
        const searchRes = await axios.get(searchUrl);

        if (!searchRes.data.results || searchRes.data.results.length === 0) {
            delete posterSessions[from];
            return reply('❌ Nothing found with that name.');
        }

        // Movie සහ TV විතරක් අරගන්නවා (Max 10 පෙන්නනවා)
        const results = searchRes.data.results.filter(r => r.media_type === 'movie' || r.media_type === 'tv').slice(0, 10);

        if (results.length === 0) {
            delete posterSessions[from];
            return reply('❌ No movie or TV show found.');
        }

        posterSessions[from].results = results;
        posterSessions[from].step = 'select_poster';
        resetSessionTimeout(from);

        let body = `🔍 Search Results for: ${movieName}\n\n`;
        results.forEach((item, i) => {
            const title = item.title || item.name;
            const date = item.release_date || item.first_air_date || '';
            const year = date ? `(${date.split('-')[0]})` : '';
            const type = item.media_type === 'movie' ? '🎬 Movie' : '📺 TV';
            body += `${i + 1} | ${title} ${year} - ${type}\n`;
        });
        body += `0 | ❌ Close\n\nSelect the correct one.`;

        const sections = [{
            title: 'Search Results',
            rows: results.map((item, i) => {
                const title = item.title || item.name;
                const date = item.release_date || item.first_air_date || '';
                const year = date ? `(${date.split('-')[0]})` : '';
                const type = item.media_type === 'movie' ? 'Movie' : 'TV';
                return { title: `${i + 1} | ${title} ${year}`, description: type, id: `poster_${i}` };
            })
        }];
        sections[0].rows.push({ title: '0 | ❌ Close', description: 'Close this menu', id: 'close' });

        const imageUrl = results[0].poster_path ? `https://image.tmdb.org/t/p/w500${results[0].poster_path}` : null;

        await sendInteractiveList(conn, from, mek, 'Select Movie/TV Show', body, 'Send a number or select from the list', sections, imageUrl);

    } catch (error) {
        console.error('TMDB Error:', error);
        reply('❌ Something went wrong.');
        if (posterSessions[from]) delete posterSessions[from];
    }
});

// ============================================================
// Listener
// ============================================================
if (!global._posterListenerAttached) {
  global._posterListenerAttached = true;

  const attachListener = () => {
    if (!globalConn) {
      setTimeout(attachListener, 1000);
      return;
    }

    globalConn.ev.on('messages.upsert', async (m) => {
      try {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const session = posterSessions[from];
        if (!session) return;

        const inner =
          msg.message?.viewOnceMessage?.message || msg.message?.viewOnceMessageV2?.message ||
          msg.message?.ephemeralMessage?.message || msg.message;

        const textMsg = inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || '';

        let listId = null;
        listId = inner.listResponseMessage?.singleSelectReply?.selectedRowId ||
                 inner.templateButtonReplyMessage?.selectedId ||
                 inner.buttonsResponseMessage?.selectedButtonId || null;
                 
        if (!listId) {
          const paramsJson = inner.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson || inner.interactiveResponseMessage?.nativeFlowResponseMessage?.params_json;
          if (paramsJson) {
            try {
              const p = typeof paramsJson === 'string' ? JSON.parse(paramsJson) : paramsJson;
              listId = p.id || p.selectedId || p.selected_id || null;
            } catch (e) {}
          }
        }

        if (listId === 'close' || textMsg.toLowerCase() === 'cancel' || textMsg === '0') {
          if (session.timeout) clearTimeout(session.timeout);
          await globalConn.sendMessage(from, { text: '❌ Menu closed.' }, { quoted: msg });
          delete posterSessions[from];
          return;
        }

        // ============================================================
        // Step: select_poster (Movie/TV එක තෝරාගැනීම)
        // ============================================================
        if (session.step === 'select_poster') {
          let selection = null;

          if (listId && listId.startsWith('poster_')) {
            const index = parseInt(listId.split('_')[1]);
            if (!isNaN(index)) selection = index;
          }
          
          if (selection === null && textMsg.trim() !== '') {
            const match = textMsg.trim().match(/^(\d+)/);
            if (match) {
              const num = parseInt(match[1]);
              if (num >= 1 && num <= session.results.length) selection = num - 1;
            }
          }

          if (selection === null || !session.results[selection]) return;

          const selectedItem = session.results[selection];
          const mediaId = selectedItem.id;
          const mediaType = selectedItem.media_type;
          const mediaTitle = selectedItem.title || selectedItem.name;
          const releaseDate = selectedItem.release_date || selectedItem.first_air_date || '';
          const releaseYear = releaseDate ? releaseDate.split('-')[0] : 'Unknown';

          session.step = 'downloading';
          session.mediaId = mediaId;
          session.mediaType = mediaType;
          session.mediaTitle = mediaTitle;
          session.releaseYear = releaseYear;
          resetSessionTimeout(from);

          await simulateTyping(globalConn, from, randomDelay(2000, 3500));

          try {
            // විස්තර (Details) ගන්නවා
            const detailsUrl = `https://api.themoviedb.org/3/${mediaType}/${mediaId}?api_key=${TMDB_API_KEY}`;
            const detailsRes = await axios.get(detailsUrl);
            const details = detailsRes.data;

            // Posters ගන්නවා
            const imagesUrl = `https://api.themoviedb.org/3/${mediaType}/${mediaId}/images?api_key=${TMDB_API_KEY}`;
            const imagesRes = await axios.get(imagesUrl);
            
            // Adult ඒවා එන්නේ නැති නිසා, ඒවත් එන විදිහට filter කරන්නේ නෑ, එන හැම poster එකක්ම ගන්නවා
            const posters = imagesRes.data.posters;

            if (!posters || posters.length === 0) {
              await globalConn.sendMessage(from, { text: '❌ No posters found for this title.' }, { quoted: msg });
              delete posterSessions[from];
              return;
            }

            session.posters = posters;

            // විස්තර පෙන්නන message එක
            const overview = details.overview ? (details.overview.length > 200 ? details.overview.substring(0, 200) + '...' : details.overview) : 'No overview available.';
            const infoText = `🎬 *${mediaTitle}* (${releaseYear})\n` +
                             `⭐ *Rating:* ${details.vote_average ? details.vote_average.toFixed(1) : 'N/A'}/10\n` +
                             `🖼️ *Total Posters:* ${posters.length}\n\n` +
                             `📝 *Overview:*\n${overview}\n\n` +
                             `⏳ Downloading posters now...`;

            await globalConn.sendMessage(from, { text: infoText }, { quoted: msg });

            // Download & Send කරන function එකට යනවා
            await downloadAndSendPosters(globalConn, from, session, msg);

          } catch (error) {
            console.error('Poster fetch error:', error);
            await globalConn.sendMessage(from, { text: '❌ Error fetching details or posters.' }, { quoted: msg });
            delete posterSessions[from];
          }
        }

      } catch (err) {
        console.error('[POSTER] Listener error:', err);
      }
    });
  };

  attachListener();
}
