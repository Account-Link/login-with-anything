// End-to-end test: inject cookies into the test browser via CDP,
// navigate to the deployed forum, click "Login with Extension", and
// verify that the full flow (extension content script → cookie grab →
// verify-cookie → TEE browser → identity extraction) works.
//
// Prerequisites:
//   - test-chrome container running (cd test && docker compose up -d)
//   - ws module installed in container (docker exec test-chrome npm install --prefix /tmp ws)
//   - extension's manifest switched to host_permissions (see below)
//   - cookies file at /tmp/cookies.json inside the container
//
// The extension mounts from ../extension/ as a volume. Its manifest has
// optional_host_permissions which means cookies aren't readable until the
// user grants permission interactively. For automated testing, the test
// temporarily switches to host_permissions (auto-granted) by modifying
// the mounted manifest and restarting chromium:
//
//   docker exec test-chrome python3 -c "
//     import json
//     m = json.load(open('/usr/share/chromium/extensions/lwa/manifest.json'))
//     m['host_permissions'] = ['<all_urls>']
//     m.pop('optional_host_permissions', None)
//     json.dump(m, open('/usr/share/chromium/extensions/lwa/manifest.json','w'), indent=2)
//   "
//   docker exec test-chrome supervisorctl restart chromium
//   sleep 5
//
// After testing, restore the manifest:
//   git checkout extension/manifest.json

import { WebSocket } from 'ws';
import http from 'http';
import fs from 'fs';

const FORUM = process.env.FORUM_URL || 'https://d36facf2a9d92be3c1e554240861a27fcf5fcf31-3003.dstack-pha-prod7.phala.network';
const COOKIES = JSON.parse(fs.readFileSync('/tmp/cookies.json', 'utf8'));
const BOARD_INDEX = parseInt(process.env.BOARD_INDEX || '2'); // 0=anthropic, 1=github, 2=reddit, 3=wordle

async function getWsUrl() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json/list', res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)[0].webSocketDebuggerUrl));
    }).on('error', reject);
  });
}

const ws = new WebSocket(await getWsUrl());
await new Promise(r => ws.on('open', r));

function cdp(method, params = {}) {
  const id = Math.floor(Math.random() * 1e6);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${method} timeout`)), 15000);
    const h = (raw) => { const m = JSON.parse(raw); if (m.id === id) { clearTimeout(t); ws.off('message', h); resolve(m.result || m.error); } };
    ws.on('message', h);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// 1. Inject cookies
await cdp('Network.enable');
let ok = 0;
for (const c of COOKIES) {
  const r = await cdp('Network.setCookie', {
    name: c.name, value: c.value, domain: c.domain,
    path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly,
    url: `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`
  });
  if (r.success) ok++;
}
console.log(`Injected ${ok}/${COOKIES.length} cookies`);

// 2. Navigate to forum
console.log(`Navigating to ${FORUM}`);
await cdp('Page.navigate', { url: FORUM });
await new Promise(r => setTimeout(r, 6000));

// 3. Check extension detected
const state = await cdp('Runtime.evaluate', {
  expression: `JSON.stringify({ext: typeof extensionInstalled !== 'undefined' ? extensionInstalled : false, boards: document.querySelectorAll('.board').length})`
});
const s = JSON.parse(state.result?.value || '{}');
console.log(`Extension: ${s.ext ? 'detected' : 'NOT detected'}, boards: ${s.boards}`);
if (!s.ext) { console.log('FAIL: extension not detected'); process.exit(1); }

// 4. Click board
await cdp('Runtime.evaluate', { expression: `document.querySelectorAll('.board')[${BOARD_INDEX}]?.click()` });
await new Promise(r => setTimeout(r, 2000));

// 5. Check for extension button
const btn = await cdp('Runtime.evaluate', {
  expression: `document.querySelector('button[onclick*="verifyWithExtension"]')?.textContent?.trim() || 'NOT FOUND'`
});
console.log(`Button: ${btn.result?.value}`);
if (btn.result?.value === 'NOT FOUND') { console.log('FAIL: no extension button'); process.exit(1); }

// 6. Click and wait for result
console.log('Clicking Login with Extension...');
await cdp('Runtime.evaluate', { expression: `document.querySelector('button[onclick*="verifyWithExtension"]').click()` });

for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 2000));
  const auth = await cdp('Runtime.evaluate', {
    expression: `document.getElementById('authBar')?.textContent?.trim() || ''`
  });
  const status = await cdp('Runtime.evaluate', {
    expression: `document.getElementById('loginStatus')?.textContent?.trim() || ''`
  });
  const a = auth.result?.value;
  const st = status.result?.value;
  if (a) { console.log(`PASS: ${a}`); break; }
  if (st && !st.includes('Grabbing') && !st.includes('Verifying') && !st.includes('Got')) {
    console.log(`FAIL: ${st}`);
    process.exit(1);
  }
  if (i === 19) { console.log('FAIL: timeout waiting for verification'); process.exit(1); }
}

// 7. Screenshot
const shot = await cdp('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/test-result.png', Buffer.from(shot.data, 'base64'));
console.log('Screenshot: /tmp/test-result.png');

ws.close();
