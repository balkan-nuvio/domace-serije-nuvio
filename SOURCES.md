# Candidate sources — evaluation (2026-10-15)

Probed with curl (desktop Chrome UA, no cookies unless noted). "Catalog" = `data/catalog-online.json` + `data/catalog-net.json`.
Plugin code was not touched.

## Ranking (new content ÷ effort)

| # | Site | New content | Backend | Effort | Verdict |
|---|------|-------------|---------|--------|---------|
| 1 | **gledajcrtace.net** (uCoz; also `gledajcrtace.ucoz.net`) — **added in 1.3.0** via `data/gledajcrtace.json` | **~405 dubbed/subbed cartoon series, ~4 900 episode pages** + 252 cartoon films (≈70 % of films also on exyuteka `crtani/`) | different (per-episode page, direct `<iframe>`) | medium | **Do it** |
| 2 | **Player-host gaps** (no new site) | fixes existing + #1 | — | trivial | **Do it first** |
| 3 | gledajcrtace.rs (Blogger; `gledajcrtace.xyz` redirects here) | 576 posts (cartoons/anime), overlap with #1 not measured | different (Blogger post with button lists) | high | Later, Drive-only value |
| 4 | saprevodom.online (`filmolino.net` redirects here) | 2 000 foreign films + 1 300 foreign series *sa prevodom*; domestic part is a mirror | same `case N: src` | low (films) | Optional, out of "domaće" scope |
| 5 | sve-epizode.net (`sve-epizode.com`, `exyutube.com` → 301 here) | ≈ none | same `case N: src`, **same player IDs** | low | Skip (fallback only) |

## 1. gledajcrtace.net — biggest win

- No Cloudflare. Pages ~160 KB (fine under 1 MB).
- URL shape: `/publ/<kratkometrazni|dugometrazni>_crtani_filmovi/<series_folder>/<episode_slug>/<cat>-1-0-<id>`
  - episode slug: `<name>_sezona_<S>_epizoda_<E>` or absolute `<name>_epizoda_<N>` (Naruto, Yu-Gi-Oh…)
  - series folder often carries both names: `harvi_kljunic_harvey_beaks_sinhronizovano_na_srpski`, `ostrvo_pafina_puffin_rock_…` → English half helps TMDB matching.
  - suffixes mark audio: `_sinhronizovano_na_srpski`, `_na_hrvatski`, `_titlovano`.
  - The trailing `<id>` is not derivable from S/E → need a list, not a URL template.
- Folder listing: `/publ/kratkometrazni_crtani_filmovi/<folder>/<cat>` paginated as `/<cat>-2`, `/<cat>-3`… (~10 eps/page, SpongeBob = 27 pages).
- Sitemap: `/sitemap.xml` → `/sitemap-publ.xml` (5 154 URLs) — **1.16 MB, over the 1 MB fetch cap**.
- Search `/search/?q=` 302s to `&_ck=1` and returns **403 without a cookie jar**; with cookies it returns category links only. Not usable in the sandbox.
- ⇒ Approach: prebuilt index (like the existing `data/catalog-*.json`) generated offline from `sitemap-publ.xml`: `folder → [{s, e, url}]`, shipped/hosted next to the catalogs. Runtime = 1 episode-page fetch + resolver.
- Player hosts (12 random episodes): `bysevepoin.com` / `bysejikuar.com` in all of them, plus `vidara.to`, `vidmoly.org`, `drive.google.com`. `vidmoly.org` embeds are **live** (`sources:[{file:'…/master.m3u8'}]`, HLS) — should fall into the existing VidHide/generic `master.m3u8` scrape; verify Referer.
- Overlap: exyuteka `crtani/` (560 slugs, same underscore slug style → probably scraped from here) is **films only**; none of the gledajcrtace.net series episodes are on exyuteka/domaceserije.

## 2. Player-host gaps (cheap, help existing sites too)

| Host | Seen on | Status | Fix size |
|------|---------|--------|----------|
| `idgasbhiop.com` | **domaceserije.net** `case 1` (same code as `vidara.to/e/GWmUFbpIhIKe`) | vidara alias — `POST /api/stream` verified, returns `streaming_url`. Missing from `VIDARA_HOSTS`, so .net's server 1 currently goes through the generic path | 1 line |
| `bysevepoin.com`, `bysejikuar.com`, `bysetayico.com` | gledajcrtace.net / .rs | byse mirrors: `/api/videos/<code>/embed/captcha` answers identically (PoW difficulty 16). `resolveServer` only routes `bysebuho.com`/`byse.sx` to `resolveBysebuho` | 1 line (e.g. `/^byse[a-z]*\.(com|sx)$/`) |
| `drive.google.com/file/d/<id>/(view\|preview)` | gledajcrtace.net (some), gledajcrtace.rs (2 594 links) | `https://drive.usercontent.google.com/download?id=<id>&export=download&confirm=t` → **206 `video/mp4`**, range OK. Subject to Drive download quota | ~10 lines |
| `vidmoly.org` | gledajcrtace.net | live, packed + plain `sources` → likely already handled by VidHide scrape | verify only |
| `mega.nz` | gledajcrtace.rs (3 196 links) | client-side AES-CTR decrypt, not a playable URL | not feasible |
| `vk.com/video…` | gledajcrtace.rs (43) | not tried | skip |
| `absplayer.xyz/embed/{movie,tv}/<tmdb\|imdb>`, `vidfast.pro`, `vidking.net` | saprevodom.online | public TMDB-keyed aggregators (abyss already known unresolvable); no Serbian subs from the site | skip |
| `player.abyssplayer.com` | sve-epizode, domaceserije | known unresolvable (see README) | — |

## 3. gledajcrtace.rs (Blogger)

- No Cloudflare. JSON feed works: `/feeds/posts/default?alt=json&max-results=N` and search `&q=<term>`; total 576 posts. Feed is heavy (129 entries = 3 MB) → use `max-results` ≤ 20 or `/feeds/posts/summary` + fetch the one post.
- One post = whole series; episodes are `<a class="iframe" href=…><button>1SR</button>` lists per "Plejer" block, no season split → S/E mapping is guesswork.
- Hosts: mega.nz (unplayable) > drive.google.com > bysetayico (byse) > ok.ru > vk. Only Drive/byse/ok.ru usable. Worth it only after #1 and the Drive resolver exist.

## 4. saprevodom.online (filmolino.net)

- No Cloudflare (robots.txt is Cloudflare-managed content signals: disallows AI crawlers incl. ClaudeBot; normal UAs allowed).
- Same operator/backend as domaceserije.net: `/search.php?q=` (with `&type=Film|Serija|Domaća Serija|Domaći Film`), `/domaca-serija/<slug>`, `/domaci/<slug>-ceo-film-online`, `/filmovi/film-<slug>-<year>`, `/serija/<slug>`.
- Sitemaps: `/sitemap.xml` index → `sitemap-film.php` (2 000), `sitemap-serije.php` (1 300), `sitemap-domfilm.php` (1 895), `sitemap-domser.php` (572).
- Domestic vs catalog: series 572 → only `bombaskoljka`, `savrsen-nered` missing; films 1 889 → only `buba-u-uhu-2025`, `slager-2024` missing. Mirror.
- Foreign film embed `/zsrv/filmlink?search=film-<slug>` → `case 1 bysebuho` (some films), `case 21 absplayer`, `case 22 vidfast`. Foreign series embed `/zsrv/tvs/player.php?search=<slug>&s=S&e=E` → JSON `embedUrls` with absplayer/vidfast/vidking only (no own hosting).
- Only bysebuho foreign films are playable; whether they carry Serbian subs (hardsub/track) was **not verified**.

## 5. sve-epizode.net

- No Cloudflare; no sitemaps (`/sitemap*.php|xml` → 404). Images hot-linked from domaceserije.net.
- Series `/?serija=<slug>`, episode `/epizoda/<slug>-sNNeNN`, search `/?q=`, embed `/embed/sro1.php?search=rs-<slug>-sNNeNN`.
- 577 series slugs vs catalog 570: extra = `big-time-rush bombaskoljka gori-vatra k-t-2 necista-krv-2021 nikad-izvini savrsen-nered survior-hr` (mostly variants/typos).
- Embed for `love-island-adria-s01e29` is **byte-identical in IDs** to domaceserije.net's `/zsrv/sro1` (vidara/abyss/dsplayer/morencius/streamtape). Zero new content or hosts.

## 6. balkanteka.net — skip (evaluated 2026-10-15)

- WordPress (Newspaper theme), no Cloudflare, open REST API: `/wp-json/wp/v2/search?search=`, `/wp-json/wp/v2/categories` (series = child category, seasons = grandchild), `/wp-json/wp/v2/posts?categories=<id>` returns `content.rendered` with the player — so search + episode list + player is 2–3 JSON calls.
- 6 153 posts: 6 023 domestic (147 series, nearly all also on domaceserije), 97 Turkish (9 series, 2021–2022), 20 films.
- Episode numbering is inconsistent: `kumovi-sezona-6-epizoda-96`, `krunska-11-epizoda-27-sezona-3`, `divlje-pcele-epizoda-150` (absolute, no season).
- **Players (sample of 600 posts):** ≈ 92 % are a netu/hqq player (`video.lzn-sve-epizode.com/player/hash.php` + obfuscated `script.php`) — not resolvable. Only posts from ~Feb 2026 on carry resolvable iframes: `bysevepoin.com` / `bysekoze.com` (byse mirrors, own uploads, not domaceserije's IDs) and `minochinos.com` (→ `callistanise.com`, VidHide). Turkish series: `hqq.to`, `mega.nz`, other — none resolvable. Older: `d000d.com` (dood), `mega.nz`.
- Newest post is 2026-06-07, so the site looks dormant.
- ⇒ At most a few hundred playable episodes, all of shows domaceserije already has. Only value would be an independent copy of Feb–Jun 2026 episodes.
- **Added anyway as a fallback (plugin 1.2.0):** `SITES.balkanteka.find` — category search → `posts?categories=<id>&search=epizoda <E>` → keep only byse/VidHide iframes. Verified: Kumovi S06E96, Krunska 11 S03E26, Bos ili Hadžija S02E21 each gain one independent copy.

## 7. samodomace.net — added (plugin 1.2.0)

- Custom PHP site, no WP REST, no working search. `/sitemap.xml` (60 KB) = 787 `/stream/<slug>/<id>/` pages — films only (domestic + dubbed cartoons). Each page has one iframe to a byse mirror (`bysezejataos.com`) with its own uploads (`1na1.avi`, `dopunska.nastava.mkv`), i.e. independent copies.

## 8. filmoton.ba — added (plugin 1.2.0)

- WordPress (MasVideos). REST types `tv_show` (1 693), `episode` (25 977), `movie`. Show slug carries the year (`kumovi-2022`, duplicates `igra-sudbine-2020-2`); episode slug drops it: `<show>-s<S>-epizoda-<E>` with 2- or 3-digit E (sometimes both exist → two copies). Player is not in REST `content`; the episode page (~330 KB) has it as `data-lazy-src`.
- Players: newer posts `bysevepoin.com` (resolvable), older `player.filmoland.com/e/<b64>` — **NXDOMAIN** (1.1.1.1 and Quad9), dead.
- Content: domestic plus foreign series/films *sa prevodom*.

## 9. lzn-sve-epizode.com — skip

- WordPress (TorrentPlay-style theme: movies / series / seasons / episodes, ~10 episode sitemaps). Episode iframe `/?trembed=0&trid=<id>&trtype=2` → `video.lzn-sve-epizode.com/e/<b64>`, a **white-label netu/hqq** player (same one balkanteka embeds via `hash.php`). The player page loads **Google reCAPTCHA and hCaptcha** → not resolvable without solving a captcha; not attempted.

## byse proof-of-work cost (observed 2026-10-15/16)

- `/embed/captcha` returned `pow_difficulty` 20 → 21 → 22 over a few dozen test runs from one IP (earlier the same videos solved in seconds) — difficulty is adaptive per IP. Plugin hash rate ≈ 36k h/s in V8, so diff 20 ≈ 26 s; QuickJS is several times slower.
- Plugin now: cheap hosts first, byse sequentially with a 45 s budget, and skips difficulty > 18.

## Dead / out of scope

- domaceserije.com — domain for sale. domaceserije.org, filmovizija.ws — parking redirect JS. balkanflix.com — hijacked (gambling). serijeonline.net, gledalica.com — ad-network redirect.
- balkanje.com — HTTP 454 "Checking your browser…" JS challenge; not evaluated further.
- exyu.tv — paid IPTV. filmoviplex.com, gledajfilmove.net (uCoz sister of gledajcrtace.net) — foreign films with subs, not domestic.
- No DNS / no answer: exyuflix.com, sinhronizovanicrtani.com, crtanifilmovi.net, crtaci.rs, domace-serije.net, domaceserije.{tv,me,xyz,info,club,live,site,cc}, sve-epizode.org, exyuteka.{com,online}, exyutube.net and ~20 other guesses.

## Side note

`domaceserije.net` episode page for `love-island-adria-sezona-1-epizoda-29` is **1.6 MB** — above the 1 MB per-fetch cap. If the sandbox truncates rather than fails, the `<iframe>` (near the top) still survives; worth a check.
