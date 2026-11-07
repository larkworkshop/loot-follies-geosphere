// Reads the Follies contract(s) from the chain and writes data/snapshot.json for the public page.
//
//   ALCHEMY_KEY=your-key node scripts/snapshot.mjs
//
// First run: walks the whole collection (totalSupply / tokenByIndex / ownerOf / tokenURI).
// Later runs: only replays Transfer events since the last run (new mints, transfers, burns).
// Set FULL_REFRESH=1 to rescan everything (e.g. if a token's coordinates/Order/Use can change).
//
// Secrets: give it ALCHEMY_KEY (just the key, not the whole URL). The script builds the Alchemy
// address for the chain in config.json itself. For another provider, set RPC_URL to the full address
// instead. Everything this script prints passes through a filter that blanks out those values, so
// they cannot end up in a log even if a library puts the address in an error message.
//
// Env (all optional except one of ALCHEMY_KEY / RPC_URL):
//   CONFIG=config.json   OUT=data/snapshot.json   CONCURRENCY=5   CONFIRMATIONS=3
//   LOG_CHUNK_BLOCKS=2000   MAX_AGE_HOURS=24   FULL_REFRESH=0
import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { JsonRpcProvider, Network, Contract, getAddress, ZeroAddress, id as keccak256 } from 'ethers';

/* ---- keep secrets out of every log line ---- */
const SECRETS = new Set();
function addSecret(value) {
  const v = String(value || '').trim();
  if (v.length >= 8) { SECRETS.add(v); SECRETS.add(encodeURIComponent(v)); }
}
function redact(text) {
  let out = String(text);
  for (const sec of SECRETS) out = out.split(sec).join('[redacted]');
  return out;
}
const safeMessage = (e) => redact((e && (e.shortMessage || e.message)) || e);

addSecret(process.env.RPC_URL);
addSecret(process.env.ALCHEMY_KEY);
try {   // the last part of an address like https://host/v2/<key> is the key itself
  const last = new URL(String(process.env.RPC_URL || '')).pathname.split('/').filter(Boolean).pop();
  if (last && last.length >= 12) addSecret(last);
} catch { /* RPC_URL not set, or not an address */ }

for (const method of ['log', 'info', 'warn', 'error']) {
  const original = console[method].bind(console);
  console[method] = (...args) => original(...args.map(a => redact(typeof a === 'string' ? a : inspect(a, { depth: 3 }))));
}
process.on('uncaughtException', (e) => { console.error('Snapshot failed:', safeMessage(e)); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('Snapshot failed:', safeMessage(e)); process.exit(1); });

const ALCHEMY_HOSTS = { 1: 'eth-mainnet.g.alchemy.com', 11155111: 'eth-sepolia.g.alchemy.com' };
function resolveRpcUrl(chainId) {
  const full = (process.env.RPC_URL || '').trim();
  if (full) return full;
  let key = (process.env.ALCHEMY_KEY || '').trim();
  if (!key) throw new Error('Set the ALCHEMY_KEY environment variable (your Alchemy API key), or RPC_URL for another provider.');
  if (key.includes('/')) key = key.split('/').filter(Boolean).pop();       // tolerate a pasted full address
  if (!/^[A-Za-z0-9_-]{8,}$/.test(key)) throw new Error('ALCHEMY_KEY has unexpected characters. Use only the key, without the address in front of it.');
  addSecret(key);
  const host = ALCHEMY_HOSTS[chainId];
  if (!host) throw new Error(`ALCHEMY_KEY is only wired to chain ids ${Object.keys(ALCHEMY_HOSTS).join(' and ')}. For chain ${chainId}, set RPC_URL instead.`);
  const url = `https://${host}/v2/${key}`;
  addSecret(url);
  return url;
}

const CONFIG_PATH = process.env.CONFIG || 'config.json';
const OUT_PATH = process.env.OUT || 'data/snapshot.json';
const FULL = ['1', 'true'].includes(String(process.env.FULL_REFRESH || '').toLowerCase());
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 5));
const CONFIRMATIONS = Math.max(0, Number(process.env.CONFIRMATIONS || 3));
const LOG_CHUNK = Math.max(1, Number(process.env.LOG_CHUNK_BLOCKS || 2000));
const MAX_AGE_MS = Number(process.env.MAX_AGE_HOURS || 24) * 3600 * 1000;

const ABI = [
  'function totalSupply() view returns (uint256)',
  'function tokenByIndex(uint256 index) view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
];
const TRANSFER_TOPIC = keccak256('Transfer(address,address,uint256)');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function retry(fn, label, tries = 6) {
  let delay = 500;
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (e && e.code === 'CALL_EXCEPTION') throw e;       // a revert won't get better by retrying
      if (i >= tries) throw new Error(`${label}: ${safeMessage(e)}`);
      await sleep(delay); delay = Math.min(delay * 2, 15000);
    }
  }
}
async function pool(items, n, fn) {
  let next = 0, done = 0, failed = null;
  const total = items.length;
  const workers = Array.from({ length: Math.min(n, total) }, async () => {
    while (!failed) {
      const i = next++;
      if (i >= total) return;
      try { await fn(items[i], i); } catch (e) { failed = e; return; }
      done++;
      if (done % 250 === 0) console.log(`  ... ${done}/${total}`);
    }
  });
  await Promise.all(workers);
  if (failed) throw failed;
}

/* ---- metadata parsing (kept in step with the viewer) ---- */
function decodeTokenURI(uri) {
  if (uri.startsWith('data:application/json;base64,')) return JSON.parse(Buffer.from(uri.slice(29), 'base64').toString('utf8'));
  if (uri.startsWith('data:application/json,')) return JSON.parse(decodeURIComponent(uri.slice(22)));
  throw new Error('tokenURI is not an on-chain data: JSON URI');
}
const trait = (meta, type) => {
  const a = Array.isArray(meta && meta.attributes) ? meta.attributes.find(x => x && x.trait_type === type) : null;
  return a ? a.value : undefined;
};
function parseTrackedFields(meta) {
  const coord = trait(meta, 'Equatorial Coordinates');
  const m = typeof coord === 'string' && coord.match(/α\s*=\s*(\d+):(\d+):(\d+)\s*;\s*δ\s*=\s*(-?\d+)/);
  if (!m) return null;
  const pad = (s) => String(parseInt(s, 10)).padStart(2, '0');
  const o = trait(meta, 'Order'), u = trait(meta, 'Use');
  let order = null;
  if (o !== undefined && o !== null) {
    const s = String(o).trim();
    if (/^unordered$/i.test(s)) order = -1;
    else if (/^\d+$/.test(s) && parseInt(s, 10) <= 15) order = parseInt(s, 10);
  }
  let use = null;
  if (u !== undefined && u !== null && /^\d+$/.test(String(u).trim()) && parseInt(String(u).trim(), 10) <= 23) use = parseInt(String(u).trim(), 10);
  const nm = trait(meta, 'Name');
  return { ra: `${pad(m[1])}:${pad(m[2])}:${pad(m[3])}`, dec: parseInt(m[4], 10), order, use, name: typeof nm === 'string' ? nm : '' };
}

/* ---- per-collection work ---- */
async function processCollection(cfg, provider, prev, head, chainId) {
  const address = getAddress(cfg.address);
  const contract = new Contract(address, ABI, provider);
  const toBlock = head - CONFIRMATIONS;

  let name = cfg.name || '', symbol = '';
  try { const n = await retry(() => contract.name(), 'name()'); if (!cfg.name) name = n; } catch {}
  try { symbol = await retry(() => contract.symbol(), 'symbol()'); } catch {}

  const tokens = new Map();      // id -> { owner, ra, dec, order, use, name }
  const skippedIds = new Set();  // tokens without usable coordinates

  const fetchToken = async (id) => {
    let owner;
    try { owner = await retry(() => contract.ownerOf(id), `ownerOf(${id})`); }
    catch (e) { if (e.code === 'CALL_EXCEPTION') return; throw e; }   // burned or never existed
    const uri = await retry(() => contract.tokenURI(id), `tokenURI(${id})`);
    let fields = null;
    try { fields = parseTrackedFields(decodeTokenURI(uri)); } catch { /* not plottable */ }
    if (fields) { tokens.set(id, { owner: getAddress(owner), ...fields }); skippedIds.delete(id); }
    else { skippedIds.add(id); tokens.delete(id); }
  };

  let lastBlock;
  if (prev && !FULL) {
    for (const r of prev.tokens) tokens.set(String(r[0]), { owner: getAddress(prev.owners[r[1]]), ra: r[2], dec: r[3], order: r[4], use: r[5], name: r[6] || '' });
    for (const id of prev.skippedIds || []) skippedIds.add(String(id));
    lastBlock = prev.lastBlock;
    console.log(`${name}: ${tokens.size} tokens in previous snapshot; replaying blocks ${lastBlock + 1}..${toBlock}`);

    const events = [];
    let from = lastBlock + 1, chunk = LOG_CHUNK;
    while (from <= toBlock) {
      const to = Math.min(from + chunk - 1, toBlock);
      try {
        const query = () => provider.getLogs({ address, topics: [TRANSFER_TOPIC], fromBlock: from, toBlock: to });
        // A refused range is most likely a provider block-range cap: shrink the window rather than retry it.
        const logs = chunk === 1 ? await retry(query, 'getLogs') : await query();
        events.push(...logs);
        from = to + 1;
      } catch (e) {
        if (chunk === 1) throw e;
        chunk = Math.max(1, Math.floor(chunk / 2));
        console.log(`  getLogs refused the range, retrying with ${chunk} blocks`);
      }
    }
    events.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

    const pending = new Set();
    for (const l of events) {
      if (l.topics.length !== 4) continue;                  // not an ERC-721 Transfer
      const fromAddr = getAddress('0x' + l.topics[1].slice(26));
      const toAddr = getAddress('0x' + l.topics[2].slice(26));
      const id = BigInt(l.topics[3]).toString();
      if (toAddr === ZeroAddress) { tokens.delete(id); skippedIds.delete(id); pending.delete(id); continue; }
      if (tokens.has(id)) tokens.get(id).owner = toAddr;
      else if (skippedIds.has(id)) continue;
      else pending.add(id);
      void fromAddr;
    }
    console.log(`  ${events.length} transfer event(s); ${pending.size} new/unknown token(s) to read`);
    await pool([...pending], CONCURRENCY, fetchToken);
  } else {
    const supply = Number(await retry(() => contract.totalSupply(), 'totalSupply()'));
    console.log(`${name}: full scan of ${supply} token(s)${FULL ? ' (FULL_REFRESH)' : ''}`);
    const ids = new Array(supply);
    await pool([...Array(supply).keys()], CONCURRENCY, async (i) => { ids[i] = (await retry(() => contract.tokenByIndex(i), `tokenByIndex(${i})`)).toString(); });
    await pool(ids, CONCURRENCY, fetchToken);
  }
  lastBlock = toBlock;

  // Compact rows: [id, ownerIndex, "HH:MM:SS", dec, order (-1 = Unordered, null = none), use, name]
  const owners = [], ownerIdx = new Map();
  const rows = [...tokens.entries()].sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1)).map(([id, t]) => {
    if (!ownerIdx.has(t.owner)) { ownerIdx.set(t.owner, owners.length); owners.push(t.owner); }
    const idOut = Number.isSafeInteger(Number(id)) ? Number(id) : id;
    return [idOut, ownerIdx.get(t.owner), t.ra, t.dec, t.order, t.use, t.name];
  });
  const skipped = [...skippedIds].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).map(x => (Number.isSafeInteger(Number(x)) ? Number(x) : x));
  return { address, name, symbol, chainId, lastBlock, skipped: skipped.length, skippedIds: skipped, owners, tokens: rows };
}

/* ---- main ---- */
async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const list = (config.collections || []).filter(c => c && c.address);
  if (!list.length) throw new Error(`No collections in ${CONFIG_PATH}.`);
  for (const c of list) if (/^0x0{40}$/i.test(c.address)) throw new Error(`${CONFIG_PATH} still has the placeholder contract address. Put your real contract address in.`);

  const chainId = Number(config.chainId || 1);
  const provider = new JsonRpcProvider(resolveRpcUrl(chainId), chainId, { staticNetwork: Network.from(chainId) });
  const actual = Number((await retry(() => provider.getNetwork(), 'getNetwork')).chainId);
  if (actual !== chainId) throw new Error(`RPC is on chain ${actual} but ${CONFIG_PATH} says ${chainId}.`);
  const head = await retry(() => provider.getBlockNumber(), 'getBlockNumber');

  let prevSnap = null;
  try { prevSnap = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch { /* first run */ }

  const out = [];
  for (const c of list) {
    const prev = prevSnap && (prevSnap.collections || []).find(p => p.address.toLowerCase() === c.address.toLowerCase() && Number(p.chainId) === chainId && Array.isArray(p.tokens));
    out.push(await processCollection(c, provider, prev, head, chainId));
  }

  // Skip the write (and so the commit) when nothing changed, except for a periodic refresh
  // that keeps lastBlock and the "updated" time from going stale.
  const sig = (cols) => JSON.stringify((cols || []).map(c => [c.address, c.name, c.symbol, c.owners, c.tokens, c.skippedIds]));
  const prevAge = prevSnap && prevSnap.generatedAt ? Date.now() - Date.parse(prevSnap.generatedAt) : Infinity;
  if (prevSnap && !FULL && sig(prevSnap.collections) === sig(out) && prevAge < MAX_AGE_MS) {
    console.log('No changes since the last snapshot; leaving the file as is.');
    return;
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const tmp = OUT_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), collections: out }));
  fs.renameSync(tmp, OUT_PATH);
  console.log(`Wrote ${OUT_PATH}: ` + out.map(c => `${c.name || c.address} ${c.tokens.length} tokens (${c.skipped} skipped)`).join('; '));
}
main().catch(e => { console.error('Snapshot failed:', safeMessage(e)); process.exit(1); });
