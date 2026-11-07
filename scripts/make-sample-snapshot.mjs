// Makes a FAKE snapshot so you can test the globe, filters and checkboxes with no blockchain at all.
//
//   npm run sample                      (5,788 invented tokens for each contract in config.json)
//   node scripts/make-sample-snapshot.mjs 2000      (a different number per contract)
//
// Writes data/snapshot.sample.json. View it locally with:
//   http://127.0.0.1:5500/index.html?snapshot=data/snapshot.sample.json
// The page shows a "TEST DATA" note while it is loaded, and clicking a dot shows no artwork.
// This file is listed in .gitignore and is removed from the Amplify build, so it never goes live.
import fs from 'node:fs';
import path from 'node:path';
import { getAddress } from 'ethers';

const CONFIG_PATH = process.env.CONFIG || 'config.json';
const OUT_PATH = process.env.OUT || 'data/snapshot.sample.json';
const PER_CONTRACT = Math.max(1, parseInt(process.argv[2] || '5788', 10));

if (path.basename(OUT_PATH) === 'snapshot.json') {
  console.error('Refusing to overwrite data/snapshot.json (the real snapshot). Use the default output name.');
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

const collections = list.map((cfg, ci) => {
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
    const dec = Math.max(-70, Math.min(70, Math.round(gauss(rnd) * 28)));        // the real project tops out near 70 degrees
    const order = rnd() < 0.6 ? -1 : Math.floor(rnd() * 16);                      // -1 = Unordered
    const use = Math.floor(rnd() * 24);
    tokens.push([id, pickOwner(), ra, dec, order, use, `Test place ${id}`]);
  }
  return {
    address: getAddress(cfg.address), name: cfg.name || '', symbol: 'TEST', chainId: Number(config.chainId || 1),
    lastBlock: 0, skipped: 0, skippedIds: [], owners, tokens,
  };
});

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify({ version: 1, sample: true, generatedAt: new Date().toISOString(), collections }));
const kb = Math.round(fs.statSync(OUT_PATH).size / 1024);
console.log(`Wrote ${OUT_PATH} (${kb} KB): ${collections.map(c => `${c.name || c.address} ${c.tokens.length} tokens`).join('; ')}`);
console.log('Open it with  index.html?snapshot=data/snapshot.sample.json  on a local web server (for example VS Code Live Server).');
