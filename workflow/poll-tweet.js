// Polls a tweet's like status and detects "shave and a haircut" rhythm
// Works locally (docker) or in GitHub Actions
//
// Required env: TWITTER_COOKIES (json), TWEET_ID
// Optional env: GIST_ID, GH_TOKEN (for signaling to extension)

import { writeFileSync } from 'fs';

// "Shave and-a hair cut ... two bits"
//    1    2  +  3    4        6    7
const T = 460;
const PATTERN = [0, T, 1.5*T, 2*T, 3*T, 5*T, 6*T];
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '500');
const TIMEOUT = parseInt(process.env.TIMEOUT || '120000');
// Twitter's public client bearer — same for all users, embedded in twitter's JS bundle.
// Override via env if it rotates.
const BEARER = process.env.TWITTER_BEARER || 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const tweetId = process.env.TWEET_ID;
if (!tweetId) { console.error('TWEET_ID required'); process.exit(1); }
const cookies = JSON.parse(process.env.TWITTER_COOKIES);
const gistId = process.env.GIST_ID;
const ghToken = process.env.GH_TOKEN;

async function checkLiked() {
  const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const vars = JSON.stringify({
    focalTweetId: tweetId,
    withCommunity: false,
    includePromotedContent: false,
    withVoice: false,
    withBirdwatchNotes: false,
    withV2Timeline: true,
  });
  const res = await fetch(`https://x.com/i/api/graphql/xOhkmRac04YFZmOzU9PJHg/TweetDetail?variables=${encodeURIComponent(vars)}`, {
    headers: {
      'Authorization': `Bearer ${BEARER}`,
      'x-csrf-token': cookies.ct0,
      'Cookie': cookieStr,
    },
  });
  if (res.status === 429) {
    console.error('Rate limited, waiting 5s...');
    await new Promise(r => setTimeout(r, 5000));
    return checkLiked(); // retry
  }
  if (!res.ok) throw new Error(`Twitter API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions || [];
  for (const inst of instructions) {
    for (const entry of inst.entries || []) {
      const legacy = entry.content?.itemContent?.tweet_results?.result?.legacy;
      if (legacy && 'favorited' in legacy) return legacy.favorited;
    }
  }
  throw new Error('Could not find favorited field in response');
}

async function signal(content) {
  console.log(JSON.stringify(content));
  if (gistId && ghToken) {
    await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: {'Authorization': `Bearer ${ghToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({files: {'status.json': {content: JSON.stringify(content)}}}),
    });
  }
  writeFileSync('output/status.json', JSON.stringify(content, null, 2));
}

function validateRhythm(timestamps) {
  if (timestamps.length !== 7) return {valid: false, reason: `Need 7, got ${timestamps.length}`};
  const t = timestamps.map(ts => ts - timestamps[0]);
  const scale = t[6] / PATTERN[6];
  if (scale < 0.3 || scale > 5) return {valid: false, reason: 'Tempo way off'};
  const tolerance = 250 * scale;
  for (let i = 1; i < 7; i++) {
    if (Math.abs(t[i] - PATTERN[i] * scale) > tolerance) return {valid: false, reason: `Off at beat ${i + 1}`};
  }
  return {valid: true, scale, duration: t[6]};
}

function generateReport(transitions, result, pollLog) {
  const t0 = transitions[0].timestamp;
  const tEnd = transitions[transitions.length - 1].timestamp;
  const duration = tEnd - t0;
  const width = 60; // chars wide

  let report = '\n=== SHAVE AND A HAIRCUT — OBSERVER REPORT ===\n\n';
  report += `Tweet: ${process.env.TWEET_ID}\n`;
  report += `Transitions detected: ${transitions.length}\n`;
  report += `Duration: ${(duration / 1000).toFixed(2)}s\n`;
  report += `Result: ${result.valid ? 'AUTHENTICATED' : 'DENIED'}\n`;
  if (result.reason) report += `Reason: ${result.reason}\n`;
  if (result.scale) report += `Tempo: ${result.scale.toFixed(2)}x reference\n`;

  // Timeline
  report += '\n--- Timeline ---\n\n';
  report += '  Like state:\n  ';
  let lastTs = t0;
  let state = transitions[0].liked;
  for (const tr of transitions) {
    const gap = tr.timestamp - lastTs;
    const chars = Math.max(1, Math.round(gap / (duration / width)));
    report += (state ? '♥' : '♡').repeat(chars);
    state = tr.liked;
    lastTs = tr.timestamp;
  }
  report += '\n  ';
  // Tick marks
  lastTs = t0;
  for (const tr of transitions) {
    const gap = tr.timestamp - lastTs;
    const chars = Math.max(1, Math.round(gap / (duration / width)));
    report += ' '.repeat(chars - 1) + '|';
    lastTs = tr.timestamp;
  }

  // Beat table
  report += '\n\n--- Beats ---\n\n';
  report += '  Beat  Time(ms)  Expected  Delta   State\n';
  report += '  ----  --------  --------  ------  -----\n';
  const scale = result.scale || (transitions[6].timestamp - t0) / PATTERN[6];
  for (let i = 0; i < transitions.length; i++) {
    const actual = transitions[i].timestamp - t0;
    const expected = Math.round(PATTERN[i] * scale);
    const delta = actual - expected;
    const sign = delta >= 0 ? '+' : '';
    const state = transitions[i].liked ? 'liked' : 'unliked';
    report += `  ${String(i + 1).padStart(4)}  ${String(actual).padStart(8)}  ${String(expected).padStart(8)}  ${(sign + delta + 'ms').padStart(6)}  ${state}\n`;
  }

  // Poll stats
  if (pollLog.length > 1) {
    const intervals = [];
    for (let i = 1; i < pollLog.length; i++) intervals.push(pollLog[i] - pollLog[i - 1]);
    const avg = intervals.reduce((a, b) => a + b) / intervals.length;
    const max = Math.max(...intervals);
    const min = Math.min(...intervals);
    report += `\n--- Poll Stats ---\n\n`;
    report += `  Polls: ${pollLog.length}\n`;
    report += `  Interval: avg ${avg.toFixed(0)}ms, min ${min}ms, max ${max}ms\n`;
  }

  report += '\n==============================================\n';
  return report;
}

async function main() {
  console.log(`Polling tweet ${tweetId} every ${POLL_INTERVAL}ms (timeout ${TIMEOUT/1000}s)`);

  let lastState = await checkLiked();
  console.log(`Initial like state: ${lastState}`);

  await signal({status: 'polling', tweet_id: tweetId, started: Date.now(), initial_state: lastState});

  const transitions = [];
  const pollLog = [];      // timestamps of each poll
  const stateLog = [];     // {t: ms_since_start, liked: bool} for every poll
  const start = Date.now();

  while (Date.now() - start < TIMEOUT) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    pollLog.push(Date.now());

    let liked;
    try { liked = await checkLiked(); }
    catch (e) { console.error('Poll error:', e.message); continue; }

    stateLog.push({t: Date.now() - start, liked});

    // Update status file every poll so the observer panel has fresh data
    if (stateLog.length % 5 === 0 || liked !== lastState) {
      await signal({
        status: 'polling',
        tweet_id: tweetId,
        transitions: transitions.length,
        elapsed: Date.now() - start,
        stateLog: stateLog.slice(-80),
      });
    }

    if (liked !== lastState) {
      const ts = Date.now();
      transitions.push({timestamp: ts, liked, seq: transitions.length + 1});
      console.log(`Transition ${transitions.length}: ${lastState} -> ${liked} at +${ts - start}ms`);
      lastState = liked;

      if (transitions.length === 7) {
        const result = validateRhythm(transitions.map(t => t.timestamp));
        const report = generateReport(transitions, result, pollLog);
        console.log(report);

        const output = {
          type: 'shave-and-haircut',
          status: result.valid ? 'authenticated' : 'denied',
          tweet_id: tweetId,
          transitions,
          result,
          report,
          timestamp: Date.now(),
        };
        await signal(output);
        writeFileSync('output/shave-result.json', JSON.stringify(output, null, 2));
        writeFileSync('output/report.txt', report);
        process.exit(result.valid ? 0 : 1);
      }

      await signal({
        status: 'polling',
        tweet_id: tweetId,
        transitions: transitions.length,
        last_transition: ts,
        elapsed: ts - start,
        stateLog: stateLog.slice(-80),
      });
    }
  }

  await signal({status: 'timeout', transitions: transitions.length});
  process.exit(1);
}

main();
