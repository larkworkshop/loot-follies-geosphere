// Runs the Lambda proxy (lambda/index.mjs) on YOUR computer, so you can try the click lookups
// before setting anything up on AWS. Nothing leaves your machine except the calls to Alchemy.
//
//   ALCHEMY_KEY=your-key npm run local-proxy          (Mac / Linux)
//   $env:ALCHEMY_KEY="your-key"; npm run local-proxy  (Windows PowerShell)
//
// Then:
//   1. Copy config.local.example.json to config.local.json (it points the page at this proxy).
//   2. Open the page through a local web server such as VS Code Live Server.
//   3. Click a dot. This window logs each request.
//
// It listens on 127.0.0.1 only, so nothing else on your network can reach it. Settings (all optional):
//   PORT=8787   CONTRACTS=0x..,0x..   (default: the addresses in config.json)
//   ALLOWED_ORIGINS=...               (default: the usual Live Server / local addresses)
//   RPC_URL or ALCHEMY_URL=...        (a full address, instead of ALCHEMY_KEY)
import fs from 'node:fs';
import http from 'node:http';

const PORT = Number(process.env.PORT || 8787);
let config;
try { config = JSON.parse(fs.readFileSync(process.env.CONFIG || 'config.json', 'utf8')); }
catch (e) { console.error('Could not read config.json. Run this from the project folder (the one that contains config.json).'); process.exit(1); }
const chainId = Number(config.chainId || 1);

const HOSTS = { 1: 'eth-mainnet.g.alchemy.com', 11155111: 'eth-sepolia.g.alchemy.com' };
let upstream = (process.env.ALCHEMY_URL || process.env.RPC_URL || '').trim();
if (!upstream) {
  let key = (process.env.ALCHEMY_KEY || '').trim();
  if (key.includes('/')) key = key.split('/').filter(Boolean).pop();
  if (!/^[A-Za-z0-9_-]{8,}$/.test(key)) { console.error('Set ALCHEMY_KEY to your Alchemy key (just the key), then run this again.'); process.exit(1); }
  if (!HOSTS[chainId]) { console.error(`No Alchemy address known for chain ${chainId}. Set RPC_URL instead.`); process.exit(1); }
  upstream = `https://${HOSTS[chainId]}/v2/${key}`;
}

// The proxy code reads its settings when it loads, so set them first.
process.env.ALCHEMY_URL = upstream;
process.env.CONTRACTS = process.env.CONTRACTS || config.collections.map(c => c.address).join(',');
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ||
  ['5500', '5501', '3000', '8000', '8080'].flatMap(p => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]).join(',');
process.env.RATE_PER_MINUTE = process.env.RATE_PER_MINUTE || '600';

const { handler } = await import('../lambda/index.mjs');

http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; if (body.length > 100000) req.destroy(); });
  req.on('end', async () => {
    const event = { headers: req.headers, body, isBase64Encoded: false, requestContext: { http: { method: req.method, sourceIp: req.socket.remoteAddress } } };
    const out = await handler(event);
    let what = '';
    try { const j = JSON.parse(body); what = (Array.isArray(j) ? j : [j]).map(c => c.method).join(','); } catch { /* not JSON */ }
    console.log(`${new Date().toLocaleTimeString()}  ${req.method} ${what || '-'}  ->  ${out.statusCode}`);
    res.writeHead(out.statusCode, out.headers);
    res.end(out.body);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Local proxy running at http://127.0.0.1:${PORT}/  (chain ${chainId}, ${process.env.CONTRACTS.split(',').length} contracts allowed)`);
  console.log('Leave this window open while you test. Press Ctrl+C to stop.');
});
