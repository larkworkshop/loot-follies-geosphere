// Makes FAKE snapshots so you can test the globe, filters and checkboxes with no blockchain at all.
//
//   npm run sample          makes three files, each with the same number of invented tokens per contract:
//                             data/snapshot.sample-5788.json   (5,788 per contract, 11,576 in all)
//                             data/snapshot.sample-3571.json   (3,571 per contract,  7,142 in all)
//                             data/snapshot.sample-2207.json   (2,207 per contract,  4,414 in all)
//   node scripts/make-sample-snapshot.mjs 1000 4000    makes your own sizes (one file per number)
//
// View one locally with, for example:
//   http://127.0.0.1:5500/index.html?snapshot=data/snapshot.sample-2207.json
// The page shows a "TEST DATA" note while one is loaded, and clicking a dot shows no artwork.
// These files are listed in .gitignore and are removed from the Amplify build, so they never go live.
// The smaller files hold the same first tokens as the bigger ones, so you are looking at the same
// places with fewer of them.
import fs from 'node:fs';
import path from 'node:path';
import { getAddress } from 'ethers';

const CONFIG_PATH = process.env.CONFIG || 'config.json';
const OUT_DIR = process.env.OUT_DIR || 'data';
const SIZES = (process.argv.length > 2 ? process.argv.slice(2) : ['5788', '3571', '2207'])
  .map(x => parseInt(x, 10));
if (SIZES.some(n => !Number.isInteger(n) || n < 1 || n > 100000)) {
  console.error('Give whole numbers between 1 and 100000, for example: node scripts/make-sample-snapshot.mjs 2207 3571');
  process.exit(1);
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const pad = (n) => String(n).padStart(2, '0');
const gauss = (rnd) => (rnd() + rnd() + rnd() + rnd() - 2) / 0.58;   // roughly bell-shaped, about -3.4..3.4

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const list = (config.collections || []).filter(c => c && c.address);
if (!list.length) { console.error(`No collections in ${CONFIG_PATH}.`); process.exit(1); }

function build(PER_CONTRACT) {
  return list.map((cfg, ci) => {
  const rnd = mulberry32(20261107 + ci * 7919);

  // About 900 invented wallets; a few hold many tokens, most hold a few.
  const owners = Array.from({ length: 900 }, () => '0x' + Array.from({ length: 40 }, () => '0123456789abcdef'[(rnd() * 16) | 0]).join(''));
  const pickOwner = () => Math.min(owners.length - 1, Math.floor(owners.length * Math.pow(rnd(), 2.4)));

  // Some clustering so dense and sparse regions both show up.
  const centers = [0, 1, 2].map(() => rnd() * 86400);

  const tokens = [];
  for (let id = 1; id <= PER_CONTRACT; id++) {
    let secs = rnd() < 0.3 ? centers[(rnd() * centers.length) | 0] + gauss(rnd) * 5400 : rnd() * 86400;
    secs = ((Math.round(secs) % 86400) + 86400) % 86400;
    const ra = `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;
    const dec = Math.floor(rnd() * 63) * (rnd() < 0.5 ? 1 : -1);                 // the real contract uses uniform whole degrees from 0 to 62 in each hemisphere (seed % 63 for the size, seed % 4 for the sign)
    const order = rnd() < 0.6 ? -1 : Math.floor(rnd() * 16);                      // -1 = Unordered
    const use = Math.floor(rnd() * 24);
    tokens.push([id, pickOwner(), ra, dec, order, use, `Test place ${id}`]);
  }
  return {
    address: getAddress(cfg.address), name: cfg.name || '', symbol: 'TEST', chainId: Number(config.chainId || 1),
    lastBlock: 0, skipped: 0, skippedIds: [], owners, tokens,
  };
  });
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const n of [...new Set(SIZES)]) {
  const collections = build(n);
  const file = path.join(OUT_DIR, `snapshot.sample-${n}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, sample: true, generatedAt: new Date().toISOString(), collections }));
  const kb = Math.round(fs.statSync(file).size / 1024);
  const total = collections.reduce((sum, c) => sum + c.tokens.length, 0);
  console.log(`Wrote ${file} (${kb} KB): ${collections.map(c => `${c.name || c.address} ${c.tokens.length}`).join(' + ')} = ${total.toLocaleString()} tokens`);
}
console.log('Open one with  index.html?snapshot=data/snapshot.sample-<number>.json  on a local web server (for example VS Code Live Server).');
