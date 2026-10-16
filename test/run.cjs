/**
 * Test harness — pokreće providers/domaceserije.js u Node-u, sa istim sandbox
 * API-jem koji daje NuvioTV (PluginRuntime.kt).
 *
 *   node nuvio-plugin/test/run.cjs <tmdbId> [movie|tv] [sezona] [epizoda]
 *
 * Primeri:
 *   node nuvio-plugin/test/run.cjs 137901 tv 1 1      (Branilac S01E01)
 *   node nuvio-plugin/test/run.cjs 1191055 movie      (Mačiji krik)
 *   node nuvio-plugin/test/run.cjs 115796 tv 13 3     (Igra sudbine S13E03)
 */

const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

// --- sandbox globals -------------------------------------------------------

globalThis.SCRAPER_ID = 'domaceserije';
// Nuvio 1.0.0 šalje {} — ovako simuliramo podešavanja iz env-a
globalThis.SCRAPER_SETTINGS = {};
if (process.env.DS_SITE) globalThis.SCRAPER_SETTINGS.site = process.env.DS_SITE;
if (process.env.DS_MAX_RESULTS) globalThis.SCRAPER_SETTINGS.maxResults = Number(process.env.DS_MAX_RESULTS);
if (process.env.DS_INCLUDE_UNRESOLVED) {
  globalThis.SCRAPER_SETTINGS.includeUnresolved = process.env.DS_INCLUDE_UNRESOLVED !== '0';
}
// Nuvio daje svoj ključ; za lokalni test postavi TMDB_API_KEY u okruženju
globalThis.TMDB_API_KEY = process.env.TMDB_API_KEY || '';
if (!globalThis.TMDB_API_KEY) {
  console.warn('TMDB_API_KEY nije postavljen — plugin pada na keyless TMDB stranicu (često 403).');
}

if (typeof globalThis.console === 'undefined') globalThis.console = console;
// Node >=18 ima globalni fetch/atob/btoa/URL/URLSearchParams — isto kao sandbox.

// --- pokreni plugin tačno kao NuvioTV --------------------------------------
// PluginRuntime.kt umotava kod u:
//   var module = { exports: {} }; var exports = module.exports; (function(){ … })();
// i izvršava ga u globalnom kontekstu -> vm.runInThisContext, NE require().

const pluginPath = resolve(__dirname, '../providers/domaceserije.js');
const pluginCode = readFileSync(pluginPath, 'utf8');

const wrapped = [
  'var module = { exports: {} };',
  'var exports = module.exports;',
  '(function() {',
  pluginCode,
  '})();',
  'module.exports;',
].join('\n');

const plugin = vm.runInThisContext(wrapped, { filename: 'domaceserije.js' });
const getStreams = plugin.getStreams || globalThis.getStreams;

// --- args ------------------------------------------------------------------

const args = process.argv.slice(2);
const tmdbId = args[0] || '137901';
const mediaArg = args[1] || 'tv';
const mediaType = mediaArg === 'tv' || mediaArg === 'series' || mediaArg === '1' ? 'tv' : 'movie';
const season = args[2] != null ? Number(args[2]) : mediaType === 'tv' ? 1 : null;
const episode = args[3] != null ? Number(args[3]) : mediaType === 'tv' ? 1 : null;

(async () => {
  const started = Date.now();
  console.log(
    `--- getStreams(${tmdbId}, ${mediaType}` +
      (mediaType === 'tv' ? `, ${season}, ${episode}` : '') +
      ') ---'
  );

  if (typeof getStreams !== 'function') {
    console.error('FATAL: getStreams nije izvozovan');
    process.exit(1);
  }

  let streams;
  try {
    streams = await getStreams(tmdbId, mediaType, season, episode);
  } catch (e) {
    console.error('FATAL:', e && e.stack ? e.stack : e);
    process.exit(1);
  }

  console.log(`\nrezultat: ${streams.length} strimova za ${Date.now() - started}ms\n`);
  streams.forEach((s, i) => {
    console.log(`[${i + 1}] ${s.name}${s.quality ? '  (' + s.quality + ')' : ''}`);
    console.log(`    title   : ${s.title}`);
    console.log(`    url     : ${process.env.DS_FULL_URL ? s.url : String(s.url).slice(0, 150)}`);
    if (s.subtitles && s.subtitles.length) {
      console.log(`    titlovi : ${s.subtitles.length}`);
    }
    console.log('');
  });

  if (!streams.length) process.exit(2);
})();
