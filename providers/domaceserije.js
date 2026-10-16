/**
 * Domaće Serije — Nuvio lokalni plugin (QuickJS sandbox).
 *
 * Povlači strimove za domaće serije i filmove sa domaceserije.online /
 * domaceserije.net. Sve se izvršava na uređaju korisnika — nema servera.
 *
 * Sandbox API (proveren u NuvioTV izvoru, PluginRuntime.kt):
 *   - fetch(url, { method, headers, body, signal, redirect })
 *         -> OkHttp most; odgovor ima ok/status/url/headers.get()/text()/json()/arrayBuffer()
 *         -> NEMA cookie jar (nama ne treba, sajt je otvoren)
 *         -> MAX 1 MB po odgovoru, ukupan timeout plugina 60 s
 *   - cheerio (jsoup-backed) — NE koristimo, regex je deterministički
 *   - CryptoJS, atob, btoa, URL, URLSearchParams, AbortController, console
 *   - globalThis.TMDB_API_KEY  (BuildConfig)
 *
 * VAŽNO: Nuvio šalje **TMDB id**, ne IMDb. Zato je TMDB prvi korak.
 * Direktni URL strimovi rade bez ikakvog patcha (patch je potreban samo za
 * torrent `sources`/`fileIdx`).
 *
 * Pisan namerno u ES5 stilu (var/function, bez ?./??/template literala) da bi
 * prošao i kroz QuickJS i kroz Hermes bez transpajlovanja.
 */

// ---------------------------------------------------------------------------
// KONFIGURACIJA
//
// Nuvio 1.0.0 nema UI za podešavanja plugina (SCRAPER_SETTINGS je uvek {}),
// pa se vrednosti čitaju iz SCRAPER_SETTINGS ako postoje, inače se koriste
// podrazumevane ispod. Za promenu domena samo izmeni SITE_KEY.
// ---------------------------------------------------------------------------

var _settings = (function () {
  try {
    return globalThis.SCRAPER_SETTINGS || {};
  } catch (e) {
    return {};
  }
})();

// 'online' (čistiji front-end, deterministički slugovi) ili 'net'
var SITE_KEY = _settings.site || _settings.SITE || 'online';

var MAX_RESULTS = Number(_settings.maxResults) || 10;
// Nerešivi serveri se ne prikazuju: Nuvio plugin ne može da otvori spoljašnji
// link (vidi komentar u getStreams). Uključi samo ako ti treba spisak hostova.
var INCLUDE_UNRESOLVED = _settings.includeUnresolved === true;
// Prikaži Streamtape (MP4) izvore
var SHOW_STREAMTAPE = _settings.showStreamtape !== false;
// Posle ovoliko ms od početka getStreams prestaje byse proof-of-work, da
// plugin ne probije sandbox limit od 60 s (tada Nuvio ne prikaže ništa)
var BUDGET_MS = Number(_settings.budgetMs) || 45000;
// Najveća byse PoW težina (bita) koja se uopšte pokušava
var BYSE_MAX_DIFFICULTY = Number(_settings.byseMaxDifficulty) || 18;
// Koliko uspešnih byse kopija tražiti (svaka je jedan PoW)
var BYSE_MAX_OK = Number(_settings.byseMaxOk) || 1;
// Hostovi za koje znamo da se ne mogu rešiti — ne otvaraju se uopšte
// (rpmhub: "Video not found", abyss: service-worker chunk protokol, filmoland: NXDOMAIN)
var DEAD_HOSTS = { 'ds.rpmhub.site': 1, 'player.abyssplayer.com': 1, 'player.filmoland.com': 1 };

var UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

var ACCEPT_LANG = 'sr-Latn,sr;q=0.9,hr;q=0.8,bs;q=0.7,en;q=0.6';

// ---------------------------------------------------------------------------
// POMOĆNE
// ---------------------------------------------------------------------------

function str(v) {
  return v === null || v === undefined ? '' : String(v);
}

function log(msg) {
  try {
    console.log('DS: ' + msg);
  } catch (e) {
    /* ignore */
  }
}

function warn(msg) {
  try {
    console.error('DS: ' + msg);
  } catch (e) {
    /* ignore */
  }
}

function decodeEntities(s) {
  return str(s)
    .replace(/&#0?39;|&apos;|&#x27;/g, "'")
    .replace(/&quot;|&#34;|&#x22;/g, '"')
    .replace(/&amp;|&#38;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripDiacritics(s) {
  var out = str(s);
  // sr/hr/bs latinica + osnovni akcenti
  var map = {
    'č': 'c', 'ć': 'c', 'ž': 'z', 'š': 's', 'đ': 'd',
    'Č': 'C', 'Ć': 'C', 'Ž': 'Z', 'Š': 'S', 'Đ': 'D',
    'á': 'a', 'à': 'a', 'â': 'a', 'ä': 'a', 'ã': 'a', 'å': 'a',
    'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
    'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
    'ó': 'o', 'ò': 'o', 'ô': 'o', 'ö': 'o', 'õ': 'o',
    'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u',
    'ñ': 'n', 'ç': 'c', 'ý': 'y'
  };
  var res = '';
  for (var i = 0; i < out.length; i++) {
    var c = out.charAt(i);
    res += map.hasOwnProperty(c) ? map[c] : c;
  }
  return res;
}

function norm(s) {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^\s+|\s+$/g, '');
}

function tokens(s) {
  var n = norm(s);
  return n ? n.split(' ').filter(function (t) { return t.length > 0; }) : [];
}

function bigrams(s) {
  var n = norm(s).replace(/ /g, '');
  var out = {};
  for (var i = 0; i < n.length - 1; i++) {
    var g = n.substring(i, i + 2);
    out[g] = (out[g] || 0) + 1;
  }
  return out;
}

function dice(a, b) {
  var A = bigrams(a);
  var B = bigrams(b);
  var sizeA = 0;
  var sizeB = 0;
  var inter = 0;
  var g;
  for (g in A) {
    if (Object.prototype.hasOwnProperty.call(A, g)) sizeA += A[g];
  }
  for (g in B) {
    if (Object.prototype.hasOwnProperty.call(B, g)) sizeB += B[g];
  }
  for (g in A) {
    if (Object.prototype.hasOwnProperty.call(A, g) && B.hasOwnProperty(g)) {
      inter += Math.min(A[g], B[g]);
    }
  }
  if (sizeA + sizeB === 0) return 0;
  return (2 * inter) / (sizeA + sizeB);
}

function jaccard(a, b) {
  var A = {};
  var B = {};
  var ta = tokens(a);
  var tb = tokens(b);
  var i;
  for (i = 0; i < ta.length; i++) A[ta[i]] = 1;
  for (i = 0; i < tb.length; i++) B[tb[i]] = 1;
  var ka = Object.keys(A);
  var kb = Object.keys(B);
  if (!ka.length || !kb.length) return 0;
  var inter = 0;
  for (i = 0; i < ka.length; i++) if (B.hasOwnProperty(ka[i])) inter++;
  return inter / (ka.length + kb.length - inter);
}

function titleSimilarity(query, candidate) {
  var q = norm(query);
  var c = norm(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;

  var score = 0.6 * jaccard(query, candidate) + 0.4 * dice(query, candidate);

  // kratki ostaci (npr. nelatinični naslov koji se normalizuje u "4") ne smeju
  // da se "sadrže" u bilo čemu
  if (Math.min(q.length, c.length) >= 4 && (c.indexOf(q) >= 0 || q.indexOf(c) >= 0)) {
    var ratio = Math.min(q.length, c.length) / Math.max(q.length, c.length);
    var contained = 0.7 + 0.3 * ratio;
    if (contained > score) score = contained;
  }
  return Math.min(score, 1);
}

function yearFromSlug(slug) {
  var m = str(slug).match(/(19|20)\d{2}/);
  return m ? m[0] : null;
}

function stripYear(s) {
  return str(s).replace(/\s*\b(19|20)\d{2}\b\s*$/, '').replace(/\s+$/, '');
}

function dedupeStrings(list) {
  var seen = {};
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var v = str(list[i]).replace(/^\s+|\s+$/g, '');
    var k = v.toLowerCase();
    if (!k || seen[k]) continue;
    seen[k] = 1;
    out.push(v);
  }
  return out;
}

/** Ručno razrešavanje relativnih URL-ova — URL polyfill u sandboxu je krut. */
function absUrl(base, rel) {
  var r = str(rel);
  if (/^https?:\/\//i.test(r)) return r;
  var m = str(base).match(/^(https?:\/\/[^\/]+)/i);
  var origin = m ? m[1] : '';
  if (r.indexOf('//') === 0) return 'https:' + r;
  if (r.charAt(0) === '/') return origin + r;
  // skini poslednji segment sa base (i reši ../ koliko ih ima)
  var b = str(base).replace(/[?#].*$/, '');
  var ups = 0;
  var tmp = r;
  while (tmp.indexOf('../') === 0) {
    ups++;
    tmp = tmp.substring(3);
  }
  var path = b;
  for (var i = 0; i < ups; i++) path = path.replace(/\/[^\/]*$/, '');
  return path.replace(/\/[^\/]*$/, '/') + tmp;
}

function pad2(n) {
  var s = String(n);
  return s.length < 2 ? '0' + s : s;
}

function guessQuality(s) {
  var t = str(s);
  if (/2160p|4k|uhd/i.test(t)) return '4K';
  if (/1440p/i.test(t)) return '1440p';
  if (/1080p|fullhd|fhd/i.test(t)) return '1080p';
  if (/720p/i.test(t)) return '720p';
  if (/576p|480p|360p/i.test(t)) return '480p';
  return '';
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function httpGet(url, opts) {
  opts = opts || {};
  var headers = {
    'User-Agent': opts.userAgent || UA,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': ACCEPT_LANG
  };
  if (opts.headers) {
    for (var h in opts.headers) {
      if (Object.prototype.hasOwnProperty.call(opts.headers, h)) headers[h] = opts.headers[h];
    }
  }
  if (opts.referer) headers.Referer = opts.referer;

  var res = await fetch(url, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body,
    redirect: 'follow'
  });

  var body = '';
  try {
    body = await res.text();
  } catch (e) {
    body = '';
  }
  return { status: res.status, ok: res.ok, text: body, headers: res.headers };
}

async function httpPostJson(url, obj, opts) {
  opts = opts || {};
  var headers = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'Accept-Language': ACCEPT_LANG
  };
  if (opts.origin) headers.Origin = opts.origin;
  if (opts.referer) headers.Referer = opts.referer;

  var res = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(obj),
    redirect: 'follow'
  });
  var text = '';
  try {
    text = await res.text();
  } catch (e) {
    text = '';
  }
  return { status: res.status, ok: res.ok, text: text };
}

// ---------------------------------------------------------------------------
// TMDB — plugin dobija tmdbId, ne IMDb
// ---------------------------------------------------------------------------

var REGION_PRIORITY = { RS: 1, HR: 2, BA: 3, ME: 4, SI: 5, MK: 6, YU: 7, CS: 8 };

// ispred REGION_PRIORITY (1..8) — prevod je najbliži naslovu na sajtovima
var TRANSLATION_PRIORITY = { sr: 0.1, hr: 0.2, bs: 0.3 };

var CYR_LAT = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'ђ': 'đ', 'е': 'e', 'ж': 'ž',
  'з': 'z', 'и': 'i', 'ј': 'j', 'к': 'k', 'л': 'l', 'љ': 'lj', 'м': 'm', 'н': 'n',
  'њ': 'nj', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'ћ': 'ć', 'у': 'u',
  'ф': 'f', 'х': 'h', 'ц': 'c', 'ч': 'č', 'џ': 'dž', 'ш': 'š'
};

function cyrToLat(s) {
  return str(s).replace(/[Ѐ-ӿ]/g, function (ch) {
    var low = ch.toLowerCase();
    var t = CYR_LAT[low];
    if (t === undefined) return ch;
    return ch === low ? t : t.charAt(0).toUpperCase() + t.slice(1);
  });
}

async function tmdbApiMeta(tmdbId, mediaType) {
  var key = globalThis.TMDB_API_KEY;
  if (!key) return null;
  var path = mediaType === 'tv' ? '/3/tv/' : '/3/movie/';
  var url =
    'https://api.themoviedb.org' +
    path +
    encodeURIComponent(tmdbId) +
    '?api_key=' +
    encodeURIComponent(key) +
    '&append_to_response=alternative_titles,external_ids,translations';

  var res;
  try {
    res = await httpGet(url, { headers: { Accept: 'application/json' } });
  } catch (e) {
    warn('TMDB greska: ' + (e && e.message));
    return null;
  }
  if (res.status !== 200) return null;

  var data = null;
  try {
    data = JSON.parse(res.text);
  } catch (e) {
    return null;
  }
  if (!data) return null;

  var name = str(data.name || data.title);
  var original = str(data.original_name || data.original_title);
  var date = mediaType === 'tv' ? data.first_air_date : data.release_date;

  var alts = [];
  var at = data.alternative_titles || {};
  var list = at.results || at.titles || [];
  for (var i = 0; i < list.length; i++) {
    var it = list[i];
    if (!it) continue;
    var t = str(it.title);
    if (!t) continue;
    var iso = str(it.iso_3166_1).toUpperCase();
    alts.push({ title: t, iso: iso, pri: REGION_PRIORITY[iso] || 99 });
  }
  // Prevodi (sr/hr/bs) često imaju lokalni naslov koga nema među alternativnim
  // ("Аватар: Последњи владар ветрова") — idu na sam vrh, ćirilica u latinicu.
  var tr = (data.translations && data.translations.translations) || [];
  for (var k = 0; k < tr.length; k++) {
    var lang = str(tr[k] && tr[k].iso_639_1);
    var tname = tr[k] && tr[k].data && str(tr[k].data.name || tr[k].data.title);
    if (!tname || !TRANSLATION_PRIORITY[lang]) continue;
    alts.push({ title: cyrToLat(tname), iso: lang, pri: TRANSLATION_PRIORITY[lang] });
  }
  alts.sort(function (a, b) { return a.pri - b.pri; });

  var ext = data.external_ids || {};

  return {
    title: name,
    original: original,
    year: date ? str(date).substring(0, 4) : '',
    imdbId: str(ext.imdb_id),
    alts: alts.map(function (a) { return a.title; })
  };
}

/** Rezervna varijanta bez TMDB ključa: keyless /titles stranica. */
async function tmdbScrapeMeta(tmdbId, mediaType) {
  var path = mediaType === 'tv' ? 'tv' : 'movie';
  var url = 'https://www.themoviedb.org/' + path + '/' + encodeURIComponent(tmdbId) + '/titles';
  var res;
  try {
    res = await httpGet(url, {
      headers: { 'Accept-Language': ACCEPT_LANG, Accept: 'text/html,application/xhtml+xml' }
    });
  } catch (e) {
    return null;
  }
  if (res.status !== 200) return null;
  var html = res.text;

  var titles = [];
  var mt = html.match(/<title>(.*?)\s*\((?:TV Series|TV Show|Movie|Miniseries)[^)]*\)/i);
  if (mt) titles.push(decodeEntities(mt[1]));

  var reTable = /<table[^>]*class="[^"]*titles[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  var tb;
  while ((tb = reTable.exec(html))) {
    var reTd = /<td>([\s\S]*?)<\/td>/gi;
    var td;
    while ((td = reTd.exec(tb[1]))) {
      var v = decodeEntities(td[1].replace(/<[^>]+>/g, ''));
      var low = v.toLowerCase();
      if (!v || v.length > 120) continue;
      if (
        low === 'title' || low === 'type' || low === 'título' ||
        low === 'naslov' || low === 'наслов' || low === 'titel'
      ) continue;
      titles.push(v);
    }
  }

  titles = dedupeStrings(titles);
  if (!titles.length) return null;
  return {
    title: titles[0],
    original: '',
    year: '',
    imdbId: '',
    alts: titles.slice(1)
  };
}

async function tmdbMeta(tmdbId, mediaType) {
  var meta = null;
  try {
    meta = await tmdbApiMeta(tmdbId, mediaType);
  } catch (e) {
    meta = null;
  }
  if (meta && (meta.title || meta.original)) return meta;
  try {
    return await tmdbScrapeMeta(tmdbId, mediaType);
  } catch (e) {
    return null;
  }
}

/**
 * Redosled kandidata: originalni naslov → alternativni (regionalni prvo, već
 * sortirani u tmdbApiMeta) → TMDB primarni. Sajt koristi latinične domaće
 * naslove, pa oni idu prvi.
 */
function candidateTitles(meta) {
  var pri = [];
  if (meta.original) pri.push(meta.original);
  for (var i = 0; i < meta.alts.length; i++) pri.push(meta.alts[i]);
  var rest = [];
  if (meta.title && meta.title !== meta.original) rest.push(meta.title);
  return dedupeStrings(pri.concat(rest));
}

// ---------------------------------------------------------------------------
// SAJTOVI (domaceserije.online / .net, exyuteka.net)
//
// Svi rade na istom back-endu (ista `case N: src` lista, isti hostovi), pa se
// za svaki sajt menja samo raspored URL-ova. Sajtovi se pretražuju paralelno,
// serveri se spajaju i dupli (isti embed URL / isti strim) se izbacuju.
//
// `sitemaps`: [putanja, prefiks] parovi za fuzzy katalog. Kod exyuteka slug
// nosi i prefiks kategorije (`film/…`, `crtani/…`), jer od nje zavisi URL.
// ---------------------------------------------------------------------------

var SITES = {
  online: {
    key: 'online',
    label: 'domaceserije.online',
    base: 'https://domaceserije.online',
    searchPath: function (q) { return '/search.php?q=' + encodeURIComponent(q); },
    seriesLinkRe: /href="serija\/([a-z0-9-]+)"/gi,
    filmLinkRe: /href="film\/([a-z0-9-]+)"/gi,
    episodeLinkRe: /\/epizoda\/([a-z0-9-]+?)-s(\d+)e(\d+)/gi,
    seriesUrl: function (s) { return '/serija/' + s; },
    filmUrl: function (s) { return '/film/' + s; },
    episodeUrl: function (s, se, ep) {
      return '/epizoda/' + s + '-s' + pad2(se) + 'e' + pad2(ep);
    },
    sitemaps: {
      series: [['/sitemap-ser.php', 'serija/']],
      films: [['/sitemap-flm.php', 'film/']]
    },
    titleFromSlug: function (s) { return str(s).replace(/-/g, ' '); }
  },
  net: {
    key: 'net',
    label: 'domaceserije.net',
    base: 'https://domaceserije.net',
    searchPath: function (q) { return '/search?q=' + encodeURIComponent(q); },
    seriesLinkRe: /(?:domaca-serija)\/([a-z0-9-]+)/gi,
    filmLinkRe: /(?:domaci-filmovi)\/([a-z0-9-]+)/gi,
    episodeLinkRe: /(?:domace-serije)\/([a-z0-9-]+?)-sezona-(\d+)-epizoda-(\d+)/gi,
    seriesUrl: function (s) { return '/domaca-serija/' + s; },
    filmUrl: function (s) { return '/domaci-filmovi/' + s; },
    episodeUrl: function (s, se, ep) {
      return '/domace-serije/' + s + '-sezona-' + se + '-epizoda-' + ep;
    },
    sitemaps: {
      series: [['/sitemap-ser.php', 'serija/'], ['/sitemap-ser.php', 'domaca-serija/']],
      films: [['/sitemap-flm.php', 'film/'], ['/sitemap-flm.php', 'domaci-filmovi/']]
    },
    titleFromSlug: function (s) {
      return stripYear(str(s).replace(/-ceo-film-online$/, '').replace(/-/g, ' '));
    }
  },
  // exyuteka.net — isti katalog kao domaceserije + sinhronizovani crtani
  // (`crtani/`) i latino serije (`gledaj-online/`, epizode na `/epizode/`).
  exyuteka: {
    key: 'exyuteka',
    label: 'exyuteka.net',
    base: 'https://exyuteka.net',
    searchPath: function (q) { return '/pretraga.php?q=' + encodeURIComponent(q); },
    seriesLinkRe: /href="\/((?:serija|gledaj-online)\/[a-z0-9-]+)"/gi,
    filmLinkRe: /href="\/((?:film|crtani)\/[a-z0-9-]+)"/gi,
    episodeLinkRe: /\/(?:ep|epizode)\/([a-z0-9-]+?)-s(\d+)e(\d+)/gi,
    seriesUrl: function (s) { return '/' + s; },
    filmUrl: function (s) { return '/' + s; },
    episodeUrl: function (s, se, ep) {
      var dir = s.indexOf('gledaj-online/') === 0 ? '/epizode/' : '/ep/';
      return dir + s.replace(/^[a-z-]+\//, '') + '-s' + pad2(se) + 'e' + pad2(ep);
    },
    sitemaps: {
      series: [['/sitemap-ser.php', 'serija/'], ['/sitemap-latino.php', 'gledaj-online/']],
      films: [['/sitemap-flm.php', 'film/'], ['/sitemap-crtaci.php', 'crtani/']]
    },
    keepPrefix: true,
    titleFromSlug: function (s) {
      return stripYear(str(s).replace(/^[a-z-]+\//, '').replace(/-ceo-film-online$/, '').replace(/-/g, ' '));
    }
  }
};

// balkanteka.net — WordPress, drugi back-end (nema `case N: src`), pa ima svoj
// `find`. Rezervni izvor: ~92 % postova ima netu/hqq plejer koji se ne rešava,
// pa se uzimaju samo iframe-ovi razrešivih hostova (byse mirrori, VidHide).
// Serija = kategorija ispod "Domaće serije" (66) / "Turske serije" (82).
var BALKANTEKA_PARENTS = { 66: 1, 82: 1 };

// Sajtovi bez `case N: src` liste daju iframe direktno na stranici; uzimaju se
// samo hostovi koje rezolveri stvarno rešavaju (netu/hqq traži captcha,
// filmoland.com više ne postoji).
var IFRAME_HOST_RE = /^(byse[a-z]*\.(com|sx)|minochinos\.com|callistanise\.com|dingtezuni\.com|morencius\.com|streamtape\.com|(www\.)?ok\.ru|vidara\.(to|cc)|gbsagbo\.com|idgasbhiop\.com|vidmoly\.(org|biz)|drive\.google\.com)$/;

function iframeServers(html, pageUrl, siteLabel) {
  var out = [];
  var seen = {};
  var re = /<iframe[^>]+?(?:data-lazy-src|src)\s*=\s*["']([^"']+)["']/gi;
  var m;
  while ((m = re.exec(html || '')) !== null) {
    var url = m[1].indexOf('//') === 0 ? 'https:' + m[1] : m[1];
    if (seen[url] || !IFRAME_HOST_RE.test(hostOf(url))) continue;
    seen[url] = 1;
    out.push({ id: 'if', url: url, embedUrl: pageUrl, site: siteLabel });
  }
  return out;
}

function balkantekaEpisode(title) {
  var t = decodeEntities(title);
  var e = t.match(/epizoda\s*(\d+)/i);
  if (!e) return null;
  var s = t.match(/sezona\s*(\d+)/i);
  // ponytail: bez "Sezona" u naslovu = sezona 1; serije sa apsolutnim brojem
  // epizode (Divlje pčele 1–150) se zato poklope samo za S01. Mapiranje preko
  // TMDB broja epizoda po sezoni ako zatreba.
  return { season: s ? Number(s[1]) : 1, episode: Number(e[1]) };
}

SITES.balkanteka = {
  key: 'balkanteka',
  label: 'balkanteka.net',
  base: 'https://balkanteka.net',
  find: async function (site, meta, candidates, type, se, ep) {
    if (type !== 'series' || se === null || ep === null) return [];
    var tag = site.label + ': ';
    var api = site.base + '/wp-json/wp/v2/';

    // 1. kategorija serije (WP pretraga kategorija je LIKE, pa fuzzy izbor)
    var items = [];
    var seen = {};
    for (var i = 0; i < candidates.length && i < 4; i++) {
      var res = await httpGet(api + 'categories?per_page=20&_fields=id,name,parent&search=' + encodeURIComponent(candidates[i]));
      if (res.status !== 200) continue;
      var cats = JSON.parse(res.text);
      for (var c = 0; c < cats.length; c++) {
        if (!BALKANTEKA_PARENTS[cats[c].parent] || seen[cats[c].id]) continue;
        seen[cats[c].id] = 1;
        var name = decodeEntities(cats[c].name);
        items.push({ slug: String(cats[c].id), title: name });
        // "Babil (Vavilon)" -> i "Vavilon"
        var paren = name.match(/\(([^)]+)\)/);
        if (paren) items.push({ slug: String(cats[c].id), title: paren[1] });
      }
      if (items.length) break;
    }
    var matched = bestMatch(candidates, items, null);
    if (!matched) {
      warn(tag + 'nema poklapanja za: ' + candidates.join(' / '));
      return [];
    }
    log(tag + 'poklapano: kategorija ' + matched.slug + ' (' + matched.title + ')');

    // 2. postovi te kategorije koji pominju broj epizode (WP search = AND preko reči)
    var pr = await httpGet(api + 'posts?per_page=100&_fields=title,link,content&categories=' +
      matched.slug + '&search=' + encodeURIComponent('epizoda ' + ep));
    if (pr.status !== 200) return [];
    var posts = JSON.parse(pr.text);
    var out = [];
    for (var p = 0; p < posts.length; p++) {
      var info = balkantekaEpisode(posts[p].title && posts[p].title.rendered);
      if (!info || info.season !== se || info.episode !== ep) continue;
      out = out.concat(iframeServers(posts[p].content && posts[p].content.rendered, posts[p].link, site.label));
    }
    if (!out.length) warn(tag + 'S' + pad2(se) + 'E' + pad2(ep) + ' nema razrešiv plejer');
    return out;
  }
};

// samodomace.net — samo filmovi (domaći + sinhronizovani crtani), sopstveni byse
// upload-i. Nema pretrage ni godine u URL-u: fuzzy po sitemapu (787 naslova).
var _samodomaceCatalog = null;

SITES.samodomace = {
  key: 'samodomace',
  label: 'samodomace.net',
  base: 'https://samodomace.net',
  find: async function (site, meta, candidates, type) {
    if (type !== 'movie') return [];
    if (!_samodomaceCatalog) {
      var sm = await httpGet(site.base + '/sitemap.xml');
      if (sm.status !== 200) return [];
      var items = [];
      var re = /\/stream\/([a-z0-9-]+)\/(\d+)\//g;
      var m;
      while ((m = re.exec(sm.text)) !== null) {
        items.push({ slug: m[1] + '/' + m[2], title: m[1].replace(/-/g, ' ') });
      }
      _samodomaceCatalog = items;
    }
    var matched = bestMatch(candidates, _samodomaceCatalog, null);
    if (!matched) return [];
    log(site.label + ': poklapano: ' + matched.slug);
    var pageUrl = site.base + '/stream/' + matched.slug + '/';
    var page = await httpGet(pageUrl);
    return page.status === 200 ? iframeServers(page.text, pageUrl, site.label) : [];
  }
};

// filmoton.ba — WordPress (MasVideos): REST tipovi tv_show / episode / movie.
// Epizoda je `<serija bez godine>-s<S>-epizoda-<E>`, broj ponekad sa 2 ili 3
// cifre (pa i oba — dve kopije), pa se traže sve varijante jednim `slug=` upitom.
// Novije epizode su na byse mirrorima, starije na mrtvom filmoland.com.
function filmotonItems(list) {
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var t = decodeEntities(list[i].title && list[i].title.rendered);
    var y = t.match(/\((\d{4})\)\s*$/);
    out.push({ slug: list[i].slug, link: list[i].link, title: stripYear(t.replace(/\s*\(\d{4}\)\s*$/, '')), year: y ? y[1] : null });
  }
  return out;
}

SITES.filmoton = {
  key: 'filmoton',
  label: 'filmoton.ba',
  base: 'https://filmoton.ba',
  find: async function (site, meta, candidates, type, se, ep) {
    var api = site.base + '/wp-json/wp/v2/';
    var kind = type === 'series' ? 'tv_show' : 'movie';
    if (type === 'series' && (se === null || ep === null)) return [];

    var matched = null;
    for (var i = 0; i < candidates.length && i < 4 && !matched; i++) {
      var res = await httpGet(api + kind + '?per_page=20&_fields=slug,title,link&search=' + encodeURIComponent(candidates[i]));
      if (res.status !== 200) continue;
      matched = bestMatch(candidates, filmotonItems(JSON.parse(res.text)), meta.year);
    }
    if (!matched) return [];
    log(site.label + ': poklapano: ' + matched.slug);

    var links = [matched.link];
    if (type === 'series') {
      // "kumovi-2022" / "igra-sudbine-2020-2" (WP duplikat) -> "kumovi" / "igra-sudbine"
      var base = matched.slug.replace(/-(19|20)\d{2}(-\d+)?$/, '') + '-s' + se + '-epizoda-';
      var slugs = dedupeStrings([base + ep, base + pad2(ep), base + ('00' + ep).slice(-3)]);
      var er = await httpGet(api + 'episode?_fields=link&slug=' + slugs.join(','));
      if (er.status !== 200) return [];
      links = JSON.parse(er.text).map(function (x) { return x.link; });
      if (!links.length) return [];
    }
    var pages = await Promise.all(links.map(function (u) {
      return httpGet(u).then(function (r) { return r.status === 200 ? iframeServers(r.text, u, site.label) : []; }, function () { return []; });
    }));
    var out = [];
    for (var p = 0; p < pages.length; p++) out = out.concat(pages[p]);
    if (!out.length) warn(site.label + ': nema razrešiv plejer (' + links.length + ' str.)');
    return out;
  }
};

// gledajcrtace.net — crtane serije (sinhronizovane / titlovane) i crtani filmovi.
// Sajt nema upotrebljivu pretragu (403 bez cookie-ja), a sitemap je > 1 MB, pa
// plugin čita mali indeks koji tools/build-gledajcrtace.cjs pravi i GitHub
// Actions osvežava (data/gledajcrtace.json pored manifest.json):
//   series: { folder: [[sezona, epizoda, cat, id]] }, films: [[slug, cat, id]]
// Folder nosi oba imena + oznaku zvuka ("patrolne_sape_paw_patrol_sinhronizovano_na_srpski").
var GLEDAJCRTACE_INDEX = _settings.gledajcrtaceIndex ||
  'https://balkan-nuvio.github.io/domace-serije-nuvio/data/gledajcrtace.json';
var _gcIndex = null;

function gcTitle(slug) {
  return str(slug)
    .replace(/_(sinhronizovan|titlovan)\w*$/, '')
    .replace(/_(19|20)\d{2}$/, '')
    .replace(/_39_/g, '')       // "help_i_39_m_a_fish" = "I'm"
    .replace(/_/g, ' ');
}

SITES.gledajcrtace = {
  key: 'gledajcrtace',
  label: 'gledajcrtace.net',
  base: 'https://www.gledajcrtace.net',
  find: async function (site, meta, candidates, type, se, ep) {
    if (type === 'series' && (se === null || ep === null)) return [];
    if (!_gcIndex) {
      var ir = await httpGet(GLEDAJCRTACE_INDEX);
      if (ir.status !== 200) return [];
      _gcIndex = JSON.parse(ir.text);
    }
    var pages = [];
    var i;
    if (type === 'series') {
      var items = [];
      for (var folder in _gcIndex.series) {
        if (Object.prototype.hasOwnProperty.call(_gcIndex.series, folder)) {
          items.push({ slug: folder, title: gcTitle(folder) });
        }
      }
      var best = bestMatch(candidates, items, null);
      if (!best) return [];
      // ista serija često postoji dvaput (sinhronizovano + titlovano)
      for (i = 0; i < items.length; i++) {
        if (items[i].title !== best.title) continue;
        log(site.label + ': poklapano: ' + items[i].slug);
        var eps = _gcIndex.series[items[i].slug];
        for (var e = 0; e < eps.length; e++) {
          if (eps[e][0] === se && eps[e][1] === ep) pages.push(eps[e]);
        }
      }
    } else {
      var films = [];
      for (i = 0; i < _gcIndex.films.length; i++) {
        var f = _gcIndex.films[i];
        films.push({ slug: f[0], title: gcTitle(f[0]), year: yearFromSlug(f[0]), cat: f[1], id: f[2] });
      }
      var fm = bestMatch(candidates, films, meta.year);
      if (!fm) return [];
      log(site.label + ': poklapano: ' + fm.slug);
      pages.push([0, 0, fm.cat, fm.id]);
    }
    var results = await Promise.all(pages.map(function (pg) {
      var url = site.base + '/publ/' + pg[2] + '-1-0-' + pg[3];
      return httpGet(url).then(function (r) {
        return r.status === 200 ? iframeServers(r.text, url, site.label) : [];
      }, function () { return []; });
    }));
    var out = [];
    for (i = 0; i < results.length; i++) out = out.concat(results[i]);
    return out;
  }
};

// domaceserije domen (SITE_KEY) + rezervni sajtovi; `<ključ>: false` u
// podešavanjima gasi pojedinačan sajt (npr. `filmoton: false`)
var ACTIVE_SITES = [SITES[SITE_KEY] || SITES.online];
['exyuteka', 'balkanteka', 'samodomace', 'filmoton', 'gledajcrtace'].forEach(function (k) {
  if (_settings[k] !== false && k !== SITE_KEY) ACTIVE_SITES.push(SITES[k]);
});

function siteUrl(site, path) {
  return site.base + path;
}

function collectMatches(html, re) {
  var out = [];
  var seen = {};
  re.lastIndex = 0;
  var m;
  while ((m = re.exec(html)) !== null) {
    if (!seen[m[1]]) {
      seen[m[1]] = 1;
      out.push(m[1]);
    }
  }
  return out;
}

async function searchSite(site, query) {
  var res;
  try {
    res = await httpGet(siteUrl(site, site.searchPath(query)));
  } catch (e) {
    return { series: [], films: [] };
  }
  if (res.status !== 200) return { series: [], films: [] };
  return {
    series: collectMatches(res.text, site.seriesLinkRe),
    films: collectMatches(res.text, site.filmLinkRe)
  };
}

/* --- katalog iz sitemapa (keširan u memoriji, sandbox nema fajl sistem) --- */

var _catalogs = {};
var _catalogPromises = {};

function slugsFromSitemap(xml, prefix, keepPrefix) {
  var out = [];
  var re = /<loc>([^<]+)<\/loc>/gi;
  var needle = '/' + prefix;
  var m;
  while ((m = re.exec(xml)) !== null) {
    var u = m[1];
    var idx = u.indexOf(needle);
    if (idx < 0) continue;
    var rest = u.substring(idx + needle.length);
    if (rest && rest.indexOf('/') < 0) out.push(keepPrefix ? prefix + rest : rest);
  }
  return out;
}

async function slugsFromSitemaps(site, list) {
  var xmls = {};
  var paths = dedupeStrings(list.map(function (p) { return p[0]; }));
  await Promise.all(paths.map(function (path) {
    return httpGet(siteUrl(site, path)).then(function (r) {
      xmls[path] = r.status === 200 ? r.text : '';
    }, function () {
      xmls[path] = '';
    });
  }));
  var out = [];
  for (var i = 0; i < list.length; i++) {
    out = out.concat(slugsFromSitemap(xmls[list[i][0]], list[i][1], site.keepPrefix));
  }
  return dedupeStrings(out);
}

async function buildCatalog(site) {
  var seriesSlugs = await slugsFromSitemaps(site, site.sitemaps.series);
  var filmSlugs = await slugsFromSitemaps(site, site.sitemaps.films);

  var series = [];
  var films = [];
  var i;
  for (i = 0; i < seriesSlugs.length; i++) {
    series.push({ slug: seriesSlugs[i], title: site.titleFromSlug(seriesSlugs[i]) });
  }
  for (i = 0; i < filmSlugs.length; i++) {
    films.push({
      slug: filmSlugs[i],
      title: site.titleFromSlug(filmSlugs[i]),
      year: yearFromSlug(filmSlugs[i])
    });
  }
  return { series: series, films: films };
}

async function getCatalog(site) {
  var k = site.key;
  if (_catalogs[k]) return _catalogs[k];
  if (!_catalogPromises[k]) {
    _catalogPromises[k] = buildCatalog(site).then(function (c) {
      _catalogs[k] = c;
      _catalogPromises[k] = null;
      log(site.label + ' katalog: ' + c.series.length + ' serija / ' + c.films.length + ' filmova');
      return c;
    }, function () {
      _catalogPromises[k] = null;
      return { series: [], films: [] };
    });
  }
  return _catalogPromises[k];
}

function bestMatch(candidates, items, year, minScore) {
  if (minScore === undefined) minScore = 0.55;
  var best = null;
  var bestScore = 0;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    for (var j = 0; j < candidates.length; j++) {
      var cand = candidates[j];
      if (!cand) continue;
      // isti naslov, druga godina = drugo delo (Avatar 2005 animirani vs 2024
      // igrani); ±1 zbog festivalskog / regionalnog datuma
      if (year && item.year && Math.abs(Number(item.year) - Number(year)) > 1) continue;
      var sim = titleSimilarity(cand, item.title);
      // ista godina ne sme sama da izvuče slab naslov ("Kung Fu Panda 4" -> "gym-2024")
      if (sim < 0.5) continue;
      var s = sim - j * 0.02;
      if (year && item.year) {
        if (String(item.year) === String(year)) s += 0.25;
        else s -= 0.15;
      }
      if (s > bestScore) {
        bestScore = s;
        best = item;
      }
    }
  }
  if (!best || bestScore < minScore) return null;
  best.score = Math.round(bestScore * 1000) / 1000;
  return best;
}

/* --- stranice --- */

async function listEpisodes(site, slug) {
  var res;
  try {
    res = await httpGet(siteUrl(site, site.seriesUrl(slug)));
  } catch (e) {
    return [];
  }
  if (res.status !== 200) return [];
  var out = [];
  var seen = {};
  site.episodeLinkRe.lastIndex = 0;
  var m;
  while ((m = site.episodeLinkRe.exec(res.text)) !== null) {
    var key = m[1] + '|' + m[2] + '|' + m[3];
    if (seen[key]) continue;
    seen[key] = 1;
    out.push({ slug: m[1], season: Number(m[2]), episode: Number(m[3]) });
  }
  return out;
}

async function getEmbedUrl(pageUrl) {
  var res;
  try {
    res = await httpGet(pageUrl);
  } catch (e) {
    return null;
  }
  if (res.status !== 200) return null;

  var re = /<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi;
  var m;
  var fallback = null;
  while ((m = re.exec(res.text)) !== null) {
    var src = m[1];
    if (!src || src === 'about:blank') continue;
    if (
      /\/(embed|zsrv)\b/i.test(src) ||
      /(sro1|srofilm|embed2?|exyuvid)/i.test(src)
    ) {
      return absUrl(pageUrl, src);
    }
    if (!fallback && /^https?:\/\//i.test(src)) fallback = src;
  }
  return fallback;
}

function parseServers(embedText, embedUrl) {
  var out = [];
  var seen = {};
  var re = /case\s+(\d+)\s*:\s*src\s*=\s*["']([^"']+)["']/gi;
  var m;
  while ((m = re.exec(embedText)) !== null) {
    var url = m[2];
    if (!url) continue;
    url = absUrl(embedUrl, url);
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen[url]) continue;
    seen[url] = 1;
    out.push({ id: m[1], url: url });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dean Edwards unpacker — BEZ eval (sandbox ga može blokirati)
// ---------------------------------------------------------------------------

function readJsString(s, start) {
  var quote = s.charAt(start);
  var i = start + 1;
  var out = '';
  while (i < s.length) {
    var c = s.charAt(i);
    if (c === '\\') {
      var n = s.charAt(i + 1);
      if (n === 'x') {
        out += String.fromCharCode(parseInt(s.substring(i + 2, i + 4), 16));
        i += 4;
        continue;
      }
      if (n === 'u') {
        out += String.fromCharCode(parseInt(s.substring(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      if (n === 'n') out += '\n';
      else if (n === 'r') out += '\r';
      else if (n === 't') out += '\t';
      else if (n === 'b') out += '\b';
      else if (n === 'f') out += '\f';
      else if (n === '0') out += '\0';
      else out += n;
      i += 2;
      continue;
    }
    if (c === quote) {
      i++;
      break;
    }
    out += c;
    i++;
  }
  return { value: out, next: i };
}

function skipWs(s, i) {
  while (i < s.length && /\s/.test(s.charAt(i))) i++;
  return i;
}

/** Pokreni jedan `eval(function(p,a,c,k,e,d){…}('P',A,C,'K'.split('|'),0,{}))`. */
function runPacked(code) {
  var fnStart = code.indexOf('function(');
  if (fnStart < 0) return null;
  var bodyOpen = code.indexOf('{', fnStart);
  if (bodyOpen < 0) return null;

  // string-aware scan do zatvarajuće } tela funkcije
  var depth = 0;
  var i = bodyOpen;
  var inStr = null;
  var esc = false;
  for (; i < code.length; i++) {
    var ch = code.charAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }

  var argsOpen = code.indexOf('(', i);
  if (argsOpen < 0) return null;
  var args = code.substring(argsOpen + 1, code.length - 1);

  // parsiraj: 'P',A,C,'K'.split('|'),0,{}
  var pos = skipWs(args, 0);
  if (args.charAt(pos) !== "'" && args.charAt(pos) !== '"') return null;
  var pr = readJsString(args, pos);
  var p = pr.value;
  pos = skipWs(args, pr.next);

  if (args.charAt(pos) !== ',') return null;
  pos = skipWs(args, pos + 1);
  var numA = '';
  while (pos < args.length && /[0-9]/.test(args.charAt(pos))) numA += args.charAt(pos++);
  var a = parseInt(numA, 10);

  pos = skipWs(args, pos);
  if (args.charAt(pos) !== ',') return null;
  pos = skipWs(args, pos + 1);
  var numC = '';
  while (pos < args.length && /[0-9]/.test(args.charAt(pos))) numC += args.charAt(pos++);
  var c = parseInt(numC, 10);

  pos = skipWs(args, pos);
  if (args.charAt(pos) !== ',') return null;
  pos = skipWs(args, pos + 1);
  if (args.charAt(pos) !== "'" && args.charAt(pos) !== '"') return null;
  var kr = readJsString(args, pos);
  var k = kr.value.split('|');

  if (!a || !c) return null;

  var out = p;
  while (c--) {
    if (k[c]) {
      out = out.replace(new RegExp('\\b' + c.toString(a) + '\\b', 'g'), k[c]);
    }
  }
  return out;
}

function unpackAll(html) {
  var out = [];
  var marker = 'eval(function(p,a,c,k,e';
  var idx = 0;
  while ((idx = html.indexOf(marker, idx)) !== -1) {
    var open = html.indexOf('(', idx);
    var depth = 0;
    var i = open;
    var inStr = null;
    var esc = false;
    for (; i < html.length; i++) {
      var ch = html.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        inStr = ch;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    var code = html.substring(idx, i + 1);
    try {
      var res = runPacked(code);
      if (res) out.push(res);
    } catch (e) {
      /* preskoči neispravan blok */
    }
    idx = i + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// REZOLVERI
// ---------------------------------------------------------------------------

function hostOf(url) {
  var m = str(url).match(/^https?:\/\/([^\/:]+)/i);
  return m ? m[1].toLowerCase() : '';
}

/* vidara.to — POST /api/stream -> streaming_url (HLS) */
async function resolveVidara(embedUrl) {
  var m = str(embedUrl).match(/^https?:\/\/([^\/]+)/i);
  if (!m) return [];
  var origin = m[0];
  var code = str(embedUrl).replace(/[?#].*$/, '').split('/').filter(function (x) {
    return x.length > 0;
  }).pop();
  if (!code) return [];

  var res;
  try {
    res = await httpPostJson(
      origin + '/api/stream',
      { filecode: code, device: 'web', codecs: ['h265', 'av1'] },
      { origin: origin, referer: embedUrl }
    );
  } catch (e) {
    return [];
  }
  if (res.status !== 200) return [];

  var j = null;
  try {
    j = JSON.parse(res.text);
  } catch (e) {
    return [];
  }
  if (!j || !j.streaming_url) return [];

  var subs = [];
  if (j.subtitles && j.subtitles.length) {
    for (var i = 0; i < j.subtitles.length; i++) {
      var s = j.subtitles[i];
      if (s && s.url) {
        subs.push({
          url: s.url,
          language: str(s.language || s.lang || s.label || 'Unknown'),
          name: 'Vidara'
        });
      }
    }
  }
  return [{ url: j.streaming_url, kind: 'hls', server: 'Vidara', subtitles: subs }];
}

/* streamtape.com — deobfuskacija inline JS-a */
var ST_RE =
  /innerHTML\s*=\s*['"]([^'"]*)['"]\s*\+\s*(?:''\s*\+\s*)?\(?\s*['"]([^'"]+)['"]\s*\)?((?:\.substring\(\d+\))+)/g;

async function resolveStreamtape(embedUrl, html) {
  var page = html;
  if (page === null || page === undefined) {
    try {
      var res = await httpGet(embedUrl);
      if (res.status !== 200) return [];
      page = res.text;
    } catch (e) {
      return [];
    }
  }

  // Embed je /e/<id>; pravi get_video link MORA nositi isti id.
  // Stranica generiše više obfuskacija po učitavanju i neke daju URL koji
  // izgleda ispravno (`?id=…`) ali ima pokvaren id — ovo ga odbacuje bez
  // dodatnog mrežnog zahteva.
  var embedId = (str(embedUrl).match(/\/e\/([A-Za-z0-9]+)/) || [])[1] || '';

  var out = [];
  var seen = {};
  ST_RE.lastIndex = 0;
  var m;
  while ((m = ST_RE.exec(page)) !== null) {
    var s = m[2];
    var reSub = /\.substring\((\d+)\)/g;
    var sm;
    while ((sm = reSub.exec(m[3])) !== null) {
      s = s.substring(Number(sm[1]));
    }
    var url = m[1] + s;
    if (url.indexOf('//') === 0) url = 'https:' + url;
    if (!/^https?:\/\//i.test(url)) {
      if (url.indexOf('/get_video?') !== 0) continue;
      url = 'https://streamtape.com' + url;
    }
    if (hostOf(url) !== 'streamtape.com') continue;
    // pravi link je uvek tačno ".../get_video?id=<id>&..."; mamci koriste
    // idb=, ib= ili pokvaren id
    if (url.indexOf('https://streamtape.com/get_video?id=') !== 0) continue;

    var id = null;
    var token = null;
    var q = url.indexOf('?');
    if (q < 0) continue;
    var params = url.substring(q + 1).split('&');
    for (var i = 0; i < params.length; i++) {
      var eq = params[i].indexOf('=');
      if (eq < 0) continue;
      var kk = params[i].substring(0, eq);
      var vv = params[i].substring(eq + 1);
      if (kk === 'id') id = vv;
      else if (kk === 'token') token = vv;
    }
    if (!id || !token) continue;
    if (embedId && id !== embedId) continue;

    var key = id + '|' + token;
    if (seen[key]) continue;
    seen[key] = 1;
    out.push({ url: url, kind: 'mp4', server: 'Streamtape' });
  }
  return out;
}

/* VidHide familija (morencius.com, vidhide.*, vidmoly.*) */
async function resolveVidhide(embedUrl, html) {
  var page = html;
  if (page === null || page === undefined) {
    try {
      var res = await httpGet(embedUrl);
      if (res.status !== 200) return [];
      page = res.text;
    } catch (e) {
      return [];
    }
  }

  var origin = 'https://' + hostOf(embedUrl);
  var out = [];
  var seen = {};

  function push(raw, label) {
    if (!raw) return;
    var v = str(raw).replace(/^\s+|\s+$/g, '');
    if (!v) return;
    if (v.indexOf('//') === 0) v = 'https:' + v;
    else if (v.charAt(0) === '/') v = origin + v;
    if (!/^https?:\/\//i.test(v)) return;
    if (!/\.(m3u8|txt)(\?|$)/i.test(v) && !/\/hls\d?\//i.test(v)) return;
    if (seen[v]) return;
    seen[v] = 1;
    out.push({ url: v, kind: 'hls', server: label });
  }

  var sources = unpackAll(page);
  for (var i = 0; i < sources.length; i++) {
    var src = sources[i];
    var m = src.match(/links\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (m) {
      var obj = null;
      try {
        obj = JSON.parse(m[1]);
      } catch (e) {
        obj = null;
      }
      if (obj) {
        push(obj.hls2, 'VidHide');
        push(obj.hls3, 'VidHide');
        push(obj.hls4, 'VidHide');
      }
    }
    var reU = /https?:\/\/[^\s"'<>\\]+master\.m3u8[^\s"'<>\\]*/gi;
    var um;
    while ((um = reU.exec(src)) !== null) push(um[0], 'VidHide');
  }
  return out;
}

/* Sopstveni plejer sajta / sve-epizode — direktan <source src> ili const SRC */
var SOURCE_PATTERNS = [
  /<source[^>]+src\s*=\s*["']([^"']+)["']/i,
  /\bSRC\s*=\s*["']([^"']+)["']/i,
  /<video[^>]+src\s*=\s*["']([^"']+)["']/i,
  /["'](https?:\/\/[^"'\s]+\.(?:mp4|m3u8)(?:\?[^"'\s]*)?)["']/i
];

async function resolveDirectSource(embedUrl, html) {
  var page = html;
  if (page === null || page === undefined) {
    try {
      var res = await httpGet(embedUrl);
      if (res.status !== 200) return [];
      page = res.text;
    } catch (e) {
      return [];
    }
  }
  for (var i = 0; i < SOURCE_PATTERNS.length; i++) {
    var m = page.match(SOURCE_PATTERNS[i]);
    if (!m || !m[1]) continue;
    var u = str(m[1]).replace(/^\s+|\s+$/g, '');
    if (u.indexOf('//') === 0) u = 'https:' + u;
    if (!/^https?:\/\//i.test(u)) u = absUrl(embedUrl, u);
    if (!/\.(mp4|m3u8)(\?|$)/i.test(u)) continue;
    return [{
      url: u,
      kind: /\.m3u8(\?|$)/i.test(u) ? 'hls' : 'mp4',
      server: hostOf(u) || 'Direktno'
    }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// bysebuho.com — captcha je PROOF-OF-WORK, a playback konfig je AES-256-GCM
//
// Sandbox nema crypto.subtle, a CryptoJS ovde nema GCM — zato je AES-256-CTR
// implementiran ručno (GCM = CTR + GHASH; tag nam ne treba, serveru verujemo).
//
//   POST /api/videos/<code>/embed/captcha         -> nonce/difficulty/token
//   POST /api/videos/<code>/embed/captcha/verify  -> clearance token
//   POST /api/videos/<code>/embed/playback        -> {algorithm, iv, payload, key_parts, version}
//
// Deklarisani algoritam je "sha256-leading-zero-bits" ali je to mamac —
// prava funkcija je `gr()` iz pow-*.js plejera (ispod). Sa SHA-256 server
// vraća "pow_failed".
// ---------------------------------------------------------------------------

var BYSE_BE = 512;
var BYSE_LT = 511;
var BYSE_DR = 2;
var BYSE_LR = 2654435761;
var BYSE_HR = 2246822519;

function rotl32(t, e) {
  return ((t << e) | (t >>> (32 - e))) >>> 0;
}

function imul32(t, e) {
  if (Math.imul) return Math.imul(t, e) >>> 0;
  var ah = (t >>> 16) & 0xffff, al = t & 0xffff;
  var bh = (e >>> 16) & 0xffff, bl = e & 0xffff;
  return (al * bl + ((ah * bl + al * bh) << 16)) >>> 0;
}

function byseRound(t) {
  t[0] = (t[0] + t[1]) >>> 0;
  t[3] = rotl32(t[3] ^ t[0], 16);
  t[2] = (t[2] + t[3]) >>> 0;
  t[1] = rotl32(t[1] ^ t[2], 12);
  t[0] = (t[0] + t[1]) >>> 0;
  t[3] = rotl32(t[3] ^ t[0], 8);
  t[2] = (t[2] + t[3]) >>> 0;
  t[1] = rotl32(t[1] ^ t[2], 7);
}

function byseHash(msg) {
  var e = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762]);
  var i, s, a, c, d;
  for (i = 0; i < msg.length; i++) {
    e[0] = (e[0] + msg[i]) >>> 0;
    e[0] = rotl32(e[0], 7);
    byseRound(e);
  }
  for (i = 0; i < 8; i++) byseRound(e);
  var r = new Uint32Array(BYSE_BE);
  for (i = 0; i < BYSE_BE; i++) {
    byseRound(e);
    r[i] = (e[0] ^ e[2]) >>> 0;
  }
  for (i = 0; i < BYSE_DR; i++) {
    for (s = 0; s < BYSE_BE; s++) {
      a = r[s] & BYSE_LT;
      c = (r[s] + r[a]) >>> 0;
      c = rotl32(c, 13);
      c = (c ^ imul32(r[(s + 1) & BYSE_LT], BYSE_LR)) >>> 0;
      r[s] = c;
      e[0] = (e[0] ^ c) >>> 0;
      byseRound(e);
    }
  }
  var n = new Uint32Array(8);
  var o = BYSE_BE / 8;
  for (i = 0; i < 8; i++) {
    byseRound(e);
    s = e[0];
    a = i * o;
    for (c = 0; c < o; c++) {
      d = r[a + c];
      s = (s + d) >>> 0;
      s = rotl32(s, 5);
      s = (s ^ imul32(d, BYSE_HR)) >>> 0;
    }
    n[i] = (s ^ e[2]) >>> 0;
  }
  return n;
}

function byseLeadingZeroBits(words) {
  var n = 0;
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (w === 0) { n += 32; continue; }
    return n + Math.clz32(w);
  }
  return n;
}

function byseAscii(s) {
  var b = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
}

/** Nađi s tako da byseHash(nonce + ':' + s) ima >= difficulty nula bitova. */
// Rok za PoW (ms od epohe); postavlja ga getStreams.
// ponytail: modulska promenljiva umesto provlačenja kroz 3 funkcije — plugin
// obrađuje jedan getStreams poziv u isto vreme.
var _byseDeadline = 0;

function byseSolvePow(nonce, difficulty, maxTries) {
  var prefix = nonce + ':';
  var diff = Number(difficulty) || 16;
  // cena raste 2^diff: 16 ≈ 2 s u Node-u, 20 ≈ 25 s (QuickJS višestruko sporije).
  // Server je posle mnogo zahteva sa iste IP davao 20 — tada odustani odmah.
  if (diff > BYSE_MAX_DIFFICULTY) {
    warn('byse PoW difficulty ' + diff + ' > ' + BYSE_MAX_DIFFICULTY + ', preskačem');
    return null;
  }
  var cap = maxTries || 4000000;
  // > 32 bita (nikad viđeno) traži više izlaznih reči — spori referentni put
  if (diff > 32) {
    for (var t = 0; t < cap; t++) {
      if ((t & 2047) === 0 && _byseDeadline && Date.now() > _byseDeadline) return null;
      if (byseLeadingZeroBits(byseHash(byseAscii(prefix + t))) >= diff) return String(t);
    }
    return null;
  }

  // Isti heš kao byseHash, ali ručno razvijen za vrući krug: stanje u lokalnim
  // promenljivama umesto Uint32Array, runda inline (QuickJS skupo plaća svaki
  // poziv funkcije), bafer se ne alocira po pokušaju, a staje se posle prve
  // izlazne reči (difficulty <= 32 gleda samo nju). Proverava ga test/pow.cjs.
  var pre = byseAscii(prefix);
  var L = pre.length;
  var msg = new Uint8Array(L + 16);
  msg.set(pre);
  var r = new Int32Array(BYSE_BE);
  var e0, e1, e2, e3, i, j, a, c, d, n, ds, acc;

  for (var s = 0; s < cap; s++) {
    // PoW je sinhron; bez ove provere jedan težak nonce (difficulty 20 ≈ 1M
    // heševa) pojede ceo budžet plugina
    if ((s & 2047) === 0 && _byseDeadline && Date.now() > _byseDeadline) return null;

    ds = String(s);
    n = L + ds.length;
    for (j = 0; j < ds.length; j++) msg[L + j] = ds.charCodeAt(j);

    e0 = 1779033703; e1 = -1150833019; e2 = 1013904242; e3 = -1521486534;
    for (i = 0; i < n; i++) {
      e0 = (e0 + msg[i]) | 0; e0 = (e0 << 7) | (e0 >>> 25);
      e0 = (e0 + e1) | 0; e3 ^= e0; e3 = (e3 << 16) | (e3 >>> 16);
      e2 = (e2 + e3) | 0; e1 ^= e2; e1 = (e1 << 12) | (e1 >>> 20);
      e0 = (e0 + e1) | 0; e3 ^= e0; e3 = (e3 << 8) | (e3 >>> 24);
      e2 = (e2 + e3) | 0; e1 ^= e2; e1 = (e1 << 7) | (e1 >>> 25);
    }
    for (i = 0; i < 8; i++) {
      e0 = (e0 + e1) | 0; e3 ^= e0; e3 = (e3 << 16) | (e3 >>> 16);
      e2 = (e2 + e3) | 0; e1 ^= e2; e1 = (e1 << 12) | (e1 >>> 20);
      e0 = (e0 + e1) | 0; e3 ^= e0; e3 = (e3 << 8) | (e3 >>> 24);
      e2 = (e2 + e3) | 0; e1 ^= e2; e1 = (e1 << 7) | (e1 >>> 25);
    }
    for (i = 0; i < BYSE_BE; i++) {
      e0 = (e0 + e1) | 0; e3 ^= e0; e3 = (e3 << 16) | (e3 >>> 16);
      e2 = (e2 + e3) | 0; e1 ^= e2; e1 = (e1 << 12) | (e1 >>> 20);
      e0 = (e0 + e1) | 0; e3 ^= e0; e3 = (e3 << 8) | (e3 >>> 24);
      e2 = (e2 + e3) | 0; e1 ^= e2; e1 = (e1 << 7) | (e1 >>> 25);
      r[i] = e0 ^ e2;
    }
    for (j = 0; j < BYSE_DR; j++) {
      for (i = 0; i < BYSE_BE; i++) {
        a = r[i] & BYSE_LT;
        c = (r[i] + r[a]) | 0;
        c = (c << 13) | (c >>> 19);
        c ^= Math.imul(r[(i + 1) & BYSE_LT], BYSE_LR);
        r[i] = c;
        e0 ^= c;
        e0 = (e0 + e1) | 0; e3 ^= e0; e3 = (e3 << 16) | (e3 >>> 16);
        e2 = (e2 + e3) | 0; e1 ^= e2; e1 = (e1 << 12) | (e1 >>> 20);
        e0 = (e0 + e1) | 0; e3 ^= e0; e3 = (e3 << 8) | (e3 >>> 24);
        e2 = (e2 + e3) | 0; e1 ^= e2; e1 = (e1 << 7) | (e1 >>> 25);
      }
    }
    // prva izlazna reč (n[0] u byseHash)
    e0 = (e0 + e1) | 0; e3 ^= e0; e3 = (e3 << 16) | (e3 >>> 16);
    e2 = (e2 + e3) | 0; e1 ^= e2; e1 = (e1 << 12) | (e1 >>> 20);
    e0 = (e0 + e1) | 0; e3 ^= e0; e3 = (e3 << 8) | (e3 >>> 24);
    e2 = (e2 + e3) | 0; e1 ^= e2; e1 = (e1 << 7) | (e1 >>> 25);
    acc = e0;
    for (i = 0; i < BYSE_BE / 8; i++) {
      d = r[i];
      acc = (acc + d) | 0;
      acc = (acc << 5) | (acc >>> 27);
      acc ^= Math.imul(d, BYSE_HR);
    }
    if (Math.clz32(acc ^ e2) >= diff) return String(s);
  }
  return null;
}

/* ---- AES-256-CTR (ručno, bez zavisnosti) ---- */

var AES_SBOX = [
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
];
var AES_RCON = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];

function aesXtime(b) { return ((b << 1) ^ ((b & 0x80) ? 0x1b : 0)) & 0xff; }

function aesMul(a, b) {
  var r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = aesXtime(a);
    b >>= 1;
  }
  return r & 0xff;
}

function aes256ExpandKey(key) {
  var Nk = 8, Nr = 14, w = new Array(4 * (Nr + 1));
  var i, t;
  for (i = 0; i < Nk; i++) {
    w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
  }
  for (i = Nk; i < w.length; i++) {
    t = w[i - 1];
    if (i % Nk === 0) {
      t = ((t << 8) | (t >>> 24)) >>> 0;
      t = ((AES_SBOX[(t >>> 24) & 0xff] << 24) | (AES_SBOX[(t >>> 16) & 0xff] << 16) |
           (AES_SBOX[(t >>> 8) & 0xff] << 8) | AES_SBOX[t & 0xff]) >>> 0;
      t = (t ^ (AES_RCON[i / Nk - 1] << 24)) >>> 0;
    } else if (i % Nk === 4) {
      t = ((AES_SBOX[(t >>> 24) & 0xff] << 24) | (AES_SBOX[(t >>> 16) & 0xff] << 16) |
           (AES_SBOX[(t >>> 8) & 0xff] << 8) | AES_SBOX[t & 0xff]) >>> 0;
    }
    w[i] = (w[i - Nk] ^ t) >>> 0;
  }
  return w;
}

function aes256EncryptBlock(w, input) {
  var s = new Array(16), t = new Array(16), sh, r, c, i;
  var k0, k1, k2, k3, a0, a1, a2, a3;
  for (i = 0; i < 16; i++) s[i] = input[i];

  for (i = 0; i < 4; i++) {
    k0 = w[i];
    s[4 * i] ^= (k0 >>> 24) & 0xff;
    s[4 * i + 1] ^= (k0 >>> 16) & 0xff;
    s[4 * i + 2] ^= (k0 >>> 8) & 0xff;
    s[4 * i + 3] ^= k0 & 0xff;
  }

  for (r = 1; r <= 14; r++) {
    for (i = 0; i < 16; i++) t[i] = AES_SBOX[s[i]];
    sh = [t[0], t[5], t[10], t[15], t[4], t[9], t[14], t[3],
          t[8], t[13], t[2], t[7], t[12], t[1], t[6], t[11]];
    for (i = 0; i < 16; i++) s[i] = sh[i];
    if (r !== 14) {
      for (c = 0; c < 4; c++) {
        a0 = s[4 * c]; a1 = s[4 * c + 1]; a2 = s[4 * c + 2]; a3 = s[4 * c + 3];
        s[4 * c] = aesMul(a0, 2) ^ aesMul(a1, 3) ^ a2 ^ a3;
        s[4 * c + 1] = a0 ^ aesMul(a1, 2) ^ aesMul(a2, 3) ^ a3;
        s[4 * c + 2] = a0 ^ a1 ^ aesMul(a2, 2) ^ aesMul(a3, 3);
        s[4 * c + 3] = aesMul(a0, 3) ^ a1 ^ a2 ^ aesMul(a3, 2);
      }
    }
    k0 = w[4 * r]; k1 = w[4 * r + 1]; k2 = w[4 * r + 2]; k3 = w[4 * r + 3];
    s[0] ^= (k0 >>> 24) & 0xff; s[1] ^= (k0 >>> 16) & 0xff; s[2] ^= (k0 >>> 8) & 0xff; s[3] ^= k0 & 0xff;
    s[4] ^= (k1 >>> 24) & 0xff; s[5] ^= (k1 >>> 16) & 0xff; s[6] ^= (k1 >>> 8) & 0xff; s[7] ^= k1 & 0xff;
    s[8] ^= (k2 >>> 24) & 0xff; s[9] ^= (k2 >>> 16) & 0xff; s[10] ^= (k2 >>> 8) & 0xff; s[11] ^= k2 & 0xff;
    s[12] ^= (k3 >>> 24) & 0xff; s[13] ^= (k3 >>> 16) & 0xff; s[14] ^= (k3 >>> 8) & 0xff; s[15] ^= k3 & 0xff;
  }
  return s;
}

/** AES-256-CTR; counter je 16 bajtova i inkrementira se big-endian. */
function aes256Ctr(key, counter, data) {
  var w = aes256ExpandKey(key);
  var ctr = counter.slice(0, 16);
  var out = new Array(data.length);
  var ks, i, j;
  for (i = 0; i < data.length; i += 16) {
    ks = aes256EncryptBlock(w, ctr);
    for (j = 0; j < 16 && i + j < data.length; j++) out[i + j] = data[i + j] ^ ks[j];
    for (j = 15; j >= 0; j--) {
      ctr[j] = (ctr[j] + 1) & 0xff;
      if (ctr[j] !== 0) break;
    }
  }
  return out;
}

/* ---- base64url / UTF-8 (nema TextDecoder) ---- */

function b64uToBytes(s) {
  var t = str(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4 !== 0) t += '=';
  var bin = atob(t);
  var out = new Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

function utf8Decode(bytes) {
  var out = '', i = 0, c, c2, c3, c4, cp;
  while (i < bytes.length) {
    c = bytes[i++];
    if (c < 0x80) out += String.fromCharCode(c);
    else if (c >= 0xc0 && c < 0xe0) {
      c2 = bytes[i++];
      out += String.fromCharCode(((c & 0x1f) << 6) | (c2 & 0x3f));
    } else if (c >= 0xe0 && c < 0xf0) {
      c2 = bytes[i++]; c3 = bytes[i++];
      out += String.fromCharCode(((c & 0x0f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f));
    } else {
      c2 = bytes[i++]; c3 = bytes[i++]; c4 = bytes[i++];
      cp = ((c & 0x07) << 18) | ((c2 & 0x3f) << 12) | ((c3 & 0x3f) << 6) | (c4 & 0x3f);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

/** version = n  ->  key_parts[n-1] + key_parts[30-n]  (16 + 16 = 32 bajta) */
function byseDecryptPlayback(pb) {
  var parts = pb.key_parts || [];
  var idx = null;
  if (typeof pb.version === 'string' && pb.version !== '') {
    var n = parseInt(pb.version, 10);
    var m = 31 - n;
    if (n >= 1 && n <= 20 && m >= 1 && n <= parts.length && m <= parts.length) idx = [n, m];
  }
  var chosen = idx ? [parts[idx[0] - 1], parts[idx[1] - 1]] : parts;
  var key = [];
  for (var i = 0; i < chosen.length; i++) {
    if (typeof chosen[i] !== 'string' || chosen[i].length === 0) continue;
    key = key.concat(b64uToBytes(chosen[i]));
  }
  if (key.length !== 32) return null;

  var iv = b64uToBytes(pb.iv);
  var blob = b64uToBytes(pb.payload);
  if (iv.length !== 12 || blob.length < 17) return null;

  var ct = blob.slice(0, blob.length - 16);
  // GCM: J0 = IV || 0x00000001, prvi podatkovni blok je inc32(J0) = IV || 2
  var ctr = iv.concat([0, 0, 0, 2]);
  var plain = aes256Ctr(key, ctr, ct);
  return JSON.parse(utf8Decode(plain));
}

var BYSE_ORIGIN = 'https://bysebuho.com'; // fallback; mirrori koriste svoj origin
var _byseTokens = {};

async function byseCaptchaToken(origin, code) {
  var cached = _byseTokens[origin + code];
  if (cached && cached.exp > Date.now()) return cached.token;

  var chRes = await fetch(origin + '/api/videos/' + encodeURIComponent(code) + '/embed/captcha', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
    redirect: 'follow'
  });
  if (!chRes.ok) return null;
  var ch = await chRes.json();
  if (!ch || !ch.pow_nonce) return null;

  var solution = byseSolvePow(ch.pow_nonce, ch.pow_difficulty);
  if (solution === null) return null;

  var vRes = await fetch(origin + '/api/videos/' + encodeURIComponent(code) + '/embed/captcha/verify', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ pow_token: ch.pow_token, solution: solution }),
    redirect: 'follow'
  });
  if (!vRes.ok) return null;
  var v = await vRes.json();
  if (!v || v.status !== 'ok' || !v.token) return null;

  var ttl = Number(v.expires_in) > 0 ? Number(v.expires_in) * 1000 : 1800000;
  _byseTokens[origin + code] = { token: v.token, exp: Date.now() + Math.min(ttl, 1500000) };
  return v.token;
}

async function resolveBysebuho(embedUrl) {
  // /e/<code> (embed) ili /d/<code> (bysetayico na gledajcrtace.rs)
  var m = str(embedUrl).match(/\/[ed]\/([A-Za-z0-9_-]+)/);
  var code = m ? m[1] : '';
  if (!code) return [];

  var om = str(embedUrl).match(/^https?:\/\/[^\/]+/i);
  var origin = om ? om[0] : BYSE_ORIGIN;
  var token = await byseCaptchaToken(origin, code);
  if (!token) return [];

  var r = await fetch(origin + '/api/videos/' + encodeURIComponent(code) + '/embed/playback', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Captcha-Token': token
    },
    body: JSON.stringify({ fingerprint: {} }),
    redirect: 'follow'
  });
  if (!r.ok) return [];
  var body = await r.json();
  if (!body || !body.playback) return [];

  var cfg = null;
  try {
    cfg = byseDecryptPlayback(body.playback);
  } catch (e) {
    warn('byse decrypt: ' + e.message);
    return [];
  }
  if (!cfg || !cfg.sources) return [];

  var out = [];
  for (var i = 0; i < cfg.sources.length; i++) {
    var s = cfg.sources[i];
    if (!s || typeof s.url !== 'string' || !s.url) continue;
    out.push({
      url: s.url,
      kind: /\.m3u8(\?|$)/i.test(s.url) ? 'hls' : 'mp4',
      server: s.label ? 'Byse ' + s.label : 'Byse',
      quality: s.label || ''
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// dsplayer.site — Plyr stranica sa <video data-src="https://cdn.dsplayer.site/...">
// Cloudflare daje 403 osim ako Referer nije RODITELJ stranica (sve-epizode.net),
// a sam CDN traži Referer = dsplayer embed URL.
// ---------------------------------------------------------------------------

var DSPLAYER_HEADERS = {
  'Sec-Fetch-Dest': 'iframe',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'cross-site',
  'Upgrade-Insecure-Requests': '1'
};

var DSPLAYER_SRC_PATTERNS = [
  /<video[^>]+data-src\s*=\s*["']([^"']+)["']/i,
  /<video[^>]+src\s*=\s*["']([^"']+)["']/i,
  /<source[^>]+src\s*=\s*["']([^"']+)["']/i
];

var DSPLAYER_IFRAME_RE = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/i;
var DSPLAYER_LOOSE_RE = /["'](https?:\/\/[^"'\s]+?\.(?:mp4|m3u8)(?:\?[^"'\s]*)?)["']/i;

function dsplayerOrigin(url) {
  var m = str(url).match(/^https?:\/\/[^/]+/i);
  return m ? m[0] + '/' : null;
}

async function resolveDsplayer(embedUrl, parentReferer) {
  var refs = [];
  var add = function (v) {
    if (v && refs.indexOf(v) === -1) refs.push(v);
  };
  add(dsplayerOrigin(parentReferer));
  add(parentReferer);
  add('https://sve-epizode.net/');
  add(embedUrl);

  var html = null;
  for (var i = 0; i < refs.length; i++) {
    try {
      var res = await httpGet(embedUrl, { referer: refs[i], headers: DSPLAYER_HEADERS });
      if (res.status === 200 && res.text && /data-src|<video|<source|<iframe/i.test(res.text)) {
        html = res.text;
        break;
      }
    } catch (e) {
      /* probaj sledeći */
    }
  }
  if (!html) return [];

  var embedHost = hostOf(embedUrl);
  var pageUrl = embedUrl;

  function asUrl(raw) {
    var u = str(raw).replace(/^\s+|\s+$/g, '').replace(/&amp;/g, '&');
    if (u.indexOf('//') === 0) u = 'https:' + u;
    if (!/^https?:\/\//i.test(u)) u = absUrl(pageUrl, u);
    return u;
  }
  function makeResult(u) {
    return [{
      url: u,
      kind: /\.m3u8(\?|$)/i.test(u) ? 'hls' : 'mp4',
      server: 'DSPlayer',
      headers: { Referer: pageUrl }
    }];
  }

  // /embed2/video.php nosi MP4 direktno; /embed/video.php nosi samo iframe ka
  // /watch.php?v=…, gde je pravi link. Zato se ide do 4 nivoa u dubinu.
  for (var hop = 0; hop < 4; hop++) {
    for (var p = 0; p < DSPLAYER_SRC_PATTERNS.length; p++) {
      var m = html.match(DSPLAYER_SRC_PATTERNS[p]);
      if (!m || !m[1]) continue;
      var u = asUrl(m[1]);
      if (u && /\.(mp4|m3u8)(\?|$)/i.test(u)) return makeResult(u);
    }

    var ifr = html.match(DSPLAYER_IFRAME_RE);
    if (!ifr || !ifr[1]) break;
    var next = asUrl(ifr[1]);
    if (!next || hostOf(next) !== embedHost) break;

    var r2;
    try {
      r2 = await httpGet(next, { referer: pageUrl, headers: DSPLAYER_HEADERS });
    } catch (e) {
      break;
    }
    if (r2.status !== 200 || !r2.text) break;
    html = r2.text;
    pageUrl = next;
  }

  var loose = html.match(DSPLAYER_LOOSE_RE);
  if (loose && loose[1] && !/\.php(\?|$)/i.test(loose[1])) return makeResult(loose[1]);
  return [];
}

/* ok.ru — <div data-options="{…flashvars.metadata…}"> nosi MP4 po kvalitetu i
   ondemandHls. CDN link ima srcIp (IP uređaja — ok) i srcAg=CHROME: bez Chrome
   User-Agenta CDN vraća 400, pa strim nosi UA header. */
var OKRU_QUALITY = { ultra: '2160p', quad: '1440p', full: '1080p', hd: '720p', sd: '480p', low: '360p', lowest: '240p', mobile: '144p' };
var OKRU_ORDER = ['ultra', 'quad', 'full', 'hd', 'sd', 'low', 'lowest', 'mobile'];

async function resolveOkru(embedUrl, html) {
  var page = html;
  if (page === null || page === undefined) {
    var res = await httpGet(embedUrl);
    if (res.status !== 200) return [];
    page = res.text;
  }
  var m = page.match(/data-options\s*=\s*"([^"]+)"/);
  if (!m) return [];
  var md;
  try {
    var opts = JSON.parse(decodeEntities(m[1]));
    md = opts.flashvars && opts.flashvars.metadata;
    if (typeof md === 'string') md = JSON.parse(md);
  } catch (e) {
    return [];
  }
  if (!md) return [];

  var headers = { 'User-Agent': UA, Referer: 'https://ok.ru/' };
  var out = [];
  var videos = md.videos || [];
  for (var o = 0; o < OKRU_ORDER.length && !out.length; o++) {
    for (var i = 0; i < videos.length; i++) {
      if (videos[i] && videos[i].name === OKRU_ORDER[o] && videos[i].url) {
        out.push({ url: videos[i].url, kind: 'mp4', server: 'OK.ru', quality: OKRU_QUALITY[OKRU_ORDER[o]], headers: headers });
        break;
      }
    }
  }
  var hls = md.hlsManifestUrl || md.ondemandHls;
  if (hls) out.push({ url: hls, kind: 'hls', server: 'OK.ru', headers: headers });
  return out;
}

var OKRU_HOSTS = { 'ok.ru': 1, 'www.ok.ru': 1, 'm.ok.ru': 1, 'odnoklassniki.ru': 1 };

var VIDARA_HOSTS = { 'vidara.to': 1, 'gbsagbo.com': 1, 'vidara.cc': 1, 'idgasbhiop.com': 1 };
// bysebuho.com, byse.sx + mirrori (bysevepoin.com, bysejikuar.com, bysetayico.com…) — isti API
var BYSE_HOST_RE = /^byse[a-z]*\.(com|sx)$/;

/* drive.google.com/file/d/<id>/(view|preview) -> direktan download (206 video/mp4, podleže Drive kvoti) */
function resolveGdrive(embedUrl) {
  var m = str(embedUrl).match(/\/file\/d\/([A-Za-z0-9_-]+)/);
  if (!m) return [];
  return [{
    url: 'https://drive.usercontent.google.com/download?id=' + m[1] + '&export=download&confirm=t',
    kind: 'mp4',
    server: 'Google Drive'
  }];
}
var DIRECT_HOSTS = {
  'domaceserije.online': 1,
  'domaceserije.net': 1,
  'sve-epizode.net': 1,
  'sve-epizode.com': 1,
  'exyutube.com': 1,
  'exyuteka.net': 1
};

/** Reši jedan embed URL. `parentReferer` = stranica plejera (sve-epizode.net). */
async function resolveServer(embedUrl, parentReferer) {
  var host = hostOf(embedUrl);

  // dsplayer i byse traže posebne headere / captcha, pa idu pre generičkog skidanja
  if (host === 'dsplayer.site') {
    try {
      var dp = await resolveDsplayer(embedUrl, parentReferer);
      if (dp.length) return dp;
    } catch (e) {
      /* padni na generički put */
    }
  }
  if (host === 'drive.google.com') return resolveGdrive(embedUrl);
  if (BYSE_HOST_RE.test(host)) {
    try {
      var by = await resolveBysebuho(embedUrl);
      if (by.length) return by;
    } catch (e) {
      /* padni na generički put */
    }
  }

  var page = null;
  try {
    page = await httpGet(embedUrl);
    if (page.status !== 200) page = null;
  } catch (e) {
    page = null;
  }
  var html = page ? page.text : null;

  try {
    if (VIDARA_HOSTS[host]) {
      var v = await resolveVidara(embedUrl);
      if (v.length) return v;
    }
    if (host === 'streamtape.com') {
      var st = await resolveStreamtape(embedUrl, html);
      if (st.length) return st;
    }
    if (OKRU_HOSTS[host]) {
      var ok = await resolveOkru(embedUrl, html);
      if (ok.length) return ok;
    }
    if (DIRECT_HOSTS[host]) {
      var d = await resolveDirectSource(embedUrl, html);
      if (d.length) return d;
    }
    // nepoznat host -> VidHide familija, pa generički direktan izvor
    var vh = await resolveVidhide(embedUrl, html);
    if (vh.length) return vh;
    return await resolveDirectSource(embedUrl, html);
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// ULAZNA TAČKA
// ---------------------------------------------------------------------------

function buildStream(r, meta, season, episode, siteLabel) {
  var quality = r.quality || guessQuality(r.url) || '';
  var epTag =
    season !== null && season !== undefined && episode !== null && episode !== undefined
      ? ' S' + pad2(season) + 'E' + pad2(episode)
      : '';

  var stream = {
    title: meta.displayTitle + epTag + ' — ' + r.server + (quality ? ' (' + quality + ')' : ''),
    name: r.server,
    url: r.url,
    quality: quality,
    size: '',
    language: 'sr',
    provider: 'Domaće Serije'
  };
  if (r.headers) stream.headers = r.headers;
  if (r.subtitles && r.subtitles.length) stream.subtitles = r.subtitles;
  return stream;
}

/** Jedan sajt: pretraga -> stranica -> embed -> [{ url, embedUrl, site }]. */
async function findServers(site, meta, candidates, type, se, ep) {
  var tag = site.label + ': ';
  var matched = null;
  var via = '';

  // pretraga sajta (jeftina, literalna)
  for (var i = 0; i < candidates.length && i < 4; i++) {
    var res = await searchSite(site, candidates[i]);
    var list = type === 'series' ? res.series : res.films;
    if (!list.length) continue;
    if (list.length === 1) {
      matched = { slug: list[0], title: site.titleFromSlug(list[0]) };
      via = 'pretraga:' + candidates[i];
      break;
    }
    var hydrated = [];
    for (var h = 0; h < list.length; h++) {
      hydrated.push({
        slug: list[h],
        title: site.titleFromSlug(list[h]),
        year: yearFromSlug(list[h])
      });
    }
    var bm = bestMatch(candidates, hydrated, meta.year);
    if (bm) {
      matched = bm;
      via = 'pretraga:' + candidates[i];
      break;
    }
  }

  // fuzzy protiv keširanog kataloga (rešava varijante pisanja)
  if (!matched) {
    var cat = await getCatalog(site);
    var items = type === 'series' ? cat.series : cat.films;
    if (items.length) {
      var cm = bestMatch(candidates, items, meta.year);
      if (cm) {
        matched = cm;
        via = 'katalog';
      }
    }
  }

  if (!matched) {
    warn(tag + 'nema poklapanja za: ' + candidates.join(' / '));
    return [];
  }
  log(tag + 'poklapano: ' + matched.slug + ' (' + via + ')');

  // stranica -> embed
  var pageUrl;
  if (type === 'series') {
    if (se === null || ep === null) return [];
    pageUrl = siteUrl(site, site.episodeUrl(matched.slug, se, ep));
    try {
      var eps = await listEpisodes(site, matched.slug);
      var found = false;
      for (var e = 0; e < eps.length; e++) {
        if (eps[e].season === se && eps[e].episode === ep) {
          found = true;
          break;
        }
      }
      if (!found && eps.length) {
        warn(tag + 'epizoda S' + pad2(se) + 'E' + pad2(ep) + ' nije na sajtu (' + eps.length + ' ep.)');
        return [];
      }
    } catch (err) {
      /* nastavi sa konstruisanim URL-om */
    }
  } else {
    pageUrl = siteUrl(site, site.filmUrl(matched.slug));
  }

  var embedUrl = await getEmbedUrl(pageUrl);
  if (!embedUrl) {
    warn(tag + 'nema embed iframe-a na ' + pageUrl);
    return [];
  }
  log(tag + 'embed: ' + embedUrl);

  // embed -> lista servera
  var servers = [];
  try {
    var emb = await httpGet(embedUrl, { referer: pageUrl });
    if (emb.status === 200) servers = parseServers(emb.text, embedUrl);
  } catch (err) {
    /* ignore */
  }
  if (!servers.length) warn(tag + 'nema servera u embed stranici');
  for (var s = 0; s < servers.length; s++) {
    servers[s].embedUrl = embedUrl;
    servers[s].site = site.label;
  }
  return servers;
}

async function getStreams(tmdbId, mediaType, season, episode) {
  var started = Date.now();
  var type = mediaType === 'tv' || mediaType === 'series' ? 'series' : 'movie';
  var se = type === 'series' && season !== null && season !== undefined ? Number(season) : null;
  var ep = type === 'series' && episode !== null && episode !== undefined ? Number(episode) : null;

  // 1. TMDB -> naslovi
  var meta = await tmdbMeta(tmdbId, type === 'series' ? 'tv' : 'movie');
  if (!meta) {
    warn('nemam TMDB metapodatke za tmdbId=' + tmdbId);
    return [];
  }
  var candidates = candidateTitles(meta);
  if (!candidates.length) {
    warn('nema kandidata za naslov');
    return [];
  }
  // naslov za prikaz — domaći (originalni) je čitljiviji od engleskog
  meta.displayTitle = meta.original || meta.title || candidates[0];
  log('trazim "' + meta.title + '" (' + meta.year + ') | kandidati: ' + candidates.join(' / '));

  // 2–5. svi sajtovi paralelno -> spojena lista servera (bez duplih URL-ova)
  var perSite = await Promise.all(ACTIVE_SITES.map(function (site) {
    return (site.find || findServers)(site, meta, candidates, type, se, ep).then(null, function () { return []; });
  }));
  var ordered = [];
  var cheap = [];
  var byse = [];
  var seenServer = {};
  for (var p = 0; p < perSite.length; p++) {
    for (var q = 0; q < perSite[p].length; q++) {
      var srv = perSite[p][q];
      if (seenServer[srv.url]) continue;
      seenServer[srv.url] = 1;
      if (DEAD_HOSTS[hostOf(srv.url)] && !INCLUDE_UNRESOLVED) continue;
      ordered.push(srv);
      (BYSE_HOST_RE.test(hostOf(srv.url)) ? byse : cheap).push(srv);
    }
  }
  if (!ordered.length) return [];

  function settle(srv) {
    return resolveServer(srv.url, srv.embedUrl).then(
      function (r) { return { server: srv, resolved: r }; },
      function () { return { server: srv, resolved: [] }; }
    );
  }

  // 6. rezolucija: jeftini serveri paralelno, pa byse jedan po jedan.
  // byse traži sinhroni proof-of-work po videu (token se ne deli među videima),
  // koji blokira sve ostalo dok traje — zato ide posle, sa rokom (BUDGET_MS),
  // redom primarnih sajtova (prvi su u ACTIVE_SITES).
  var done = {};
  var cheapDone = await Promise.all(cheap.map(settle));
  for (var cd = 0; cd < cheapDone.length; cd++) done[cheapDone[cd].server.url] = cheapDone[cd];
  // Druga byse kopija iste epizode je samo rezerva, a košta još jedan PoW
  // (na uređaju sekunde do desetine sekundi) — staje se posle prve uspešne.
  _byseDeadline = started + BUDGET_MS;
  var byseOk = 0;
  for (var b = 0; b < byse.length && byseOk < BYSE_MAX_OK; b++) {
    if (Date.now() > _byseDeadline) {
      warn('budžet istekao, preskačem ' + (byse.length - b) + ' byse server(a)');
      break;
    }
    done[byse[b].url] = await settle(byse[b]);
    if (done[byse[b].url].resolved.length) byseOk++;
  }
  _byseDeadline = 0;

  // rezultati u prvobitnom redu servera (byse je često najbolji kvalitet, pa
  // ne sme da ispadne iza MAX_RESULTS samo zato što je rešavan poslednji)
  var settled = [];
  var servers = [];
  for (var o = 0; o < ordered.length; o++) {
    if (!done[ordered[o].url]) continue;
    settled.push(done[ordered[o].url]);
    servers.push(ordered[o]);
  }

  var streams = [];
  var unresolved = [];
  var seenUrls = {};

  for (var k = 0; k < settled.length; k++) {
    var entry = settled[k];
    if (!entry.resolved.length) {
      unresolved.push(entry.server);
      continue;
    }
    for (var r = 0; r < entry.resolved.length; r++) {
      var rr = entry.resolved[r];
      if (rr.server === 'Streamtape' && !SHOW_STREAMTAPE) continue;
      if (seenUrls[rr.url]) continue;
      seenUrls[rr.url] = 1;
      streams.push(buildStream(rr, meta, se, ep, entry.server.site));
      if (streams.length >= MAX_RESULTS) break;
    }
    if (streams.length >= MAX_RESULTS) break;
  }

  // Nerešivi hostovi se NE vraćaju po defaultu.
  //
  // Nuvio lokalni plugin nema način da otvori spoljašnji link: `PluginRuntime`
  // ne čita polje `type`, a `StreamRepositoryImpl.toPluginStream()` uvek postavlja
  // `externalUrl = null`. `Stream.isExternal()` traži `externalUrl != null && url == null`,
  // pa se ovakav strim predaje plejeru kao običan video URL — a to je HTML stranica,
  // pa plejer samo prijavi grešku. Zato su ovi unosi bili "Browser: …" ali nisu radili.
  if (INCLUDE_UNRESOLVED && streams.length < MAX_RESULTS) {
    for (var u = 0; u < unresolved.length; u++) {
      var host = hostOf(unresolved[u].url);
      warn('nerešiv server: ' + host + ' -> ' + unresolved[u].url);
      streams.push({
        title: meta.displayTitle + ' — ' + host + ' (Nuvio ne može da otvori spoljašnji link)',
        name: 'Browser: ' + host,
        url: unresolved[u].url,
        quality: '',
        size: '',
        language: 'sr',
        provider: 'Domaće Serije',
        type: 'external'
      });
    }
  }

  log(
    streams.length + ' strimova za ' + (Date.now() - started) + 'ms (' +
    servers.length + ' servera, ' + (servers.length - unresolved.length) + ' rešeno)'
  );
  return streams;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  globalThis.getStreams = getStreams;
}
