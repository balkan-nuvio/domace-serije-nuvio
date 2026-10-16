# Domaće Serije — Nuvio plugin (lokalni, QuickJS sandbox)

Lokalni Nuvio plugin koji povlači strimove sa **domaceserije.online** /
**domaceserije.net** i **exyuteka.net**. Ceo lanac (TMDB → pretraga sajta →
embed → rezolucija plejera) izvršava se **na uređaju korisnika**. Nema servera,
nema naloga, nema kredencijala.

### Više sajtova

Sajtovi se pretražuju **paralelno**, liste servera se spajaju i dupli se
izbacuju. Svi rade na istom back-endu (`case N: src`), pa sajt dodaje samo
raspored URL-ova u `SITES`.

| Sajt | Šta donosi |
|---|---|
| `domaceserije.online` / `.net` (`SITE_KEY`) | domaće serije i filmovi |
| `exyuteka.net` (uključen, `exyuteka: false` ga gasi) | isti domaći katalog (rezerva kad domaceserije nema servere — npr. *Južni vetar*), plus **sinhronizovani crtani** (`crtani/`) i **latino serije** (`gledaj-online/`, ok.ru) |
| `balkanteka.net` (uključen, `balkanteka: false` ga gasi) | samo serije; **nezavisne kopije** epizoda (uglavnom 2026) kad imaju razrešiv plejer (byse mirrori, minochinos). WordPress REST API umesto `case N: src` — svoj `find` u `SITES`. ~92 % postova je netu/hqq i preskače se. Naslov bez „Sezona“ = S01 (apsolutno numerisane serije se poklope samo za S01) |
| `samodomace.net` (`samodomace: false`) | samo filmovi (787, domaći + sinhronizovani crtani), sopstveni byse upload-i; fuzzy po `sitemap.xml` (bez godine u URL-u) |
| `filmoton.ba` (`filmoton: false`) | ~1.700 serija / 26.000 epizoda + filmovi, domaće i **strane sa prevodom**; WP REST (`tv_show`, `episode?slug=…`, `movie`). Novije epizode na byse mirrorima, starije na `player.filmoland.com` (domen ne postoji — preskače se) |

| `gledajcrtace.net` (`gledajcrtace: false`) | **crtane serije** (153, ~4.700 epizoda, sinhronizovane i titlovane) i 251 crtani film. Sajt nema upotrebljivu pretragu, pa plugin čita indeks `data/gledajcrtace.json` sa GitHub Pages-a (`tools/build-gledajcrtace.cjs`, osvežava ga workflow ponedeljkom). Apsolutno numerisane serije (Naruto) = S01 |

Lokalni naslov se traži i u TMDB **prevodima** (sr/hr/bs, ćirilica → latinica):
„Avatar: The Last Airbender“ → „Avatar: Poslednji vladar vetrova“. Isti naslov sa
godinom koja se razlikuje za više od 1 se ne uparuje (animirani Avatar 2005 ≠ igrani 2024).

Netu/hqq (`video.lzn-sve-epizode.com`, `hqq.to`) se **ne rešava**: stranica
plejera učitava Google reCAPTCHA i hCaptcha, a zaobilaženje captche nije opcija.

> Ovo je alternativa self-hosted Stremio addonu iz korena projekta. Prednost:
> ne treba ti hosting ni HTTPS. Mane: Nuvio plugin sistem postoji **samo u
> sideloaded "full" buildu** (ne u Play Store verziji) i podržava **samo
> strimove** (nema kataloga ni metapodataka).

---

## Zašto plugin a ne addon

| | Addon (koren projekta) | Plugin (ovaj folder) |
|---|---|---|
| Gde se izvršava | na tvom serveru | **na uređaju** |
| Hosting | treba HTTPS (tunel / VPS / Caddy) | **ne treba** — statični fajlovi |
| Instalacija | URL manifesta | repo manifest |
| Opseg | katalog, meta, strimovi | samo strimovi |
| Traži `npm install` | da | ne |

Plugin traži **TMDB id** (ne IMDb) i **TMDB API ključ** — Nuvio ga sam
prosleđuje kroz `globalThis.TMDB_API_KEY` (dolazi iz `BuildConfig.TMDB_API_KEY`,
tj. iz `local.properties` u build-u). Bez njega plugin ne može da dobije naslov.

---

## Struktura

```
nuvio-plugin/
  manifest.json                    repo manifest (Nuvio format)
  providers/domaceserije.js        ceo plugin (jedan fajl)
  test/run.cjs                     pokreće plugin u Node-u, isti sandbox kao aplikacija
  serve.cjs                        statički server za LAN
```

---

## Testiranje bez uređaja

```bash
# serija (TMDB id, sezona, epizoda)
node nuvio-plugin/test/run.cjs 137901 tv 1 1      # Branilac S01E01
node nuvio-plugin/test/run.cjs 115796 tv 13 3     # Igra sudbine S13E03

# film (TMDB id)
node nuvio-plugin/test/run.cjs 1191055 movie      # Mačiji krik (2024)

# drugi domen / spisak nerešivih hostova (podrazumevano isključeno)
DS_SITE=net node nuvio-plugin/test/run.cjs 137901 tv 1 1
DS_INCLUDE_UNRESOLVED=1 node nuvio-plugin/test/run.cjs 137901 tv 1 1
```

Harness izvršava plugin **tačno kao aplikacija** (`PluginRuntime.kt`):

```js
var module = { exports: {} };
var exports = module.exports;
(function() { <kod plugina> })();
```

kroz `vm.runInThisContext`, uz `TMDB_API_KEY` i `SCRAPER_SETTINGS`.
Ne koristiti `require()` na plugin fajl.

---

## Instalacija na uređaju

U Nuvio: **Settings → Content & Discovery → Plugins → Add Repository**, nalepi

```
https://balkan-nuvio.github.io/domace-serije-nuvio/manifest.json
```

pa uključi provider **Domaće Serije**. Stranica sa uputstvom:
<https://balkan-nuvio.github.io/domace-serije-nuvio/>

### Lokalno (LAN), za razvoj

```bash
node nuvio-plugin/serve.cjs --check      # samo ispiši koju adresu koristiti
node nuvio-plugin/serve.cjs 8098         # pokreni server
node nuvio-plugin/serve.cjs 8098 --bind 192.168.1.3   # bind na tačan interfejs
```

U Nuvio: **Settings → Content & Discovery → Plugins → Add Repository**, nalepi
`http://<LAN-IP>:8098/manifest.json`, pa uključi provider **Domaće Serije**.

### Adresa se bira pametno (i to je bitno)

Windows mašine često imaju **VirtualBox / VMware / Hyper-V / WSL virtuelne adaptere**
sa adresama tipa `192.168.56.1`, `192.168.89.1`, `192.168.122.1` i **bez gateway-a**.
Naivno „uzmi prvu ne-internu IPv4" skoro uvek pogodi pogrešan adapter — server se
pokrene, ali telefon/TV ga ne vidi.

`serve.cjs` zato:

1. pita OS kojim interfejsom mašina **stvarno izlazi napolje** (UDP `connect` na
   `8.8.8.8` — ne šalje pakete, samo bira rutu, radi i bez interneta);
2. tu adresu stavlja prvu i označava je sa `<-- KORISTI OVU`;
3. sve virtuelne adaptere (po imenu i po poznatim opsezima) označava kao
   `(virtuelni adapter)` da se ne zbuniš;
4. `--check` ispisuje i status Windows Firewall pravila za `node.exe`.

Server se bind-uje na `0.0.0.0` (svi interfejsi), pa radi bez obzira na izbor —
pogrešna je bila samo **ispisana** adresa. Ako i dalje ne radi, forsiraj interfejs
sa `--bind <IP>`.

Ako se uređaj ne povezuje ni tada: dozvoli Node.js kroz Windows Firewall (Private
mreža) i proveri da su uređaj i PC na istoj mreži.

Pošto je plugin potpuno statičan (bez kredencijala), može i na bilo koji
besplatni static host — npr. `raw.githubusercontent.com` ili GitHub Pages.
Tada `serve.cjs` ne treba uopšte. Dovoljna su dva fajla:

```
manifest.json
providers/domaceserije.js
```

---

## Kako plugin radi

```
getStreams(tmdbId, mediaType, season, episode)
  │
  ├─ TMDB API: tmdbId -> name, original_name, godina, imdb_id, alternative_titles
  │            (bez ključa -> rezervno: keyless themoviedb.org/<tv|movie>/<id>/titles)
  ├─ kandidati: originalni naslov → regionalni alternativni → TMDB primarni
  ├─ pretraga sajta: /search.php?q=... (literalna) → serija/<slug> | film/<slug>
  ├─ ako pretraga ne nađe: fuzzy protiv kataloga iz sitemapa (keširan u memoriji)
  ├─ serija: /serija/<slug> -> lista /epizoda/<slug>-sXXeYY -> tačna sezona/epizoda
  │  film:   /film/<slug>
  ├─ stranica -> <iframe> -> /embed/sro1?search=rs-… | /embed-film/srofilm?search=glo-…
  ├─ embed -> lista servera (`case N: src = "…"`)
  └─ return [{ title, name, url, quality, language, provider, subtitles? }]
```

### Rezolveri (provereno rade)

| Host | Metoda | Rezultat |
|---|---|---|
| `domaceserije.*` sopstveni plejer (`sve_epsplayer.php`) | `<source src>` | **720p direktan MP4** |
| `sve-epizode.net/exyuvid/tvs.php` | `const SRC = '…'` | direktan MP4 |
| `streamtape.com` | deobfuskacija inline JS-a | direktan MP4 |
| `bysebuho.com` | **proof-of-work captcha + AES-256-GCM** | **720p/1080p HLS** |
| `dsplayer.site` | Plyr `<video data-src>` (iframe headeri + Referer) | **direktan MP4** |
| `vidara.to` | `POST /api/stream` | HLS `master.m3u8` (+ titlovi) |
| `morencius.com` / VidHide familija | Dean Edwards unpacker | HLS `master.m3u8` |
| `vidmoly.biz` | unpacker / `<source>` | HLS |
| `dingtezuni.com` (→ `callistanise.com`) | VidHide unpacker | HLS `master.m3u8` |
| `ok.ru` | `data-options` → `flashvars.metadata` | MP4 (najbolji kvalitet) + HLS; CDN traži **Chrome User-Agent** (`srcAg=CHROME`), pa strim nosi `headers` |

Nerešivi hostovi: `player.abyssplayer.com` (abyss.to — CDN nije običan MP4),
`ds.rpmhub.site` (`/api/v1/video` vraća „Video not found or deleted" za id-jeve koje
sajt navodi), `vidmoly.biz` (embed id je 404 na svim mirrorima).

### Zašto „Browser: …" unosi NE RADE (i zašto ih sada nema)

Ranije je plugin vraćao nerešive servere kao `type: 'external'`. **Nuvio to ignoriše:**

- `PluginRuntime.parseJsonResults()` čita `url`, ali `LocalScraperResult` **nema**
  polje `externalUrl`, a polje `type` se u `Stream` uopšte ne prenosi;
- `StreamRepositoryImpl.toPluginStream()` uvek postavlja `externalUrl = null`;
- `Stream.isExternal()` je `externalUrl != null && url == null` → uvek `false`.

Zato je takav strim završavao u plejeru kao običan video URL — a to je HTML stranica,
pa je plejer samo prijavio grešku. **Lokalni Nuvio plugin ne može da otvori spoljašnji
link**, pa se ti unosi više ne prikazuju. Ako ti treba samo spisak hostova:
`DS_INCLUDE_UNRESOLVED=1` (u kodu `INCLUDE_UNRESOLVED = true`).


---

## Ograničenja sandboxa (dokumentovano da se ne ponovi)

Provereno u `NuvioTV/app/src/full/.../PluginRuntime.kt`:

1. **Ukupan timeout plugina je 60 s**; pojedinačan `fetch` odgovor **max 1 MB**.
   Zato se katalog iz sitemapa gradi lenjo — samo ako literalna pretraga ne nađe
   ništa — i kešira u memoriji (sandbox nema fajl sistem).
2. **`URL`/`URLSearchParams` su ručni polifili**, ne pravi. `new URL(x, base)` ne
   rešava `../` kako treba, pa plugin koristi svoju `absUrl()`.
3. **Nema `eval`** — Dean Edwards unpacker je implementiran statički
   (parser + `replace`), bez izvršavanja koda.
4. **Nema `setTimeout`/`TextDecoder`** — ne koristiti ih.
5. `URLSearchParams.prototype.append` u polifilu **postavlja**, ne dodaje.
6. Plugin dobija **TMDB id**, ne IMDb — i `mediaType` je `'tv'` ili `'movie'`.
7. `LocalScraperResult.url` je **obavezan**; strimovi bez `url` se tiho odbacuju.
8. Direktni URL strimovi **rade bez patcha** — `docs/nuvio-plugin-sources.patch`
   je potreban samo za torrent `sources`/`fileIdx`.
9. Plugin se piše u **ES5 stilu** (`var`/`function`, bez `?.`, `??`, template
   literala) da prođe i kroz QuickJS i kroz Hermes bez transpajlovanja.
10. Tokeni za `vidara`/`streamtape` su vezani za **IP koji traži**. Pošto plugin
    radi na uređaju, to je isti IP kao plejer — zato ovde nema problema koji
    self-hosted addon ima na udaljenom VPS-u.
11. **Nema `crypto.subtle`**, a CryptoJS u sandboxu nema GCM. Zato je za
    `bysebuho` AES-256-CTR implementiran ručno u fajlu (`aes256Ctr`), a
    proof-of-work hash (`byseHash`) je port plejerovog `gr()`. GCM tag se ne
    proverava — potreban je samo keystream, a serveru se veruje. Implementacija
    je verifikovana bajt-po-bajt protiv `node:crypto` (`_probe/aes_ctr_es5.js`).
12. PoW je **sinhron** i blokira event loop. Token važi **po videu** (`origin +
    code`), pa svaka byse kopija traži svoj PoW; kešira se 25 min. Težina je
    **adaptivna po IP-u**: ~16 bita (≈2 s u Node-u) normalno, a posle mnogo
    zahteva sa iste IP raste na 20–22 (≈25 s+ u Node-u, QuickJS višestruko
    sporije; brzina heša ≈36k/s u V8). Zato:
    - jeftini serveri se rešavaju prvi (paralelno), byse posle, jedan po jedan;
    - byse PoW se prekida posle `BUDGET_MS` (45 s od početka `getStreams`) —
      bez toga ceo plugin probije limit od 60 s i Nuvio ne prikaže **ništa**;
    - težina iznad `BYSE_MAX_DIFFICULTY` (18) se ne pokušava uopšte;
    - byse kopije se rešavaju redom dok traje rok (`BYSE_MAX_OK`, podrazumevano sve);
      svaki strim u imenu nosi sajt sa kog je došao (`Byse 720p · filmoton.ba`);
      isti link sa dva sajta (isti fajl) prikazuje se jednom;
    - byse master playlist se proverava pre vraćanja — CDN ponekad obriše fajl, a API ga i dalje navodi;
    - vrući krug PoW-a je ručno razvijen (bez poziva funkcija i alokacija po
      pokušaju): ~5× brže u V8, isto rešenje kao referentni `byseHash` —
      proverava `node test/pow.cjs`.
    Poznati nerešivi hostovi (`ds.rpmhub.site`, `player.abyssplayer.com`,
    `player.filmoland.com`) se ne otvaraju uopšte.
13. Strimovi koji traže `Referer` (`dsplayer`) vraćaju `headers` — Nuvio to mapira
    u `behaviorHints.proxyHeaders.request`.

---

## Poznato

- Filmovi imaju tanju listu servera od serija (najčešće samo Streamtape).
- Neke epizode na sajtu **stvarno nemaju** nijedan izvor (npr. `Igra sudbine
  S01E01`) — plugin tada vraća prazno, što je ispravno ponašanje.
- Sajt rotira listu servera po epizodi, pa se broj strimova razlikuje od
  epizode do epizode.
