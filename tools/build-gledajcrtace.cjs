/**
 * Gradi data/gledajcrtace.json — indeks epizoda i filmova sa gledajcrtace.net.
 *
 *   node tools/build-gledajcrtace.cjs
 *
 * Zašto indeks: sajt nema upotrebljivu pretragu u sandboxu (403 bez cookie-ja),
 * a sitemap-publ.xml (~1,2 MB) je veći od Nuvio limita od 1 MB po fetch-u.
 * Plugin zato čita ovaj mali JSON sa GitHub Pages-a.
 *
 * Format:
 *   series: { "<folder>": [[sezona, epizoda, cat, id], ...] }
 *   films:  [["<slug>", cat, id], ...]
 * Stranica je https://www.gledajcrtace.net/publ/<cat>-1-0-<id> (sajt preusmeri).
 */

const { writeFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');

const SITEMAP = 'https://www.gledajcrtace.net/sitemap-publ.xml';
const OUT = resolve(__dirname, '../data/gledajcrtace.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// "<ime>_sezona_3_epizoda_10_11" | "<ime>_epizoda_150" (apsolutno -> sezona 1)
// (i "_epizode_86_87", "_epizoda_100_kraj")
function parseEpisode(slug) {
  slug = slug.replace(/_kraj$/, '');
  let m = slug.match(/_sezona_(\d+)_epizod[ae]_?(\d+)(?:_(\d+))?$/);
  if (m) return { s: +m[1], e: +m[2], e2: m[3] ? +m[3] : null };
  m = slug.match(/_epizod[ae]_?(\d+)(?:_(\d+))?$/);
  if (m) return { s: 1, e: +m[1], e2: m[2] ? +m[2] : null };
  return null;
}

async function main() {
  const res = await fetch(SITEMAP, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('sitemap HTTP ' + res.status);
  const xml = await res.text();

  const series = {};
  const films = [];
  const skipped = [];
  const re = /<loc>[^<]*\/publ\/([^<]+)<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const parts = m[1].split('/');
    const ids = parts[parts.length - 1].match(/^(\d+)-1-0-(\d+)$/);
    if (!ids) continue; // stranica kategorije (folder), ne epizoda
    const cat = +ids[1];
    const id = +ids[2];
    if (parts[0] === 'dugometrazni_crtani_filmovi' && parts.length === 3) {
      films.push([parts[1], cat, id]);
    } else if (parts[0] === 'kratkometrazni_crtani_filmovi' && parts.length === 4) {
      const ep = parseEpisode(parts[2]);
      if (!ep) { skipped.push(parts[2]); continue; }
      const list = (series[parts[1]] = series[parts[1]] || []);
      list.push([ep.s, ep.e, cat, id]);
      // dvodelna epizoda "_10_11" važi i za 11
      if (ep.e2 && ep.e2 === ep.e + 1) list.push([ep.s, ep.e2, cat, id]);
    }
  }

  const eps = Object.values(series).reduce((n, l) => n + l.length, 0);
  if (eps < 1000 || films.length < 50) {
    throw new Error(`premalo podataka (${eps} epizoda, ${films.length} filmova) — sitemap promenjen?`);
  }

  mkdirSync(resolve(OUT, '..'), { recursive: true });
  // "built" u svom redu: workflow ga ignoriše (git diff -I) pri odluci o commit-u
  const json = '{"built":' + JSON.stringify(new Date().toISOString()) + ',\n' +
    '"series":' + JSON.stringify(series) + ',\n' +
    '"films":' + JSON.stringify(films) + '}';
  JSON.parse(json);
  writeFileSync(OUT, json + '\n');
  console.log(`${Object.keys(series).length} serija, ${eps} epizoda, ${films.length} filmova, ` +
    `${skipped.length} preskočeno, ${(json.length / 1024).toFixed(0)} KB -> ${OUT}`);
  if (skipped.length) console.log('preskočeno (primer):', skipped.slice(0, 8).join(', '));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
