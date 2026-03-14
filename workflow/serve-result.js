// Tiny HTTP server that serves the poller's output for the extension to read
// Runs alongside poll-tweet.js, serves output/status.json on port 3456

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';

const PORT = parseInt(process.env.SERVE_PORT || '3456');

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const file = 'output/status.json';
  if (existsSync(file)) {
    res.writeHead(200);
    res.end(readFileSync(file));
  } else {
    res.writeHead(200);
    res.end(JSON.stringify({status: 'waiting'}));
  }
}).listen(PORT, () => console.log(`Result server on :${PORT}`));
