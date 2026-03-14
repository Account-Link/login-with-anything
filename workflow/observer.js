// "Log in with Anything" observer SDK
// Generic rhythm-detection observer that works with any boolean poll function
//
// Usage:
//   import { createObserver } from './observer.js';
//   const obs = createObserver({
//     name: 'twitter-like',
//     poll: async () => { /* return true/false */ },
//   });
//   await obs.run();

import { writeFileSync, mkdirSync } from 'fs';

// "Shave and a haircut" rhythm: quick pair is "and-a" between beats 2 and 3
const T_REF = 700;
const PATTERN = [0, T_REF, 1.5 * T_REF, 2 * T_REF, 3 * T_REF, 5 * T_REF, 6 * T_REF];

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

function generateReport(name, transitions, result, pollLog) {
  const t0 = transitions[0].timestamp;
  const duration = transitions[transitions.length - 1].timestamp - t0;
  const width = 60;

  let r = `\n=== LOG IN WITH ${name.toUpperCase()} — OBSERVER REPORT ===\n\n`;
  r += `Transitions: ${transitions.length}\n`;
  r += `Duration: ${(duration / 1000).toFixed(2)}s\n`;
  r += `Result: ${result.valid ? 'AUTHENTICATED' : 'DENIED'}\n`;
  if (result.reason) r += `Reason: ${result.reason}\n`;
  if (result.scale) r += `Tempo: ${result.scale.toFixed(2)}x reference\n`;

  r += '\n--- Beats ---\n\n';
  r += '  #   Time(ms)  Expected  Delta    State\n';
  r += '  --  --------  --------  -------  -----\n';
  const scale = result.scale || (transitions[6].timestamp - t0) / PATTERN[6];
  for (let i = 0; i < transitions.length; i++) {
    const actual = transitions[i].timestamp - t0;
    const expected = Math.round(PATTERN[i] * scale);
    const delta = actual - expected;
    const sign = delta >= 0 ? '+' : '';
    r += `  ${String(i + 1).padStart(2)}  ${String(actual).padStart(8)}  ${String(expected).padStart(8)}  ${(sign + delta + 'ms').padStart(7)}  ${transitions[i].state ? 'ON' : 'OFF'}\n`;
  }

  if (pollLog.length > 1) {
    const intervals = [];
    for (let i = 1; i < pollLog.length; i++) intervals.push(pollLog[i] - pollLog[i - 1]);
    const avg = intervals.reduce((a, b) => a + b) / intervals.length;
    r += `\n--- Poll Stats ---\n`;
    r += `  Polls: ${pollLog.length}, avg interval: ${avg.toFixed(0)}ms\n`;
  }

  r += `\n${'='.repeat(50)}\n`;
  return r;
}

export function createObserver({ name, poll, description }) {
  const pollInterval = parseInt(process.env.POLL_INTERVAL || '500');
  const timeout = parseInt(process.env.TIMEOUT || '120000');
  const gistId = process.env.GIST_ID;
  const ghToken = process.env.GH_TOKEN;

  const transitions = [];
  const pollLog = [];
  const stateLog = [];

  async function signal(content) {
    console.log(JSON.stringify(content));
    mkdirSync('output', { recursive: true });
    writeFileSync('output/status.json', JSON.stringify(content, null, 2));
    if (gistId && ghToken) {
      await fetch(`https://api.github.com/gists/${gistId}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${ghToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: { 'status.json': { content: JSON.stringify(content) } } }),
      });
    }
  }

  async function run() {
    console.log(`[${name}] Polling every ${pollInterval}ms (timeout ${timeout / 1000}s)`);
    if (description) console.log(`  ${description}`);

    let lastState = await poll();
    console.log(`[${name}] Initial state: ${lastState}`);

    const start = Date.now();
    await signal({ status: 'polling', name, started: start, initial_state: lastState });

    while (Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, pollInterval));
      pollLog.push(Date.now());

      let state;
      try { state = await poll(); }
      catch (e) { console.error('Poll error:', e.message); continue; }

      stateLog.push({ t: Date.now() - start, state });

      // Update status file periodically
      if (stateLog.length % 3 === 0 || state !== lastState) {
        await signal({
          status: 'polling',
          name,
          transitions: transitions.length,
          elapsed: Date.now() - start,
          stateLog: stateLog.slice(-80),
        });
      }

      if (state !== lastState) {
        const ts = Date.now();
        transitions.push({ timestamp: ts, state, seq: transitions.length + 1 });
        console.log(`[${name}] Transition ${transitions.length}: ${lastState} -> ${state} at +${ts - start}ms`);
        lastState = state;

        if (transitions.length === 7) {
          const result = validateRhythm(transitions.map(t => t.timestamp));
          const report = generateReport(name, transitions, result, pollLog);
          console.log(report);

          const output = {
            type: 'login-with-anything',
            name,
            status: result.valid ? 'authenticated' : 'denied',
            transitions,
            result,
            report,
            stateLog: stateLog.slice(-80),
            timestamp: Date.now(),
          };
          await signal(output);
          writeFileSync('output/result.json', JSON.stringify(output, null, 2));
          writeFileSync('output/report.txt', report);
          process.exit(result.valid ? 0 : 1);
        }
      }
    }

    await signal({ status: 'timeout', name, transitions: transitions.length });
    process.exit(1);
  }

  return { run };
}
