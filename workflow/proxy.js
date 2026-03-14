// Local proxy that forwards Twitter API requests from residential IP
// GitHub runner sends requests here instead of directly to x.com
//
// Usage: node proxy.js
// Then expose via ngrok: ngrok http 3457

import { createServer } from 'http';

const PORT = parseInt(process.env.PROXY_PORT || '3457');

createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Reconstruct the Twitter URL from the request
  const twitterUrl = `https://x.com${req.url}`;

  // Forward all headers except host
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'host') continue;
    headers[k] = v;
  }

  try {
    const twitterRes = await fetch(twitterUrl, { method: req.method, headers });
    res.writeHead(twitterRes.status, { 'Content-Type': 'application/json' });
    const body = await twitterRes.text();
    res.end(body);
  } catch (e) {
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, () => console.log(`Twitter proxy on :${PORT}`));
