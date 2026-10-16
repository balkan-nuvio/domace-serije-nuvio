/**
 * Proverava da brzi byseSolvePow daje ISTO rešenje kao referentni
 * byseHash + byseLeadingZeroBits, i meri brzinu.
 *
 *   node nuvio-plugin/test/pow.cjs
 */

const vm = require('node:vm');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const crypto = require('node:crypto');

globalThis.SCRAPER_SETTINGS = { byseMaxDifficulty: 32 };
const code = readFileSync(resolve(__dirname, '../providers/domaceserije.js'), 'utf8');
vm.runInThisContext(
  'var module = { exports: {} };(function(){' + code +
  ';globalThis.__pow = { solve: byseSolvePow, hash: byseHash, lz: byseLeadingZeroBits, ascii: byseAscii };})()'
);
const { solve, hash, lz, ascii } = globalThis.__pow;

function reference(nonce, diff) {
  for (let s = 0; ; s++) if (lz(hash(ascii(nonce + ':' + s))) >= diff) return String(s);
}

let checked = 0;
for (const diff of [1, 4, 8, 10, 12]) {
  for (let k = 0; k < 60; k++) {
    const nonce = crypto.randomBytes(16).toString('hex');
    assert.strictEqual(solve(nonce, diff), reference(nonce, diff), `nonce ${nonce} diff ${diff}`);
    checked++;
  }
}
console.log(`ok: ${checked} rešenja identična referentnom hešu`);

const N = 50000;
const nonce = crypto.randomBytes(16).toString('hex');
let t = Date.now();
for (let s = 0; s < N; s++) lz(hash(ascii(nonce + ':' + s)));
const slow = N / ((Date.now() - t) / 1000);
t = Date.now();
solve(nonce, 32, N); // 32 bita praktično nikad ne uspe -> tačno N pokušaja
const fast = N / ((Date.now() - t) / 1000);
console.log(`referentni ${(slow | 0)} h/s, brzi ${(fast | 0)} h/s, ${(fast / slow).toFixed(1)}x`);
