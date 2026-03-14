// HTTP server that receives tap notifications from the extension
// and verifies each against Twitter

import { createServer } from 'http';
import { writeFileSync, mkdirSync } from 'fs';

const PORT = parseInt(process.env.TAP_PORT || '8765');
const BEARER = process.env.TWITTER_BEARER || 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const QUERY_ID = process.env.TWITTER_QUERY_ID || '9rs110LSoPARDs61WOBZ7A';
const BASE_URL = process.env.TWITTER_PROXY || 'https://x.com';
const tweetId = process.env.TWEET_ID;
const cookies = JSON.parse(process.env.TWITTER_COOKIES);

const REQUIRED_TRANSITIONS = 3;
const TIME_WINDOW = 15000; // 15 seconds

if (!tweetId) { console.error('TWEET_ID required'); process.exit(1); }

async function checkLiked() {
  const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const vars = JSON.stringify({
    focalTweetId: tweetId, withCommunity: false, includePromotedContent: false,
    withVoice: false, withBirdwatchNotes: false, withV2Timeline: true,
  });
  const res = await fetch(`${BASE_URL}/i/api/graphql/${QUERY_ID}/TweetDetail?variables=${encodeURIComponent(vars)}`, {
    headers: {
      'Authorization': `Bearer ${BEARER}`,
      'x-csrf-token': cookies.ct0,
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'ngrok-skip-browser-warning': 'true',
    },
  });
  if (!res.ok) throw new Error(`Twitter API ${res.status}`);
  const data = await res.json();
  for (const inst of data?.data?.threaded_conversation_with_injections_v2?.instructions || []) {
    for (const entry of inst.entries || []) {
      const legacy = entry.content?.itemContent?.tweet_results?.result?.legacy;
      if (legacy && 'favorited' in legacy) return legacy.favorited;
    }
  }
  throw new Error('Could not find favorited field');
}

function validateTransitions(verified) {
  const changes = verified.filter(v => v.changed);
  if (changes.length < REQUIRED_TRANSITIONS) return { valid: false, reason: `Need ${REQUIRED_TRANSITIONS} state changes, got ${changes.length}` };
  const duration = verified[verified.length - 1].server_ts - verified[0].server_ts;
  if (duration > TIME_WINDOW) return { valid: false, reason: `Took ${(duration/1000).toFixed(1)}s, need under ${TIME_WINDOW/1000}s` };
  return { valid: true, changes: changes.length, duration };
}

const verified = [];
let lastState = null;

mkdirSync('output', { recursive: true });

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'POST' && req.url === '/tap') {
    const i = verified.length;
    if (verified.filter(v => v.changed).length >= REQUIRED_TRANSITIONS) { res.writeHead(200); res.end(JSON.stringify({ error: 'already done' })); return; }

    const serverTs = Date.now();
    let liked;
    try { liked = await checkLiked(); } catch (e) {
      res.writeHead(200);
      res.end(JSON.stringify({ tap: i + 1, error: e.message }));
      return;
    }

    const changed = lastState !== null && liked !== lastState;
    lastState = liked;
    verified.push({ tap: i + 1, server_ts: serverTs, liked, changed });
    console.log(`Tap ${i + 1}/7: liked=${liked} changed=${changed} +${i > 0 ? serverTs - verified[0].server_ts : 0}ms`);

    const response = { tap: i + 1, liked, changed, total: verified.length };

    const changes = verified.filter(v => v.changed).length;
    if (changes >= REQUIRED_TRANSITIONS) {
      const result = validateTransitions(verified);
      response.result = result;
      response.status = result.valid ? 'authenticated' : 'denied';

      const output = {
        type: 'login-with-anything',
        name: 'twitter-like',
        status: response.status,
        tweet_id: tweetId,
        verified,
        result,
        timestamp: Date.now(),
      };
      writeFileSync('output/result.json', JSON.stringify(output, null, 2));
      writeFileSync('output/status.json', JSON.stringify(output, null, 2));
      console.log(`\nResult: ${response.status.toUpperCase()}`);
      if (result.valid) console.log(`Duration: ${(result.duration/1000).toFixed(2)}s Tempo: ${result.scale.toFixed(2)}x`);

      // Shut down after a short delay so the response gets sent
      setTimeout(() => process.exit(result.valid ? 0 : 1), 1000);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ taps: verified.length, verified, tweet_id: tweetId }));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`Tap server on :${PORT}`);
  console.log(`::tap-server-ready::${PORT}`);
});
