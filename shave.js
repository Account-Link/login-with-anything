// "Shave and a Haircut" rhythm authentication

const PATTERN = [0, 1000, 2000, 2500, 3000, 5000, 6000];
const ACTIONS = ['like', 'unlike', 'like', 'unlike', 'like', 'unlike', 'like'];

function validateRhythm(timestamps) {
  if (timestamps.length !== 7) return {valid: false, reason: `Need 7 taps, got ${timestamps.length}`};
  const t = timestamps.map(ts => ts - timestamps[0]);
  const scale = t[6] / PATTERN[6];
  if (scale < 0.3 || scale > 5) return {valid: false, reason: 'Tempo way off'};
  const tolerance = 250 * scale;
  const errors = [];
  for (let i = 1; i < 7; i++) {
    const delta = Math.abs(t[i] - PATTERN[i] * scale);
    if (delta > tolerance) errors.push(i + 1);
  }
  if (errors.length) return {valid: false, reason: `Off rhythm at beat${errors.length > 1 ? 's' : ''} ${errors.join(', ')}`, errors};
  return {valid: true, scale, duration: t[6]};
}

function parseTweetId(input) {
  const m = input.match(/status\/(\d+)/);
  if (m) return m[1];
  if (/^\d+$/.test(input.trim())) return input.trim();
  return null;
}

// --- UI ---

const $ = id => document.getElementById(id);
const dots = document.querySelectorAll('.beat[data-i]');

let taps = [];
let tweetId = null;
let busy = false;
let mode = 'local';

function resetUI() {
  taps = [];
  busy = false;
  $('result').textContent = '';
  $('result').style.color = '';
  $('tap-btn').disabled = !tweetId;
  dots.forEach(d => { d.className = 'beat' + (d.dataset.i === '3' ? ' small' : d.dataset.i === '6' ? ' big' : ''); });
  updateStatus();
}

function updateStatus() {
  if (!tweetId) { $('status').textContent = 'Enter a tweet to begin'; return; }
  $('status').textContent = `Ready — ${taps.length}/7 taps`;
}

function lightDot(i, cls) {
  const d = document.querySelector(`.beat[data-i="${i}"]`);
  if (d) d.classList.add(cls);
}

$('tweet-input').addEventListener('input', e => {
  tweetId = parseTweetId(e.target.value);
  $('tap-btn').disabled = !tweetId;
  updateStatus();
});

$('mode-select').addEventListener('change', e => {
  mode = e.target.value;
  $('runner-status').style.display = mode === 'github' ? 'block' : 'none';
});

$('open-tweet-btn').addEventListener('click', async () => {
  if (!tweetId) return;
  const granted = await chrome.permissions.request({origins: ['https://*.x.com/*']});
  if (!granted) return;
  const tabId = await ensureXTab();
  await chrome.tabs.update(tabId, {url: `https://x.com/i/status/${tweetId}`, active: true});
});

$('reset-btn').addEventListener('click', resetUI);

$('tap-btn').addEventListener('click', async () => {
  if (busy || !tweetId || taps.length >= 7) return;
  busy = true;

  const i = taps.length;
  lightDot(i, 'pending');
  $('status').textContent = `Tap ${i + 1}/7: ${ACTIONS[i]}...`;

  try {
    const granted = await chrome.permissions.request({origins: ['https://*.x.com/*']});
    if (!granted) throw new Error('Permission denied');

    const result = await clickLikeButton(tweetId);
    taps.push(Date.now());
    lightDot(i, 'hit');
    dots.querySelector?.(`.beat[data-i="${i}"]`)?.classList.remove('pending');
    // remove pending, keep hit
    const dot = document.querySelector(`.beat[data-i="${i}"]`);
    if (dot) dot.classList.remove('pending');

    $('status').textContent = `Tap ${i + 1}/7: ${result.nowLiked ? 'liked' : 'unliked'}`;

    if (taps.length === 7) {
      const v = validateRhythm(taps);
      if (v.valid) {
        $('result').textContent = 'AUTHENTICATED';
        $('result').style.color = '#22c55e';
        $('status').textContent = `Rhythm matched! ${(v.duration / 1000).toFixed(1)}s at ${v.scale.toFixed(2)}x tempo`;
        $('tap-btn').disabled = true;

        if (mode === 'github') {
          $('status').textContent += ' — submitting to GitHub Actions...';
          // TODO: submit tap log to workflow for attestation
        }
      } else {
        $('result').textContent = 'DENIED';
        $('result').style.color = '#ef4444';
        $('status').textContent = v.reason;
        if (v.errors) v.errors.forEach(e => lightDot(e - 1, 'miss'));
      }
    }
  } catch (e) {
    lightDot(i, 'miss');
    const dot = document.querySelector(`.beat[data-i="${i}"]`);
    if (dot) dot.classList.remove('pending');
    $('status').textContent = `Error: ${e.message}`;
    $('status').style.color = '#ef4444';
  }
  busy = false;
});

resetUI();
