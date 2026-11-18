const axios = require('axios');
const { cmd } = require('../command');
const { generateWAMessageFromContent, proto, prepareWAMessageMedia } = require('@dnuzi/baileys');

// ============================================================
// Sessions
// ============================================================
let globalConn = null;
const aniInfoSessions = {};
global._aniInfoSessions = aniInfoSessions;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================
// Antiban Helpers
// ============================================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

async function simulateTyping(conn, from, durationMs) {
  try {
    await conn.sendPresenceUpdate('composing', from);
    await sleep(durationMs);
    await conn.sendPresenceUpdate('paused', from);
  } catch (e) {}
}

function resetSessionTimeout(from) {
  const s = aniInfoSessions[from];
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  s.timeout = setTimeout(() => {
    if (aniInfoSessions[from]) {
      delete aniInfoSessions[from];
      console.log(`[ANIINFO] Session expired for ${from}`);
    }
  }, SESSION_TIMEOUT_MS);
}

// ============================================================
// Interactive Helpers
// ============================================================
async function sendInteractiveList(conn, from, mek, headerTitle, bodyText, footerText, sections, imageUrl = null) {
  try {
    let media = {};
    if (imageUrl) {
      try {
        media = await prepareWAMessageMedia({ image: { url: imageUrl } }, { upload: conn.waUploadToServer });
      } catch (e) { media = {}; }
    }
    const msg = generateWAMessageFromContent(from, {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        header: proto.Message.InteractiveMessage.Header.fromObject({
          title: headerTitle, hasMediaAttachment: !!imageUrl && Object.keys(media).length > 0, ...media
        }),
        body: { text: bodyText },
        footer: { text: footerText },
        nativeFlowMessage: { buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify({ title: headerTitle, sections }) }] }
      })
    }, { quoted: mek });
    await conn.relayMessage(from, msg.message, { messageId: msg.key.id });
    return true;
  } catch (e) {
    await conn.sendMessage(from, { text: bodyText + '\n\n' + footerText }, { quoted: mek });
    return false;
  }
}

async function sendQuickButtons(conn, from, mek, bodyText, footerText, buttons) {
  try {
    const msg = generateWAMessageFromContent(from, {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        body: { text: bodyText },
        footer: { text: footerText },
        nativeFlowMessage: {
          buttons: buttons.map(b => ({
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id })
          }))
        }
      })
    }, { quoted: mek });
    await conn.relayMessage(from, msg.message, { messageId: msg.key.id });
    return true;
  } catch (e) {
    let fb = bodyText + '\n\n';
    buttons.forEach((b, i) => { fb += `${i + 1} | ${b.text}\n`; });
    fb += '\n' + footerText;
    await conn.sendMessage(from, { text: fb }, { quoted: mek });
    return false;
  }
}

// ============================================================
// Jikan API Fetchers
// ============================================================
async function fetchJikanFullDetails(malId) {
  const res = await axios.get(`https://api.jikan.moe/v4/anime/${malId}/full`, { timeout: 20000 });
  return res.data?.data || null;
}

async function fetchJikanCharacters(malId) {
  const res = await axios.get(`https://api.jikan.moe/v4/anime/${malId}/characters`, { timeout: 20000 });
  return res.data?.data || [];
}

async function fetchJikanStaff(malId) {
  const res = await axios.get(`https://api.jikan.moe/v4/anime/${malId}/staff`, { timeout: 20000 });
  return res.data?.data || [];
}

async function fetchJikanEpisodes(malId, page = 1) {
  const res = await axios.get(`https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`, { timeout: 20000 });
  return {
    episodes: res.data?.data || [],
    hasNext: res.data?.pagination?.has_next_page || false,
    total: res.data?.pagination?.items?.total || 0
  };
}

// ============================================================
// Format Builders
// ============================================================
function formatNameList(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 'N/A';
  return arr.map(x => x.name).join(', ');
}

function buildInfoText(data) {
  const titles = data.titles || [];
  const altTitles = titles.filter(t => t.type !== 'Default')
    .map(t => `  • ${t.type}: ${t.title}`)
    .join('\n') || '  • N/A';

  const synonyms = Array.isArray(data.title_synonyms) && data.title_synonyms.length > 0
    ? data.title_synonyms.join(', ') : 'N/A';

  const genres = formatNameList(data.genres);
  const themes = formatNameList(data.themes);
  const demographics = formatNameList(data.demographics);
  const genreLine = [genres, themes, demographics].filter(x => x !== 'N/A').join(', ') || 'N/A';

  // ---------- AIRED (detailed) ----------
  const airedFromObj = data.aired?.prop?.from || {};
  const airedToObj = data.aired?.prop?.to || {};

  const fmtDate = (o) => {
    if (!o || !o.year) return 'Unknown';
    const d = String(o.day || '?').padStart(2, '0');
    const m = String(o.month || '?').padStart(2, '0');
    return `${d}/${m}/${o.year}`;
  };

  const airedFrom = fmtDate(airedFromObj);
  const airedTo = fmtDate(airedToObj);
  const airedString = data.aired?.string
    || (airedFrom !== 'Unknown' ? `${airedFrom} to ${airedTo}` : 'N/A');

  // ---------- DURATION ----------
  const durationStr = data.duration || 'N/A';

  return (
    `📋 *INFORMATION*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎌 *Title:* ${data.title_english || data.title}\n` +
    `📛 *Japanese:* ${data.title_japanese || 'N/A'}\n` +
    `🔤 *Synonyms:* ${synonyms}\n` +
    `📝 *Alternative Titles:*\n${altTitles}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📺 *Type:* ${data.type || 'N/A'}\n` +
    `🎞️ *Episodes:* ${data.episodes ?? 'N/A'}\n` +
    `📡 *Status:* ${data.status || 'N/A'}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📅 *Aired:*\n` +
    `   ├ From: ${airedFrom}\n` +
    `   ├ To:   ${airedTo}\n` +
    `   └ Range: ${airedString}\n` +
    `⏱️ *Duration:* ${durationStr}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⭐ *Score:* ${data.score ?? 'N/A'} (${data.scored_by ?? 0} users)\n` +
    `🏆 *Rank:* #${data.rank ?? 'N/A'}\n` +
    `❤️ *Popularity:* #${data.popularity ?? 'N/A'}\n` +
    `🏢 *Studios:* ${formatNameList(data.studios)}\n` +
    `🎬 *Producers:* ${formatNameList(data.producers)}\n` +
    `📜 *Licensors:* ${formatNameList(data.licensors)}\n` +
    `📖 *Source:* ${data.source || 'N/A'}\n` +
    `🎭 *Genres:* ${genreLine}\n` +
    `🔞 *Rating:* ${data.rating || 'N/A'}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📝 *SYNOPSIS*\n${data.synopsis || 'N/A'}`
  );
}

function buildCharactersText(characters) {
  if (!characters || characters.length === 0) {
    return '👥 *CHARACTERS & VOICE ACTORS*\n━━━━━━━━━━━━━━━━━━━━\n❌ No character data available.';
  }

  let text = '👥 *CHARACTERS & VOICE ACTORS*\n━━━━━━━━━━━━━━━━━━━━\n';

  const mains = characters.filter(c => c.role === 'Main');
  const supports = characters.filter(c => c.role !== 'Main');
  const sorted = [...mains, ...supports].slice(0, 25);

  sorted.forEach((c, idx) => {
    const charName = c.character?.name || 'Unknown';
    const role = c.role || 'N/A';
    const vaList = (c.voice_actors || [])
      .map(va => `    🎙️ ${va.person?.name || '?'} (${va.language || '?'})`)
      .join('\n');

    text += `\n${idx + 1}. *${charName}* [${role}]\n`;
    text += vaList || '    🎙️ No VA info';
    text += '\n';
  });

  if (characters.length > 25) {
    text += `\n... and ${characters.length - 25} more characters.`;
  }

  return text;
}

function buildStaffText(staff) {
  if (!staff || staff.length === 0) {
    return '🎬 *STAFF*\n━━━━━━━━━━━━━━━━━━━━\n❌ No staff data available.';
  }

  let text = '🎬 *STAFF*\n━━━━━━━━━━━━━━━━━━━━\n';

  const grouped = {};
  staff.forEach(s => {
    const pos = s.positions?.join(', ') || 'Unknown';
    if (!grouped[pos]) grouped[pos] = [];
    grouped[pos].push(s.person?.name || 'Unknown');
  });

  let count = 0;
  for (const [pos, names] of Object.entries(grouped)) {
    if (count >= 20) break;
    text += `\n*${pos}*\n  ${names.join(', ')}\n`;
    count++;
  }

  if (Object.keys(grouped).length > count) {
    text += `\n... and more staff members.`;
  }

  return text;
}

function buildEpisodesText(episodes, total, hasNext, title) {
  if (!episodes || episodes.length === 0) {
    return `📃 *EPISODES — ${title}*\n━━━━━━━━━━━━━━━━━━━━\n❌ No episode data available.`;
  }

  let text = `📃 *EPISODES — ${title}*\n`;
  text += `Total: ${total} episodes${hasNext ? ' (showing first page)' : ''}\n━━━━━━━━━━━━━━━━━━━━\n`;

  episodes.slice(0, 30).forEach(ep => {
    const aired = ep.aired ? new Date(ep.aired).toLocaleDateString() : 'N/A';
    const flags = [ep.filler ? '🔹Filler' : '', ep.recap ? '🔸Recap' : ''].filter(Boolean).join(' ');
    text += `\nEp ${ep.mal_id ?? '?'} | ${ep.title || 'Untitled'}\n📅 ${aired} ${flags}\n`;
  });

  if (episodes.length > 30) {
    text += `\n... and ${episodes.length - 30} more episodes on this page.`;
  }
  if (hasNext) {
    text += `\n⚠️ More pages available (Jikan paginates at 100/page).`;
  }

  return text;
}

// ============================================================
// Main Command: .aniinfo
// ============================================================
cmd({
  pattern: "aniinfo",
  alias: ["ani"],
  desc: "Search anime from 3 servers (MAL / Bilibili / Jikan Full — 18+ supported)",
  category: "download",
  react: "🎌"
}, async (conn, mek, m, { from, reply, q }) => {
  globalConn = conn;
  const query = q;

  if (!query) return reply('Please provide an anime name.\nExample: .aniinfo Naruto');

  try {
    if (aniInfoSessions[from]) {
      if (aniInfoSessions[from].timeout) clearTimeout(aniInfoSessions[from].timeout);
      delete aniInfoSessions[from];
    }

    aniInfoSessions[from] = { step: 'select_server', query };
    resetSessionTimeout(from);

    await simulateTyping(conn, from, randomDelay(1200, 2000));

    await sendQuickButtons(
      conn, from, mek,
      `🔍 *Search:* ${query}\n\nSelect a server:`,
      '📚 S1 = MAL (Basic)\n🎬 S2 = Bilibili (Video)\n🌸 S3 = Jikan (Full + Episodes + Characters + Staff + 18+)',
      [
        { text: '📚 Server 1 (MAL)', id: 'server_1' },
        { text: '🎬 Server 2 (Bilibili)', id: 'server_2' },
        { text: '🌸 Server 3 (Jikan Full)', id: 'server_3' }
      ]
    );
  } catch (error) {
    console.error('[ANIINFO] Command error:', error);
    reply('❌ Something went wrong.');
    if (aniInfoSessions[from]) delete aniInfoSessions[from];
  }
});

// ============================================================
// Listener
// ============================================================
if (!global._aniInfoListenerAttached) {
  global._aniInfoListenerAttached = true;

  const attachAniInfoListener = () => {
    if (!globalConn) { setTimeout(attachAniInfoListener, 1000); return; }

    globalConn.ev.on('messages.upsert', async (m) => {
      try {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const from = msg.key.remoteJid;
        const session = aniInfoSessions[from];
        if (!session) return;

        const inner = msg.message?.viewOnceMessage?.message || msg.message?.viewOnceMessageV2?.message ||
                      msg.message?.ephemeralMessage?.message || msg.message;
        const textMsg = (inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || '').trim();

        let listId = inner.listResponseMessage?.singleSelectReply?.selectedRowId ||
                     inner.templateButtonReplyMessage?.selectedId ||
                     inner.buttonsResponseMessage?.selectedButtonId || null;
        if (!listId) {
          const pj = inner.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
                     inner.interactiveResponseMessage?.nativeFlowResponseMessage?.params_json;
          if (pj) {
            try {
              const p = typeof pj === 'string' ? JSON.parse(pj) : pj;
              listId = p.id || p.selectedId || p.selected_id || null;
            } catch (e) {}
          }
        }

        // Global cancel
        if (listId === 'close' || textMsg.toLowerCase() === 'cancel' || textMsg === '0') {
          if (session.timeout) clearTimeout(session.timeout);
          await globalConn.sendMessage(from, { text: '❌ Menu closed.' }, { quoted: msg });
          delete aniInfoSessions[from];
          return;
        }

        // --------------------------------------------------
        // STEP 1: Server Selection
        // --------------------------------------------------
        if (session.step === 'select_server') {
          let server = null;
          if (listId === 'server_1' || textMsg === '1') server = 1;
          else if (listId === 'server_2' || textMsg === '2') server = 2;
          else if (listId === 'server_3' || textMsg === '3') server = 3;

          if (!server) {
            await globalConn.sendMessage(from, { text: '❌ Please select Server 1, 2 or 3.' }, { quoted: msg });
            return;
          }

          session.server = server;
          session.step = 'searching';
          resetSessionTimeout(from);

          await simulateTyping(globalConn, from, randomDelay(1500, 2500));

          // Server 3 uses sfw=false → includes 18+ (Hentai/Rx)
          const apiUrl = server === 1
            ? `https://api-nomo.zone.id/api/animesearch?q=${encodeURIComponent(session.query)}`
            : server === 2
            ? `https://api-nomo.zone.id/api/anisearch?q=${encodeURIComponent(session.query)}`
            : `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(session.query)}&sfw=false&limit=10`;

          const res = await axios.get(apiUrl, { timeout: 15000 });

          let results = [];
          if (server === 3) {
            results = res.data?.data || [];
          } else {
            results = res.data?.status && Array.isArray(res.data.result) ? res.data.result : [];
          }

          if (results.length === 0) {
            await globalConn.sendMessage(from, { text: '❌ No results found.' }, { quoted: msg });
            delete aniInfoSessions[from];
            return;
          }

          results = results.slice(0, 10);
          session.results = results;
          session.step = 'select_anime';
          resetSessionTimeout(from);

          let body = `🔍 *Results for "${session.query}"* (Server ${server})\n\n`;
          results.forEach((item, i) => {
            const title = item.title_english || item.title || 'Unknown';
            const ratingTag = item.rating && (item.rating.includes('Rx') || item.rating.includes('R+'))
              ? ' 🔞' : '';
            body += `${i + 1} | ${title}${ratingTag}\n`;
          });
          body += `\n0 | ❌ Close`;

          const sections = [{
            title: `Server ${server} Results`,
            rows: results.map((item, i) => {
              const ratingTag = item.rating && (item.rating.includes('Rx') || item.rating.includes('R+'))
                ? ' 🔞' : '';
              return {
                title: `${i + 1} | ${item.title_english || item.title}${ratingTag}`,
                description: server === 1
                  ? `${item.type || 'Anime'} | ⭐ ${item.score || 'N/A'}`
                  : server === 2
                  ? `${item.duration || ''} | ${item.author || ''}`
                  : `${item.type || 'Anime'} | ⭐ ${item.score || 'N/A'} | ${item.episodes || '?'} eps`,
                id: `ani_${i}`
              };
            })
          }];
          sections[0].rows.push({ title: '0 | ❌ Close', description: 'Close', id: 'close' });

          const thumb = server === 1
            ? (results[0].imageUrl || null)
            : server === 2
            ? (results[0].thumbnail || null)
            : (results[0].images?.jpg?.large_image_url || results[0].images?.jpg?.image_url || null);

          await sendInteractiveList(globalConn, from, msg, 'Select Anime', body,
            'Tap a result or reply with a number', sections, thumb);
          return;
        }

        // --------------------------------------------------
        // STEP 2: Anime Selected → Show Details
        // --------------------------------------------------
        if (session.step === 'select_anime') {
          let selection = null;

          if (listId && listId.startsWith('ani_')) {
            const idx = parseInt(listId.split('_')[1]);
            if (!isNaN(idx) && idx >= 0 && idx < session.results.length) selection = idx;
          }
          if (selection === null && textMsg !== '') {
            const match = textMsg.match(/^(\d+)/);
            if (match) {
              const num = parseInt(match[1]);
              if (num >= 1 && num <= session.results.length) selection = num - 1;
            }
          }
          if (selection === null || !session.results[selection]) return;

          const item = session.results[selection];
          session.mediaTitle = item.title_english || item.title;
          session.step = 'show_details';
          resetSessionTimeout(from);

          await simulateTyping(globalConn, from, randomDelay(1500, 2500));

          // ----------------------------------------------
          // Server 1 & 2
          // ----------------------------------------------
          if (session.server !== 3) {
            let infoText = '';
            let posterUrl = null;

            if (session.server === 1) {
              const desc = item.description
                ? (item.description.length > 300 ? item.description.substring(0, 300) + '...' : item.description)
                : 'No description available.';
              infoText = `🎌 *${item.title}*\n📺 *Type:* ${item.type || 'N/A'}\n🎞️ *Episodes:* ${item.episodes || 'N/A'}\n⭐ *Score:* ${item.score || 'N/A'}\n🔗 *Link:* ${item.link || 'N/A'}\n\n📝 *Description:*\n${desc}`;
              posterUrl = item.imageUrl || null;
            } else {
              infoText = `🎬 *${item.title}*\n👁️ *Views:* ${item.views || 'N/A'}\n⏱️ *Duration:* ${item.duration || 'N/A'}\n👤 *Author:* ${item.author || 'N/A'}\n🔗 *URL:* ${item.url || 'N/A'}`;
              posterUrl = item.thumbnail || null;
            }

            session.posterUrl = posterUrl;
            session.step = 'ask_poster';

            await sendQuickButtons(globalConn, from, msg, infoText, 'Do you want the poster?', [
              { text: '🖼️ Yes, send poster', id: 'poster_yes' },
              { text: '❌ No, thanks', id: 'poster_no' }
            ]);
            return;
          }

          // ----------------------------------------------
          // Server 3 (Jikan) — FULL details
          // ----------------------------------------------
          const malId = item.mal_id;
          if (!malId) {
            await globalConn.sendMessage(from, { text: '❌ Invalid MAL ID.' }, { quoted: msg });
            delete aniInfoSessions[from];
            return;
          }

          try {
            const fullData = await fetchJikanFullDetails(malId);
            if (!fullData) throw new Error('No full data');

            session.fullData = fullData;
            session.posterUrl = fullData.images?.jpg?.large_image_url || fullData.images?.jpg?.image_url || null;
            session.malId = malId;

            // Send INFORMATION + SYNOPSIS
            const infoText = buildInfoText(fullData);
            await globalConn.sendMessage(from, { text: infoText }, { quoted: msg });

            // Action buttons
            await sendQuickButtons(
              globalConn, from, msg,
              '✅ *Information & Synopsis delivered.*\n\nWhat would you like next?',
              'Choose below:',
              [
                { text: '📃 Full Info & Episodes', id: 'show_full' },
                { text: '🖼️ Send Poster', id: 'poster_yes' },
                { text: '❌ Close', id: 'poster_no' }
              ]
            );
            session.step = 'details_actions';
            resetSessionTimeout(from);
          } catch (err) {
            console.error('[ANIINFO] Jikan full details error:', err.message);
            await globalConn.sendMessage(from, { text: '❌ Failed to load full details.' }, { quoted: msg });
            delete aniInfoSessions[from];
          }
          return;
        }

        // --------------------------------------------------
        // STEP 3: Details Actions (Server 3)
        // --------------------------------------------------
        if (session.step === 'details_actions') {
          // -------- FULL INFO + CHARACTERS + STAFF + EPISODES --------
          if (listId === 'show_full' || textMsg === '1') {
            const malId = session.malId;
            const title = session.mediaTitle;

            await simulateTyping(globalConn, from, randomDelay(1500, 2000));

            try {
              // Characters
              await sleep(800);
              const characters = await fetchJikanCharacters(malId);

              // Staff
              await sleep(800);
              const staff = await fetchJikanStaff(malId);

              // Episodes
              await sleep(800);
              const { episodes, hasNext, total } = await fetchJikanEpisodes(malId, 1);

              // Send CHARACTERS
              const charText = buildCharactersText(characters);
              await globalConn.sendMessage(from, { text: charText }, { quoted: msg });
              await sleep(700);

              // Send STAFF
              const staffText = buildStaffText(staff);
              await globalConn.sendMessage(from, { text: staffText }, { quoted: msg });
              await sleep(700);

              // Send EPISODES
              const epText = buildEpisodesText(episodes, total, hasNext, title);
              await globalConn.sendMessage(from, { text: epText }, { quoted: msg });

              // Poster / Close
              await sendQuickButtons(
                globalConn, from, msg,
                '✅ *All data delivered!*',
                'What next?',
                [
                  { text: '🖼️ Send Poster', id: 'poster_yes' },
                  { text: '❌ Close', id: 'poster_no' }
                ]
              );
              session.step = 'ask_poster';
              resetSessionTimeout(from);
            } catch (err) {
              console.error('[ANIINFO] Full info fetch error:', err.message);
              await globalConn.sendMessage(from, {
                text: '❌ Failed to load some data. Please try again.\n(Jikan API rate limit: 3 req/sec)'
              }, { quoted: msg });
            }
            return;
          }

          // -------- POSTER --------
          if (listId === 'poster_yes' || textMsg === '2') {
            if (session.posterUrl) {
              await globalConn.sendMessage(from, {
                image: { url: session.posterUrl },
                caption: `🖼️ *${session.mediaTitle}* Poster`
              }, { quoted: msg });
            } else {
              await globalConn.sendMessage(from, { text: '❌ No poster available.' }, { quoted: msg });
            }
            await globalConn.sendMessage(from, { text: '✅ Done. Have a nice day!' }, { quoted: msg });
            delete aniInfoSessions[from];
            return;
          }

          // -------- CLOSE --------
          if (listId === 'poster_no' || textMsg === '3') {
            await globalConn.sendMessage(from, { text: '✅ Done. Have a nice day!' }, { quoted: msg });
            delete aniInfoSessions[from];
            return;
          }

          await globalConn.sendMessage(from, { text: '❌ Please use the buttons.' }, { quoted: msg });
          return;
        }

        // --------------------------------------------------
        // STEP 4: Poster Confirmation (Server 1/2)
        // --------------------------------------------------
        if (session.step === 'ask_poster') {
          if (listId === 'poster_yes' || textMsg.toLowerCase().includes('yes') || textMsg === '1') {
            if (session.posterUrl) {
              await globalConn.sendMessage(from, {
                image: { url: session.posterUrl },
                caption: `🖼️ *${session.mediaTitle}* Poster`
              }, { quoted: msg });
            } else {
              await globalConn.sendMessage(from, { text: '❌ No poster available.' }, { quoted: msg });
            }
            delete aniInfoSessions[from];
          } else if (listId === 'poster_no' || textMsg.toLowerCase().includes('no') || textMsg === '0' || textMsg === '2') {
            await globalConn.sendMessage(from, { text: '✅ Done. Have a nice day!' }, { quoted: msg });
            delete aniInfoSessions[from];
          } else {
            await globalConn.sendMessage(from, { text: '❌ Please choose (1 = Yes / 2 = No).' }, { quoted: msg });
          }
          return;
        }

      } catch (err) {
        console.error('[ANIINFO] Listener error:', err);
      }
    });
  };
  attachAniInfoListener();
}
