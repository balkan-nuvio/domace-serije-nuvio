/**
 * Statički server za Nuvio plugin repo.
 *
 * Za razliku od CrnaBerza plugina, ovaj plugin NE koristi nikakve kredencijale
 * (sajt je otvoren, bez registracije), pa je server čisto statičan — fajlovi se
 * serviraju kako stoje na disku.
 *
 * Pokretanje:
 *   node nuvio-plugin/serve.cjs [port]                 # bind na sve interfejse
 *   node nuvio-plugin/serve.cjs 8098 --bind 192.168.1.3
 *   node nuvio-plugin/serve.cjs --check                # samo ispiši adrese i izađi
 *
 * U Nuvio: Settings → Content & Discovery → Plugins → Add Repository
 *   http://<LAN-IP>:<port>/manifest.json
 *
 * Pošto je plugin potpuno statičan, može i na bilo koji besplatni static host
 * (GitHub raw / Pages). Tada ovaj server ne treba uopšte.
 */

const http = require('node:http');
const dgram = require('node:dgram');
const { execSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const { join, normalize } = require('node:path');
const { networkInterfaces } = require('node:os');

const ROOT = __dirname;

/* ------------------------------------------------------------------ *
 * Izbor mrežne adrese
 *
 * Windows mašine često imaju VirtualBox / VMware / Hyper-V / WSL virtuelne
 * adaptere sa 192.168.x.1 adresama i BEZ gateway-a. Ako se uzme „prva
 * ne-interna IPv4", skoro uvek se pogodi pogrešan adapter (npr. VirtualBox
 * Host-Only 192.168.56.1) i telefon/TV ne može da dođe do servera.
 * ------------------------------------------------------------------ */

// virtuelni adapteri po imenu interfejsa
const VIRTUAL_NAME_RE =
  /(virtualbox|vmware|hyper-?v|vethernet|wsl|loopback|npcap|winpcap|tap-?windows|openvpn|wireguard|zerotier|tailscale|hamachi|docker|vbox)/i;

// poznati virtuelni opsezi (VirtualBox Host-Only, VMware Host-Only/NAT)
const VIRTUAL_RANGE_RE = [/^192\.168\.56\./, /^192\.168\.89\./, /^192\.168\.122\./];

function isVirtual(name, address) {
  if (VIRTUAL_NAME_RE.test(name || '')) return true;
  for (let i = 0; i < VIRTUAL_RANGE_RE.length; i++) {
    if (VIRTUAL_RANGE_RE[i].test(address)) return true;
  }
  return false;
}

/**
 * Adresa interfejsa kojim mašina stvarno izlazi napolje — najpouzdaniji način
 * da se pogodi pravi LAN adapter. UDP `connect` ne šalje pakete, samo bira
 * rutu, pa radi i bez interneta.
 */
function primaryOutboundAddress() {
  return new Promise((resolve) => {
    let done = false;
    let sock = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        if (sock) sock.close();
      } catch (e) {
        /* ignore */
      }
      resolve(v);
    };
    sock = dgram.createSocket('udp4');
    sock.on('error', () => finish(null));
    try {
      sock.connect(53, '8.8.8.8', () => {
        try {
          finish(sock.address().address);
        } catch (e) {
          finish(null);
        }
      });
    } catch (e) {
      finish(null);
      return;
    }
    setTimeout(() => finish(null), 1500);
  });
}

function listIpv4() {
  const out = [];
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      const fam = typeof n.family === 'string' ? n.family : 'IPv' + n.family;
      if (fam !== 'IPv4' || n.internal) continue;
      out.push({
        name,
        address: n.address,
        virtual: isVirtual(name, n.address),
      });
    }
  }
  return out;
}

/** Vrati listu kandidata, najverovatniji pravi LAN prvi. */
async function candidates() {
  const all = listIpv4();
  const primary = await primaryOutboundAddress();

  const score = (a) => {
    if (primary && a.address === primary) return 0; // pobednik
    if (!a.virtual) return 1;
    return 2;
  };
  all.sort((a, b) => score(a) - score(b) || a.address.localeCompare(b.address));
  return { list: all, primary };
}

/**
 * Windows Firewall: postoje li uključena inbound pravila za node.exe.
 * Ako ih nema, telefon/TV ne može da dođe do servera iako je IP tačan.
 */
function firewallStatus() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execSync('netsh advfirewall firewall show rule name=all dir=in', {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const blocks = out.split(/\r?\n\r?\n/);
    let allow = 0;
    let block = 0;
    for (const b of blocks) {
      if (!/node\.exe/i.test(b)) continue;
      if (!/Enabled:\s*Yes/i.test(b)) continue;
      if (/Action:\s*Allow/i.test(b)) allow++;
      else if (/Action:\s*Block/i.test(b)) block++;
    }
    return { allow, block };
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Argumenti
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const out = { port: null, bind: '0.0.0.0', check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check' || a === '-c') out.check = true;
    else if (a === '--bind') out.bind = argv[++i] || out.bind;
    else if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (/^\d+$/.test(a)) out.port = Number(a);
  }
  out.port = out.port || Number(process.env.PLUGIN_PORT) || 8098;
  return out;
}

const args = parseArgs(process.argv.slice(2));

/* ------------------------------------------------------------------ *
 * Statički fajlovi
 * ------------------------------------------------------------------ */

const TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') {
    res.writeHead(302, { Location: '/manifest.json' });
    res.end();
    return;
  }

  const rel = normalize(urlPath).replace(/^([/\\])+/, '');
  const file = join(ROOT, rel);

  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!existsSync(file)) {
    console.log(`  404 ${urlPath}`);
    res.writeHead(404).end('not found');
    return;
  }

  const body = readFileSync(file);
  const ext = file.slice(file.lastIndexOf('.'));
  res.writeHead(200, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
  console.log(`  200 ${urlPath}`);
});

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

async function printAddresses(port) {
  const { list, primary } = await candidates();
  if (!list.length) {
    console.log('  Nema ne-internih IPv4 adresa — proveri mrežu.');
    return null;
  }

  const best = list[0];
  console.log('  Adrese na kojima server sluša:');
  for (const a of list) {
    const tag = a === best ? '  <-- KORISTI OVU' : a.virtual ? '  (virtuelni adapter)' : '';
    console.log(`    http://${a.address}:${port}/manifest.json${tag}`);
    console.log(`        ${a.name}`);
  }
  if (primary) console.log(`\n  Primarni izlazni interfejs: ${primary}`);
  return best;
}

async function main() {
  if (args.check) {
    console.log('');
    console.log('  Domaće Serije — Nuvio plugin repo (provera adresa)');
    console.log('  ------------------------------------------');
    const best = await printAddresses(args.port);
    const fw = firewallStatus();
    if (fw) {
      console.log('');
      if (fw.allow > 0 && fw.block === 0) {
        console.log(`  Windows Firewall: OK (${fw.allow} uključenih inbound pravila za node.exe)`);
      } else if (fw.block > 0) {
        console.log(`  Windows Firewall: POZOR — postoji ${fw.block} BLOCK pravilo za node.exe`);
      } else {
        console.log('  Windows Firewall: nema inbound pravila za node.exe.');
        console.log('    Prvi `serve.cjs` obično iskoči sa dijalogom — dozvoli "Private networks".');
      }
    }
    if (best) {
      console.log('');
      console.log(`  Manifest za Nuvio: http://${best.address}:${args.port}/manifest.json`);
    }
    console.log('');
    return;
  }

  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.error(
        `\n  Port ${args.port} je zauzet. Probaj: node nuvio-plugin/serve.cjs ${args.port + 1}\n`
      );
    } else {
      console.error('\n  Greška servera:', e && e.message ? e.message : e, '\n');
    }
    process.exit(1);
  });

  server.listen(args.port, args.bind, async () => {
    console.log('');
    console.log('  Domaće Serije — Nuvio plugin repo');
    console.log('  ------------------------------------------');
    const best = await printAddresses(args.port);
    console.log('');
    if (best) {
      console.log('  U Nuvio: Settings > Content & Discovery > Plugins > Add Repository');
      console.log(`           http://${best.address}:${args.port}/manifest.json`);
    }
    console.log('');
    console.log('  Ako se telefon/TV ne povezuje:');
    console.log('    - dozvoli Node.js kroz Windows Firewall (Private mreža)');
    console.log('    - proveri da su uređaj i PC na istoj mreži');
    console.log('    - ručno izaberi interfejs:  --bind <IP>');
    console.log('');
  });
}

process.on('SIGINT', () => server.close(() => process.exit(0)));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
