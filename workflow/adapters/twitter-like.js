// Log in with Twitter Like — event-driven mode
// Runner waits for tap notifications via gist, verifies each one with a single API call

import { writeFileSync, mkdirSync } from 'fs';

const BEARER = process.env.TWITTER_BEARER || 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const QUERY_ID = process.env.TWITTER_QUERY_ID || '9rs110LSoPARDs61WOBZ7A';
const BASE_URL = process.env.TWITTER_PROXY || 'https://x.com';
const tweetId = process.env.TWEET_ID;
const cookies = JSON.parse(process.env.TWITTER_COOKIES);
const gistId = process.env.GIST_ID;
const ghToken = process.env.GH_TOKEN;
const TIMEOUT = parseInt(process.env.TIMEOUT || '120000');

if (!tweetId) { console.error('TWEET_ID required'); process.exit(1); }
if (!gistId || !ghToken) { console.error('GIST_ID and GH_TOKEN required'); process.exit(1); }

// Rhythm pattern
const T_REF = 700;
const PATTERN = [0, T_REF, 1.5*T_REF, 2*T_REF, 3*T_REF, 5*T_REF, 6*T_REF];

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
  if (res.status === 429) throw new Error('rate-limited');
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

async function readGist() {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: { 'Authorization': `Bearer ${ghToken}` },
  });
  if (!res.ok) throw new Error(`Gist read failed: ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.files['status.json'].content);
}

async function writeGist(content) {
  await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${ghToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { 'status.json': { content: JSON.stringify(content) } } }),
  });
}

function validateRhythm(timestamps) {
  if (timestamps.length !== 7) return { valid: false, reason: `Need 7, got ${timestamps.length}` };
  const t = timestamps.map(ts => ts - timestamps[0]);
  const scale = t[6] / PATTERN[6];
  if (scale < 0.3 || scale > 5) return { valid: false, reason: 'Tempo way off' };
  const tolerance = 300 * scale;
  for (let i = 1; i < 7; i++) {
    if (Math.abs(t[i] - PATTERN[i] * scale) > tolerance) return { valid: false, reason: `Off at beat ${i + 1}` };
  }
  return { valid: true, scale, duration: t[6] };
}

async function main() {
  mkdirSync('output', { recursive: true });
  console.log(`[twitter-like] Event-driven mode. Watching tweet ${tweetId}`);
  console.log(`[twitter-like] Waiting for taps via gist ${gistId}`);

  // Initial check
  const initialState = await checkLiked();
  console.log(`[twitter-like] Initial state: ${initialState}`);

  // Signal ready
  await writeGist({
    status: 'polling',
    name: 'twitter-like',
    tweet_id: tweetId,
    started: Date.now(),
    initial_state: initialState,
    transitions: 0,
    verified: [],
    message: 'Runner connected. Click the like button in rhythm!',
  });

  const verified = []; // {tap_n, client_ts, server_ts, liked, verified}
  let lastState = initialState;
  const start = Date.now();

  // Poll gist for tap notifications from the extension
  while (Date.now() - start < TIMEOUT && verified.length < 7) {
    await new Promise(r => setTimeout(r, 800));

    let gistData;
    try { gistData = await readGist(); } catch (e) { continue; }

    // Extension writes taps as: {taps: [{n: 1, ts: 1234567890}, ...]}
    const clientTaps = gistData.taps || [];
    if (clientTaps.length <= verified.length) continue;

    // New tap(s) to verify
    for (let i = verified.length; i < clientTaps.length && i < 7; i++) {
      const tap = clientTaps[i];
      console.log(`[twitter-like] Verifying tap ${i + 1}...`);

      let liked;
      try {
        liked = await checkLiked();
      } catch (e) {
        console.error(`[twitter-like] Verification failed: ${e.message}`);
        verified.push({ tap_n: i + 1, client_ts: tap.ts, server_ts: Date.now(), error: e.message });
        continue;
      }

      const stateChanged = liked !== lastState;
      console.log(`[twitter-like] Tap ${i + 1}: liked=${liked}, changed=${stateChanged}`);
      verified.push({
        tap_n: i + 1,
        client_ts: tap.ts,
        server_ts: Date.now(),
        liked,
        state_changed: stateChanged,
      });
      lastState = liked;

      // Update gist with progress
      await writeGist({
        status: 'polling',
        name: 'twitter-like',
        tweet_id: tweetId,
        transitions: verified.filter(v => v.state_changed).length,
        verified,
        elapsed: Date.now() - start,
      });
    }
  }

  // Validate rhythm using server-side timestamps
  const serverTimestamps = verified.map(v => v.server_ts);
  const result = verified.length === 7 ? validateRhythm(serverTimestamps) : { valid: false, reason: `Only got ${verified.length} taps` };

  const output = {
    type: 'login-with-anything',
    name: 'twitter-like',
    status: result.valid ? 'authenticated' : 'denied',
    tweet_id: tweetId,
    verified,
    result,
    timestamp: Date.now(),
  };

  console.log(`\n=== RESULT: ${output.status.toUpperCase()} ===`);
  if (result.valid) console.log(`Duration: ${(result.duration/1000).toFixed(2)}s, Tempo: ${result.scale.toFixed(2)}x`);
  else console.log(`Reason: ${result.reason}`);
  console.log('\nVerified taps:');
  for (const v of verified) {
    const delta = v.server_ts - verified[0].server_ts;
    console.log(`  ${v.tap_n}. +${delta}ms liked=${v.liked} changed=${v.state_changed}${v.error ? ' ERROR: '+v.error : ''}`);
  }

  await writeGist({ ...output, verified });
  writeFileSync('output/status.json', JSON.stringify(output, null, 2));
  writeFileSync('output/result.json', JSON.stringify(output, null, 2));
  process.exit(result.valid ? 0 : 1);
}

main();
