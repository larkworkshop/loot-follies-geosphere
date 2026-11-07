// Follies RPC proxy - an AWS Lambda function (Function URL) that keeps the Alchemy URL secret.
//
// The Geosphere page sends ordinary JSON-RPC calls here instead of to Alchemy. This function
// checks that each call is one of the two harmless lookups the page needs (tokenURI and ownerOf on
// YOUR contracts), forwards it to Alchemy using the secret URL stored in the function's settings,
// and hands the answer back. The secret never reaches the browser.
//
// Settings (Lambda > Configuration > Environment variables):
//   ALCHEMY_URL      required  Full Alchemy URL for Sepolia, key included (https://eth-sepolia.g.alchemy.com/v2/...)
//   CONTRACTS        required  Comma-separated contract addresses the page may read
//   ALLOWED_ORIGINS  optional  Comma-separated site addresses allowed to call this, e.g. https://main.d1abc.amplifyapp.com
//   RATE_PER_MINUTE  optional  Calls allowed per visitor IP per minute (default 60)
//
// Runtime: Node.js 20 or newer (uses the built-in fetch). No packages needed.

const SELECTORS = new Set([
  '0xc87b56dd', // tokenURI(uint256)
  '0x6352211e', // ownerOf(uint256)
]);
const MAX_BATCH = 4;
const UPSTREAM_TIMEOUT_MS = 15000;

const contracts = new Set((process.env.CONTRACTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const origins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
const ratePerMinute = Math.max(1, Number(process.env.RATE_PER_MINUTE || 60));

// Best-effort per-visitor limit. Each warm Lambda instance keeps its own counts, so this slows
// down a single noisy visitor; the hard ceiling on cost is the function's reserved concurrency
// and the usage alerts on your Alchemy account (see README).
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const rec = hits.get(ip);
  if (!rec || rec.minute !== minute) {
    if (hits.size > 5000) hits.clear();
    hits.set(ip, { minute, n: 1 });
    return false;
  }
  rec.n++;
  return rec.n > ratePerMinute;
}

function allowedCall(req) {
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return 'not a JSON-RPC request';
  if (req.method === 'eth_chainId') return null;
  if (req.method !== 'eth_call') return 'method not allowed';
  const p = req.params;
  if (!Array.isArray(p) || p.length < 1 || p.length > 2) return 'bad params';
  if (p.length === 2 && p[1] !== 'latest') return 'only the latest block is allowed';
  const tx = p[0];
  if (!tx || typeof tx !== 'object') return 'bad call';
  for (const k of Object.keys(tx)) if (k !== 'to' && k !== 'data') return 'unexpected field: ' + k;
  if (typeof tx.to !== 'string' || !contracts.has(tx.to.toLowerCase())) return 'contract not allowed';
  if (typeof tx.data !== 'string' || !/^0x[0-9a-fA-F]{72}$/.test(tx.data)) return 'bad call data';   // 4-byte selector + one 32-byte argument
  if (!SELECTORS.has(tx.data.slice(0, 10).toLowerCase())) return 'function not allowed';
  return null;
}

function rpcError(id, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code: -32601, message: 'Proxy: ' + message } };
}

export const handler = async (event) => {
  const http = (event.requestContext && event.requestContext.http) || {};
  const method = http.method || event.httpMethod || 'POST';
  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v;

  const origin = (headers.origin || '').replace(/\/+$/, '');
  const originOk = origins.length === 0 || origins.includes(origin);
  const cors = {
    'access-control-allow-origin': originOk && origin ? origin : (origins[0] || '*'),
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
  const reply = (status, body) => ({
    statusCode: status,
    headers: { ...cors, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  if (method === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (method !== 'POST') return reply(405, rpcError(null, 'POST only'));
  if (!process.env.ALCHEMY_URL || contracts.size === 0) return reply(500, rpcError(null, 'proxy is not configured'));
  if (!originOk) return reply(403, rpcError(null, 'origin not allowed'));
  if (tooMany(http.sourceIp || headers['x-forwarded-for'] || 'unknown')) return reply(429, rpcError(null, 'slow down'));

  let parsed;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    if (raw.length > 4000) return reply(413, rpcError(null, 'request too large'));
    parsed = JSON.parse(raw);
  } catch (e) {
    return reply(400, rpcError(null, 'invalid JSON'));
  }

  const batch = Array.isArray(parsed);
  const calls = batch ? parsed : [parsed];
  if (calls.length === 0 || calls.length > MAX_BATCH) return reply(400, rpcError(null, 'bad batch size'));
  for (const c of calls) {
    const why = allowedCall(c);
    if (why) return reply(403, batch ? calls.map(x => rpcError(x && x.id, why)) : rpcError(c && c.id, why));
  }

  try {
    const res = await fetch(process.env.ALCHEMY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch ? calls : calls[0]),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const text = await res.text();
    return reply(res.ok ? 200 : 502, res.ok ? text : rpcError(calls[0].id, 'upstream error ' + res.status));
  } catch (e) {
    return reply(502, rpcError(calls[0].id, 'upstream unavailable'));
  }
};
