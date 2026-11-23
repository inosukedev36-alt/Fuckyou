// ============================================================================
//  manga.js - WhatsApp manga/manhwa downloader plugin (single file)
//  Sites: 111 (ported from FMD2's Madara / MangaThemesia / HeanCMS templates), adult sites included
//  Install:  npm i axios cheerio pdfkit sharp
//  Usage:    .manga sites | .manga <site> <title> | .manga <n> | .manga ch <number>
//  NOTE: not yet tested against the live sites - test one site first.
// ============================================================================
const axios = require('axios');
const cheerio = require('cheerio');

// ------------------------------- SETTINGS -----------------------------------
const config = {
  adultCategories: ['H-Sites', 'Adult'],
  // [] = adult sites open to everyone. To restrict them, list numbers/JIDs, e.g. ['94771234567']
  adultOnlyJids: [],
  maxPages: 150,   // safety cap per chapter
  concurrency: 4   // parallel image downloads
};

// ------------------------------- SITE LIST ----------------------------------
const SITES = [{"key":"3asq","name":"3asq","root":"https://3asq.online","category":"Arabic-Scanlation","template":"Madara","overrides":{"XPathTokenStatus":"الحالة"},"custom":true},{"key":"aresmanga","name":"ARESManga","root":"https://fl-ares.com","category":"Arabic-Scanlation","template":"MangaThemesia","overrides":{"DirectoryPagination":"/series/list-mode/"},"custom":true},{"key":"adonisfansub","name":"Adonis Fansub","root":"https://manga.adonisfansub.com","category":"Turkish","template":"MangaThemesia","overrides":{},"custom":true},{"key":"ainzscansid","name":"Ainz Scans ID","root":"https://ainzscans.net","category":"Indonesian","template":"MangaThemesia","overrides":{},"custom":false},{"key":"allporncomic","name":"AllPornComic","root":"https://allporncomic.com","category":"Adult","template":"Madara","overrides":{},"custom":true},{"key":"apkomik","name":"Apkomik","root":"https://apkomik.cc","category":"Indonesian","template":"MangaThemesia","overrides":{},"custom":false},{"key":"apollcomics","name":"Apoll Comics","root":"https://apollcomics.es","category":"Spanish","template":"Madara","overrides":{},"custom":false},{"key":"aquamanga","name":"Aqua Manga","root":"https://aquareader.net","category":"Webcomics","template":"Madara","overrides":{},"custom":false},{"key":"bacakomik","name":"BacaKomik","root":"https://bacakomik.net","category":"Indonesian","template":"MangaThemesia","overrides":{"DirectoryPagination":"/daftar-komik/?list"},"custom":true},{"key":"bokugentranslation","name":"Bokugen Translation","root":"https://bokugents.com","category":"English-Scanlation","template":"Madara","overrides":{},"custom":false},{"key":"boratscans","name":"Borat Scans","root":"https://boratscans.com","category":"English-Scanlation","template":"Madara","overrides":{},"custom":false},{"key":"brainrotcomics","name":"BrainRotComics","root":"https://brainrotcomics.com","category":"English-Scanlation","template":"Madara","overrides":{},"custom":false},{"key":"cartoonporn","name":"CartoonPorn","root":"https://cartoonporn.to","category":"Adult","template":"Madara","overrides":{},"custom":true},{"key":"cerberusseries","name":"Cerberus Series","root":"https://legionscans.com","category":"Spanish-Scanlation","template":"MangaThemesia","overrides":{},"custom":false},{"key":"datgarscanlation","name":"DatgarScanlation","root":"https://datgarscanlation.blogspot.com","category":"Spanish-Scanlation","template":"MangaThemesia","overrides":{"DirectoryPagination":"/series/list-mode/"},"custom":true},{"key":"detectiveconanar","name":"شبكة كونان العربية (detectiveconanar)","root":"https://manga.detectiveconanar.com","category":"Arabic","template":"Madara","overrides":{},"custom":false},{"key":"doujinhentai","name":"DoujinHentai","root":"https://doujinhentai.net","category":"Spanish","template":"Madara","overrides":{"XPathTokenAuthors":"Autor(es)","XPathTokenGenres":"Categorías"},"custom":true},{"key":"doujinku","name":"Doujinku","root":"https://doujinku.xyz","category":"H-Sites","template":"MangaThemesia","overrides":{},"custom":true},{"key":"dragontea","name":"Dragon Tea","root":"https://dragontea.ink","category":"English-Scanlation","template":"Madara","overrides":{},"custom":false},{"key":"dragontranslation","name":"DragonTranslation","root":"https://dragontranslation.org","category":"Spanish","template":"Madara","overrides":{},"custom":false},{"key":"emperorscan","name":"EmperorScan","root":"https://emperorscan.mundoalterno.org","category":"Spanish","template":"Madara","overrides":{},"custom":false},{"key":"ero18x","name":"Ero18x","root":"https://ero18x.com","category":"H-Sites","template":"Madara","overrides":{},"custom":false},{"key":"gdscans","name":"GDScans","root":"https://gdscans.com","category":"English-Scanlation","template":"Madara","overrides":{},"custom":true},{"key":"gourmetscans","name":"Gourmet Scans","root":"https://gourmetsupremacy.com","category":"English-Scanlation","template":"Madara","overrides":{},"custom":true},{"key":"hadesscans","name":"Hades Scans","root":"https://lectorhades.latamtoon.com","category":"Spanish-Scanlation","template":"Madara","overrides":{},"custom":false},{"key":"hentai20","name":"Hentai20","root":"https://hentai20.io","category":"H-Sites","template":"MangaThemesia","overrides":{},"custom":false},{"key":"ichithewitch","name":"Ichi the Witch","root":"https://ichithewitch.org","category":"English-Scanlation","template":"Madara","overrides":{},"custom":true},{"key":"infrafandub","name":"InfraFandub","root":"https://infrafandub.com","category":"Spanish","template":"Madara","overrides":{},"custom":false},{"key":"inventariooculto","name":"Inventario Oculto","root":"https://inventariooculto.com","category":"Spanish","template":"Madara","overrides":{},"custom":false},{"key":"ksscans","name":"KS Scans","root":"https://ksgroupscans.com","category":"English-Scanlation","template":"Madara","overrides":{},"custom":false},{"key":"kanzenin","name":"Kanzenin","root":"https://kanzenin.info","category":"H-Sites","template":"MangaThemesia","overrides":{"DirectoryPagination":"/a-z-list/page/"},"custom":true},{"key":"kissmangain","name":"KissMangaIN","root":"https://kissmanga.in","category":"Webcomics","template":"Madara","overrides":{},"custom":true},{"key":"klikmanga","name":"KlikManga","root":"https://klikmanga.com","category":"Indonesian","template":"Madara","overrides":{},"custom":false},{"key":"komikstation","name":"KomikStation","root":"https://komikstation.org","category":"Indonesian","template":"MangaThemesia","overrides":{"XPathTokenAuthors":"Penulis","XPathTokenArtists":"Ilustrator"},"custom":true},{"key":"komikup","name":"KomikUp","root":"https://komikup.com","category":"Indonesian","template":"Madara","overrides":{},"custom":true},{"key":"komiktap","name":"Komiktap","root":"https://komiktap.info","category":"H-Sites","template":"MangaThemesia","overrides":{},"custom":true},{"key":"lhtranslation","name":"LHTranslation","root":"https://lhtranslation.net","category":"English-Scanlation","template":"Madara","overrides":{},"custom":true},{"key":"lectorkns","name":"Lector KNS","root":"https://lectorknight.com","category":"Spanish-Scanlation","template":"Madara","overrides":{},"custom":false},{"key":"lectormanga","name":"LectorManga","root":"https://lectormangaa.com","category":"Spanish","template":"Madara","overrides":{"XPathTokenStatus":"Estado"},"custom":true},{"key":"leemiau","name":"LeeMiau","root":"https://leemiau.com","category":"Spanish","template":"MangaThemesia","overrides":{},"custom":true},{"key":"leermanga","name":"LeerManga","root":"https://leermanga.net","category":"Spanish","template":"Madara","overrides":{"DirectoryPagination":"/biblioteca?page=","XPathTokenGenres":"Géneros"},"custom":true},{"key":"lekmanga","name":"مانجا ليك (Lekmanga)","root":"https://lekmanga.org","category":"Arabic","template":"Madara","overrides":{},"custom":false},{"key":"lilymanga","name":"Lily Manga","root":"https://lilymanga.net","category":"English","template":"Madara","overrides":{},"custom":false},{"key":"luacomic","name":"Lua Comic","root":"https://luacomic.org","category":"English-Scanlation","template":"HeanCMS","overrides":{"API_URL":"https://api.luacomic.org","CDN_URL":"https://media.luacomic.org/file/V4IKlhs"},"custom":false},{"key":"luvyaa","name":"Luvyaa","root":"https://luvyaa.org","category":"Indonesian","template":"MangaThemesia","overrides":{},"custom":false},{"key":"mgkomik","name":"MGKomik","root":"https://id.mgkomik.cc","category":"Indonesian","template":"Madara","overrides":{},"custom":true},{"key":"madaradex","name":"MadaraDex","root":"https://madaradex.org","category":"H-Sites","template":"Madara","overrides":{},"custom":true},{"key":"madarascans","name":"MadaraScans","root":"https://madarascans.com","category":"English-Scanlation","template":"MangaThemesia","overrides":{"DirectoryPagination":"/series/list-mode/"},"custom":true},{"key":"manga18fx","name":"Manga18FX","root":"https://manga18fx.com","category":"H-Sites","template":"Madara","overrides":{},"custom":true},{"key":"manga1st","name":"Manga1st","root":"https://manga1st.online","category":"Webcomics","template":"Madara","overrides":{},"custom":true},{"key":"mangadistrict","name":"Manga District","root":"https://mangadistrict.com","category":"H-Sites","template":"Madara","overrides":{},"custom":true},{"key":"mangaforfreecom","name":"MangaForFreeCom","root":"https://mangaforfree.com","category":"Raw","template":"Madara","overrides":{},"custom":true},{"key":"mangaforfreenet","name":"MangaForFreeNet","root":"https://mangaforfree.net","category":"Raw","template":"Madara","overrides":{},"custom":true},{"key":"mangagg","name":"MangaGG","root":"https://mangagg.com","category":"Webcomics","template":"Madara","overrides":{},"custom":false},{"key":"mangalivre","name":"MangaLivre","root":"https://mangalivre.tv","category":"Portuguese","template":"Madara","overrides":{},"custom":false},{"key":"mangaowl","name":"MangaOwl","root":"https://mangaowl.io","category":"Webcomics","template":"Madara","overrides":{},"custom":false},{"key":"mangaread","name":"MangaRead","root":"https://www.mangaread.org","category":"English","template":"Madara","overrides":{},"custom":false},{"key":"mangasushi","name":"MangaSushi","root":"https://mangasushi.org","category":"English","template":"Madara","overrides":{},"custom":true},{"key":"mangasusu","name":"MangaSusu","root":"https://mangasusuku.com","category":"H-Sites","template":"MangaThemesia","overrides":{"DirectoryPagination":"/az-list/page/"},"custom":true},{"key":"mangatv","name":"MangaTV","root":"https://mangatv.net","category":"Spanish","template":"MangaThemesia","overrides":{"XPathTokenStatus":"Estado"},"custom":true},{"key":"mangacan","name":"Mangacan","root":"https://mangacanblog.com","category":"Indonesian","template":"MangaThemesia","overrides":{"DirectoryPagination":"/daftar-komik-manga-bahasa-indonesia.html"},"custom":true},{"key":"manhastro","name":"Manhastro","root":"https://manhastro.net","category":"Portuguese","template":"Madara","overrides":{},"custom":true},{"key":"manhuaplus","name":"ManhuaPlus","root":"https://manhuaplus.com","category":"Webcomics","template":"Madara","overrides":{"DirectoryParameters":""},"custom":true},{"key":"manhuaus","name":"Manhuaus","root":"https://manhuaus.com","category":"English","template":"Madara","overrides":{},"custom":true},{"key":"manhwa18cc","name":"Manhwa18Cc","root":"https://manhwa18.cc","category":"H-Sites","template":"Madara","overrides":{},"custom":true},{"key":"manhwa68","name":"Manhwa68","root":"https://manhwa68.com","category":"H-Sites","template":"Madara","overrides":{},"custom":true},{"key":"manhwaclub","name":"ManhwaClub","root":"https://manhwaclub.net","category":"H-Sites","template":"Madara","overrides":{},"custom":false},{"key":"manhwahub","name":"ManhwaHub","root":"https://manhwahub.to","category":"H-Sites","template":"Madara","overrides":{},"custom":false},{"key":"manhwaindo","name":"ManhwaIndo","root":"https://manhwaindo.id","category":"Indonesian","template":"MangaThemesia","overrides":{"DirectoryPagination":"/series/list-mode/"},"custom":true},{"key":"manhwaland","name":"ManhwaLand","root":"https://62.182.80.253","category":"Indonesian","template":"MangaThemesia","overrides":{},"custom":true},{"key":"manhwalist","name":"ManhwaList","root":"https://manhwalist02.site","category":"Indonesian","template":"MangaThemesia","overrides":{},"custom":false},{"key":"manhwatoon","name":"Manhwa Toon","root":"https://www.manhwatoon.me","category":"Webcomics","template":"Madara","overrides":{},"custom":true},{"key":"manhwatoons","name":"Manhwa Toons","root":"https://www.manhwatoons.com","category":"H-Sites","template":"Madara","overrides":{},"custom":true},{"key":"manhwatop","name":"ManhwaTop","root":"https://manhwatop.com","category":"Webcomics","template":"Madara","overrides":{},"custom":false},{"key":"manhwaz","name":"ManhwaZ","root":"https://manhwaz.com","category":"Webcomics","template":"Madara","overrides":{},"custom":false},{"key":"manhwadesu","name":"Manhwadesu","root":"https://manhwadesu.cloud","category":"Indonesian","template":"MangaThemesia","overrides":{"DirectoryPagination":"/komik/list-mode/"},"custom":false},{"key":"milftoon","name":"Milftoon","root":"https://milftoon.xxx","category":"Adult","template":"Madara","overrides":{},"custom":false},{"key":"mundomanhwa","name":"Mundo Manhwa","root":"https://mundomanhwa.com","category":"Spanish","template":"Madara","overrides":{},"custom":false},{"key":"traduccionesamistosas","name":"Traducciones Amistosas","root":"https://traduccionesamistosas.topmanhuas.org","category":"Spanish","template":"Madara","overrides":{},"custom":false},{"key":"ngomik","name":"Ngomik","root":"https://ngomik.net","category":"Indonesian","template":"MangaThemesia","overrides":{"DirectoryPagination":"/all-komik/page/"},"custom":true},{"key":"nijitranslations","name":"Niji Translations","root":"https://niji-translations.com","category":"Arabic","template":"Madara","overrides":{},"custom":false},{"key":"omegascans","name":"Omega Scans","root":"https://omegascans.org","category":"H-Sites","template":"HeanCMS","overrides":{"API_URL":"https://api.omegascans.org"},"custom":true},{"key":"porncomic","name":"Porn Comic","root":"https://gedecomix.com","category":"Adult","template":"Madara","overrides":{},"custom":false},{"key":"ragnarokscanlation","name":"Ragnarok Scanlation","root":"https://ragnarokscanlation.org","category":"Spanish-Scanlation","template":"Madara","overrides":{},"custom":false},{"key":"ravenscans","name":"Raven Scans","root":"https://ravenscans.org","category":"English-Scanlation","template":"MangaThemesia","overrides":{"DirectoryPagination":"/manga/list-mode/"},"custom":false},{"key":"rizzfables","name":"RizzFables","root":"https://rizzfables.com","category":"English-Scanlation","template":"MangaThemesia","overrides":{"DirectoryPagination":"/series"},"custom":true},{"key":"rokaricomics","name":"Rokari Comics","root":"https://rokaricomics.com","category":"English-Scanlation","template":"MangaThemesia","overrides":{},"custom":false},{"key":"s2manga","name":"S2Manga","root":"https://s2manga.com","category":"Webcomics","template":"Madara","overrides":{},"custom":false},{"key":"sektedoujin","name":"SekteDoujin","root":"https://sektedoujin.cc","category":"Indonesian","template":"MangaThemesia","overrides":{},"custom":true},{"key":"skymangas","name":"SkyMangas","root":"https://skymangas.com","category":"Spanish","template":"MangaThemesia","overrides":{},"custom":true},{"key":"sleepytranslations","name":"SleepyTranslations","root":"https://sleepytranslations.com","category":"English-Scanlation","template":"Madara","overrides":{},"custom":true},{"key":"spiderscans","name":"SpiderScans","root":"https://spiderscans.xyz","category":"English-Scanlation","template":"Madara","overrides":{},"custom":false},{"key":"sushiscan","name":"SushiScan","root":"https://sushiscan.net","category":"French","template":"MangaThemesia","overrides":{"DirectoryPagination":"/catalogue/list-mode/","XPathTokenAuthors":"Auteur","XPathTokenArtists":"Dessinateur","XPathTokenStatus":"Statut"},"custom":true},{"key":"taurusmanga","name":"TaurusManga","root":"https://lectortaurus.com","category":"Spanish-Scanlation","template":"Madara","overrides":{},"custom":true},{"key":"templescanesp","name":"TempleScanEsp","root":"https://templescanesp.vxviral.xyz","category":"Spanish-Scanlation","template":"Madara","overrides":{},"custom":true},{"key":"thunderscans","name":"Thunder Scans","root":"https://en-thunderscans.com","category":"English-Scanlation","template":"MangaThemesia","overrides":{"DirectoryPagination":"/comics/list-mode/"},"custom":true},{"key":"toongod","name":"ToonGod","root":"https://www.toongod.org","category":"Webcomics","template":"Madara","overrides":{},"custom":true},{"key":"toonily","name":"Toonily","root":"https://toonily.com","category":"Webcomics","template":"Madara","overrides":{},"custom":true},{"key":"topcomicporno","name":"TopComicPorno","root":"https://topcomicporno.com","category":"Spanish","template":"Madara","overrides":{"XPathTokenStatus":"Estado"},"custom":true},{"key":"tsundokutradues","name":"Tsundoku Traduções","root":"https://tsundoku.com.br","category":"Portuguese","template":"MangaThemesia","overrides":{},"custom":false},{"key":"tumanganet","name":"TuMangaNet","root":"https://tumanga.net","category":"Spanish","template":"MangaThemesia","overrides":{"XPathTokenStatus":"Estado"},"custom":true},{"key":"uchuujinscans","name":"Uchuujin Scans","root":"https://uchuujinmangas.com","category":"Spanish-Scanlation","template":"MangaThemesia","overrides":{},"custom":false},{"key":"upkomik","name":"UpKomik","root":"https://upkomik.com","category":"Indonesian","template":"Madara","overrides":{},"custom":false},{"key":"wearehunger","name":"WeAreHunger","root":"https://www.wearehunger.site","category":"English","template":"Madara","overrides":{},"custom":false},{"key":"webdexscans","name":"Webdex Scans","root":"https://webdexscans.com","category":"English-Scanlation","template":"Madara","overrides":{},"custom":true},{"key":"webtoonxyz","name":"WebtoonXYZ","root":"https://www.webtoon.xyz","category":"H-Sites","template":"Madara","overrides":{},"custom":false},{"key":"wuxiaworld","name":"WuxiaWorld","root":"https://wuxiaworld.site","category":"Webcomics","template":"Madara","overrides":{},"custom":true},{"key":"xmanhwa","name":"Xmanhwa","root":"https://www.xmanhwa.me","category":"H-Sites","template":"Madara","overrides":{},"custom":true},{"key":"yakshacomics","name":"YakshaComics","root":"https://yakshacomics.com","category":"English-Scanlation","template":"Madara","overrides":{},"custom":false},{"key":"yakshascans","name":"YakshaScans","root":"https://yakshascans.com","category":"English-Scanlation","template":"Madara","overrides":{},"custom":false},{"key":"zinmanga","name":"ZinManga","root":"https://www.zinmanga.net","category":"English-Scanlation","template":"Madara","overrides":{"DirectoryParameters":"?orderby=new-manga&post_type=wp-manga"},"custom":true}];

// ------------------------------- ENGINE -------------------------------------
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const absUrl = (root, u) => {
  try { return new URL(u, root + '/').href; } catch { return u; }
};
// FMD2 strips image-proxy prefixes from page links
const unproxy = (u) => u.replace(/i\d\.wp\.com\//, '').replace('cdn.statically.io/img/', '');
const num = (name) => (String(name).match(/(\d+(?:\.\d+)?)/) || [])[1] || '';

function makeHttp(site, extraHeaders = {}) {
  return axios.create({
    timeout: 30000,
    maxRedirects: 5,
    headers: { 'User-Agent': UA, Referer: site.root + '/', ...extraHeaders }
  });
}

function wrapErrors(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      const st = e.response?.status;
      if (st === 403 || st === 503) throw new Error('CLOUDFLARE: site එක bot protection (Cloudflare) දාලා තියෙනවා');
      throw e;
    }
  };
}

/* ------------------------------------------------------------------ Madara */
function madara(site) {
  const http = makeHttp(site);
  const root = site.root;
  const ov = site.overrides || {};
  const chapterParams = ov.ChapterParameters || 'action=manga_get_chapters&manga=';
  const okLink = ($a) => $a.attr('href') && $a.attr('href') !== '#' && !$a.hasClass('reward_ads');

  const collect = ($, sel) => {
    const out = [];
    $(sel).each((_, el) => {
      const a = $(el);
      if (okLink(a)) out.push({ id: absUrl(root, a.attr('href')), name: clean(a.text()) });
    });
    return out;
  };

  return {
    async search(q) {
      const { data } = await http.get(root + '/', { params: { s: q, post_type: 'wp-manga' } });
      const $ = cheerio.load(data);
      const out = [];
      $('div.post-title').each((_, el) => {
        const a = $(el).find('h3 a, h2 a, h4 a, h5 a').first();
        if (a.attr('href')) out.push({ id: absUrl(root, a.attr('href')), title: clean(a.text()) });
      });
      return out;
    },

    async chapters(seriesUrl) {
      const { data } = await http.get(seriesUrl);
      const $ = cheerio.load(data);
      const mangaId = $('div[id*="manga-chapters-holder"]').attr('data-id');
      let list = collect($, 'div.li__text a');
      if (!list.length) list = collect($, 'li.wp-manga-chapter a');

      if (!list.length) {
        // ajax/chapters/?t=N  (paginated)
        const base = seriesUrl.replace(/\/?$/, '/');
        let pages = null;
        for (let page = 1; pages === null || page <= pages; page++) {
          const r = await http.post(`${base}ajax/chapters/?t=${page}`, '', {
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Length': '0' }
          });
          const $$ = cheerio.load(r.data);
          let got = collect($$, 'div.li__text a');
          if (!got.length) got = collect($$, 'li.wp-manga-chapter a');
          list = list.concat(got);
          if (pages === null) {
            const nums = $$('div.pagination a').map((_, e) => parseInt($$(e).text(), 10)).get().filter(Boolean);
            pages = nums.length ? Math.max(...nums) : 1;
          }
          if (!got.length) break;
        }
      }
      if (!list.length && mangaId) {
        const r = await http.post(root + '/wp-admin/admin-ajax.php', chapterParams + mangaId, {
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        });
        list = collect(cheerio.load(r.data), 'li.wp-manga-chapter a');
      }
      return list.reverse().map((c) => ({ id: c.id, number: num(c.name) || c.name, title: c.name }));
    },

    async pages(chapterUrl) {
      let u = chapterUrl;
      if (!u.includes('style=list')) u = u.replace('?style=paged', '') + (u.includes('?') ? '&' : '?') + 'style=list';
      const { data } = await http.get(u);
      const $ = cheerio.load(data);
      let urls = $('div[class*="page-break"] img')
        .map((_, e) => ($(e).attr('data-src') || $(e).attr('src') || '').trim())
        .get()
        .filter(Boolean);
      if (!urls.length) {
        const t = $('script#chapter_preloaded_images').html() || '';
        const m = t.match(/\[[\s\S]*\]/);
        if (m) try { urls = JSON.parse(m[0]).map((o) => o.src); } catch {}
      }
      if (!urls.length && $('script#chapter-protector-data').length)
        throw new Error('ENCRYPTED: මේ chapter එක encrypt කරලා (තාම support නෑ)');
      return urls.map(unproxy);
    }
  };
}

/* ----------------------------------------------------------- MangaThemesia */
function mangathemesia(site) {
  const http = makeHttp(site);
  const root = site.root;
  const listPath = (site.overrides || {}).DirectoryPagination || '/manga/list-mode/';
  let cache = { at: 0, list: [] };

  async function directory() {
    if (Date.now() - cache.at < 3600e3 && cache.list.length) return cache.list;
    const { data } = await http.get(root + listPath);
    const $ = cheerio.load(data);
    const list = $('div.blix a')
      .map((_, e) => ({ id: absUrl(root, $(e).attr('href')), title: clean($(e).text()) }))
      .get()
      .filter((x) => x.title);
    cache = { at: Date.now(), list };
    return list;
  }

  return {
    async search(q) {
      const lq = q.toLowerCase();
      return (await directory()).filter((s) => s.title.toLowerCase().includes(lq));
    },

    async chapters(seriesUrl) {
      const { data } = await http.get(seriesUrl);
      const $ = cheerio.load(data);
      const out = [];
      $('#chapterlist div.eph-num a').each((_, e) => {
        const a = $(e);
        const name = clean(a.find('span.chapternum').text()) || clean(a.text());
        out.push({ id: absUrl(root, a.attr('href')), number: num(name) || name, title: name });
      });
      return out.reverse();
    },

    async pages(chapterUrl) {
      const { data } = await http.get(chapterUrl);
      const $ = cheerio.load(data);
      let urls = [];
      const s = $('script')
        .map((_, e) => $(e).html() || '')
        .get()
        .find((t) => t.includes('ts_reader'));
      if (s) {
        const m = s.match(/run\(([\s\S]*?)\);/);
        if (m) {
          const json = JSON.parse(m[1].replace(/!0/g, 'true').replace(/!1/g, 'false'));
          urls = json.sources?.[0]?.images || [];
        }
      }
      if (!urls.length) // fallback for themes without ts_reader (not in the FMD2 template)
        urls = $('#readerarea img').map((_, e) => ($(e).attr('data-src') || $(e).attr('src') || '').trim()).get();
      return urls.filter(Boolean).map((u) => {
        u = unproxy(u);
        return /blogger|blogspot/.test(u) ? u.replace('/s1600/', '/s0/') : u;
      });
    }
  };
}

/* ------------------------------------------------------------------ HeanCMS */
function heancms(site) {
  const ov = site.overrides || {};
  const api = ov.API_URL;
  const cdn = ov.CDN_URL || api;
  if (!api) throw new Error('API_URL missing for ' + site.name);
  const http = axios.create({
    baseURL: api,
    timeout: 30000,
    headers: { 'User-Agent': UA, Referer: site.root + '/' }
  });
  const abs = (p) => (/^https?:\/\//.test(p) ? p : `${cdn}/${String(p).replace(/^\//, '')}`);
  let cache = { at: 0, list: [] };

  async function directory() {
    if (Date.now() - cache.at < 3600e3 && cache.list.length) return cache.list;
    const q = (p) => `/query?series_type=Comic&order=desc&orderBy=created_at&perPage=100&page=${p}`;
    const first = (await http.get(q(1))).data;
    const last = first.meta?.last_page || 1;
    let list = first.data;
    for (let p = 2; p <= last; p++) list = list.concat((await http.get(q(p))).data.data);
    list = list.map((s) => ({ id: s.series_slug, title: s.title }));
    cache = { at: Date.now(), list };
    return list;
  }

  return {
    async search(q) {
      const lq = q.toLowerCase();
      return (await directory()).filter((s) => s.title.toLowerCase().includes(lq));
    },
    async chapters(slug) {
      const info = (await http.get(`/series/${slug}`)).data;
      const out = [];
      let page = 1, last = 1;
      do {
        const r = (await http.get(`/chapter/query?page=${page}&perPage=100&series_id=${info.id}`)).data;
        for (const c of r.data) {
          if (String(c.price) !== '0') continue; // free chapters only (FMD2 default)
          const t = c.chapter_title && c.chapter_title !== 'null' ? ` - ${c.chapter_title}` : '';
          out.push({ id: `${info.series_slug}/${c.chapter_slug}`, number: num(c.chapter_name) || c.chapter_name, title: c.chapter_name + t });
        }
        last = r.meta?.last_page || 1;
      } while (++page <= last);
      return out.reverse();
    },
    async pages(chapterId) {
      const d = (await http.get(`/chapter/${chapterId}`)).data.chapter?.chapter_data || {};
      let urls = (d.images || []).map(abs);
      if (!urls.length) urls = (d.files || []).map((f) => f.url);
      return urls;
    }
  };
}

const TEMPLATES = { Madara: madara, MangaThemesia: mangathemesia, HeanCMS: heancms };

function createSite(site) {
  const impl = TEMPLATES[site.template](site);
  return {
    ...site,
    search: wrapErrors(impl.search),
    chapters: wrapErrors(impl.chapters),
    pages: wrapErrors(impl.pages),
    imageHeaders: { 'User-Agent': UA, Referer: site.root + '/' }
  };
}

/* ------------------------------------------------------------ chapter -> PDF */
async function chapterToPdf(site, urls, { concurrency = 4, onProgress } = {}) {
  const PDFDocument = require('pdfkit');
  const sharp = require('sharp');

  const bufs = new Array(urls.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < urls.length) {
      const i = next++;
      const r = await axios.get(urls[i], { headers: site.imageHeaders, responseType: 'arraybuffer', timeout: 45000 });
      bufs[i] = Buffer.from(r.data);
      onProgress?.(++done, urls.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const doc = new PDFDocument({ autoFirstPage: false });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const finished = new Promise((res) => doc.on('end', () => res(Buffer.concat(chunks))));

  const MAXH = 12000; // PDF pages max out at 14400pt; slice very tall webtoon strips
  for (const b of bufs) {
    const meta = await sharp(b).metadata();
    for (let top = 0; top < meta.height; top += MAXH) {
      const h = Math.min(MAXH, meta.height - top);
      const jpg = await sharp(b).extract({ left: 0, top, width: meta.width, height: h }).jpeg({ quality: 85 }).toBuffer();
      doc.addPage({ size: [meta.width, h], margin: 0 });
      doc.image(jpg, 0, 0, { width: meta.width, height: h });
    }
  }
  doc.end();
  return finished;
}

// ------------------------------- COMMANDS -----------------------------------
const sitesData = SITES;

const cache = new Map(); // site key -> site instance
const sessions = new Map(); // jid -> { stage, siteKey, results, series, chapters, at }
const SESSION_TTL = 30 * 60 * 1000;

const byKey = Object.fromEntries(sitesData.map((s) => [s.key, s]));
const isAdult = (s) => config.adultCategories.includes(s.category);

function getSite(key) {
  if (!cache.has(key)) cache.set(key, createSite(byKey[key]));
  return cache.get(key);
}

function allowed(siteInfo, sender) {
  if (!isAdult(siteInfo)) return true;
  if (!config.adultOnlyJids.length) return true; // empty list = adult sites open to everyone
  return config.adultOnlyJids.some((j) => String(sender).includes(String(j).split('@')[0]));
}

const HELP = `*Manga plugin*
.manga sites [filter]   - site list
.manga <site> <title>   - search (e.g. .manga omegascans stepmom)
.manga <number>         - pick a result, shows chapters
.manga ch <number>      - download a chapter as PDF
.manga more             - show older chapters`;

async function handle({ args, jid, sender, reply, sendDocument }) {
  const sub = (args[0] || '').toLowerCase();
  if (!sub || sub === 'help') return reply(HELP);

  // ---- site list
  if (sub === 'sites') {
    const f = (args[1] || '').toLowerCase();
    const list = sitesData
      .filter((s) => allowed(s, sender))
      .filter((s) => !f || s.key.includes(f) || (s.category || '').toLowerCase().includes(f));
    if (!list.length) return reply('Site කිසිවක් නෑ.');
    return reply(list.map((s) => `${s.key}${s.custom ? ' ⚠️' : ''}  (${s.category})`).join('\n').slice(0, 3500) +
      '\n\n⚠️ = site-specific tweaks තියෙන නිසා නොගැලපෙන්න පුළුවන්');
  }

  const sess = sessions.get(jid);
  const live = sess && Date.now() - sess.at < SESSION_TTL ? sess : null;

  // ---- pick a search result
  if (/^\d+$/.test(sub) && live?.stage === 'results') {
    const pick = live.results[Number(sub) - 1];
    if (!pick) return reply('වැරදි අංකයක්.');
    const site = getSite(live.siteKey);
    const chapters = await site.chapters(pick.id);
    if (!chapters.length) return reply('Chapters හොයාගන්න බැරි වුණා (paid/locked වෙන්න පුළුවන්).');
    Object.assign(live, { stage: 'chapters', series: pick, chapters, shown: 20, at: Date.now() });
    const last = chapters.slice(-20);
    return reply(`*${pick.title}* - chapters ${chapters.length}\n` +
      last.map((c) => `${c.number}`).join(', ') +
      `\n\n.manga ch <number> කියලා download කරන්න`);
  }

  if (sub === 'more' && live?.stage === 'chapters') {
    live.shown += 40;
    const slice = live.chapters.slice(-live.shown, -(live.shown - 40));
    return reply(slice.map((c) => c.number).join(', ') || 'තව නෑ.');
  }

  // ---- download a chapter
  if (sub === 'ch' && live?.stage === 'chapters') {
    const want = (args[1] || '').toString();
    const chapter = live.chapters.find((c) => c.number === want);
    if (!chapter) return reply('ඒ chapter number එක නෑ. list එකේ පෙන්නපු number එකක් දෙන්න.');
    const site = getSite(live.siteKey);
    await reply(`⏳ ${live.series.title} - ${chapter.number} හදනවා...`);
    const urls = (await site.pages(chapter.id)).slice(0, config.maxPages);
    if (!urls.length) return reply('Images හොයාගන්න බැරි වුණා.');
    const pdf = await chapterToPdf(site, urls, { concurrency: config.concurrency });
    const safe = live.series.title.replace(/[^\w\- ]+/g, '').slice(0, 60);
    return sendDocument(pdf, `${safe} - Ch ${chapter.number}.pdf`);
  }

  // ---- search: .manga <site> <query...>
  const siteInfo = byKey[sub];
  if (siteInfo) {
    if (!allowed(siteInfo, sender)) return reply('මේ site එක ඔයාට අවසර නෑ.');
    const query = args.slice(1).join(' ').trim();
    if (!query) return reply('Title එකක් දෙන්න. උදා: .manga ' + sub + ' solo leveling');
    const results = (await getSite(sub).search(query)).slice(0, 10);
    if (!results.length) return reply('කිසිවක් හම්බුණේ නෑ.');
    sessions.set(jid, { stage: 'results', siteKey: sub, results, at: Date.now() });
    return reply(results.map((r, i) => `${i + 1}. ${r.title}`).join('\n') + '\n\n.manga <number> කියලා තෝරන්න');
  }

  return reply('Site එක හොයාගන්න බෑ. `.manga sites` බලන්න.\n\n' + HELP);
}

// ------------------------------- BOT ADAPTER --------------------------------
// Tolerant entry point: tries to work with common plugin styles
//   handler(m, { conn, args, text, reply, ... })   |   run(sock, m, args)   |   run({ sock, m, args })
async function entry(...a) {
  const ctx = a.find((x) => x && typeof x === 'object' && !Array.isArray(x) &&
    (x.conn || x.sock || x.args || x.text || x.q || x.reply || x.m)) || {};
  const sock = a.find((x) => x && typeof x.sendMessage === 'function') || ctx.conn || ctx.sock || ctx.client;
  const m = ctx.m || ctx.msg || ctx.message ||
    a.find((x) => x && x !== sock && x !== ctx && !Array.isArray(x) && typeof x === 'object' && (x.key || x.chat));
  const jid = m?.key?.remoteJid || m?.chat || ctx.from || ctx.jid;
  const sender = m?.key?.participant || m?.sender || ctx.sender || jid;

  let args = a.find(Array.isArray) || ctx.args;
  if (!Array.isArray(args)) {
    const raw = String(ctx.text ?? ctx.q ?? m?.text ?? m?.body ?? '').trim();
    args = raw.split(/\s+/).filter(Boolean);
  }
  args = args.map(String);
  if (/^[.!#\/]?manga$/i.test(args[0] || '')) args = args.slice(1);

  const reply = async (text) => {
    if (typeof ctx.reply === 'function') return ctx.reply(text);
    if (typeof m?.reply === 'function') return m.reply(text);
    return sock.sendMessage(jid, { text }, { quoted: m });
  };
  const sendDocument = (buffer, fileName) =>
    sock.sendMessage(jid, { document: buffer, mimetype: 'application/pdf', fileName }, { quoted: m });

  try {
    await handle({ args, jid, sender, reply, sendDocument });
  } catch (e) {
    await reply('❌ ' + String(e.message || e).slice(0, 300));
  }
}

// attach metadata for several plugin styles at once
entry.name_ = 'manga';
entry.command = ['manga'];
entry.commands = ['manga'];
entry.cmd = ['manga'];
entry.pattern = 'manga';
entry.help = ['manga <site> <title>'];
entry.tags = ['downloader'];
entry.category = 'downloader';
entry.desc = 'Manga / manhwa downloader (PDF)';
entry.run = entry.execute = entry.handler = entry;

module.exports = entry;
module.exports.handle = handle;
