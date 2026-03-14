// Content script — hooks the real like button on x.com tweet pages
// Overlay shows a rotating beat indicator you can join in with

if (location.hostname === 'x.com' && location.pathname.match(/\/status\/\d+/)) {
  const tweetId = location.pathname.match(/\/status\/(\d+)/)[1];
  init(tweetId);
}

function init(tweetId) {
  // "Shave and-a hair cut ... two bits (rest)"
  //    1    2  +  3    4        6    7    8(rest)
  const T = 1400;
  const BEATS = [0, T, 1.5*T, 2*T, 3*T, 5*T, 6*T];
  const REST = 7 * T; // beat 8 = rest, completes the cycle
  const CYCLE_MS = 8 * T;
  const ALL_POSITIONS = [...BEATS, REST]; // 8 positions on the clock
  const BEAT_FRACS = ALL_POSITIONS.map(b => b / CYCLE_MS);

  let taps = [];
  let listening = false; // only start after runner connects
  let cycleStart = Date.now();
  let animFrame = null;

  const el = document.createElement('div');
  el.id = 'shave-overlay';
  el.innerHTML = `
    <style>
      #shave-overlay {
        position: fixed; bottom: 24px; right: 24px; z-index: 99999;
        background: #161616ee; border: 1px solid #333; border-radius: 14px;
        padding: 16px 20px; width: 220px; font-family: system-ui; color: #e5e5e5;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5); backdrop-filter: blur(8px);
      }
      #shave-overlay .hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
      #shave-overlay .title { font-size: 12px; font-weight: 600; }
      #shave-overlay .close { background: none; border: none; color: #555; font-size: 14px; cursor: pointer; padding: 0; }
      #shave-overlay .close:hover { color: #e5e5e5; }
      #shave-overlay canvas { display: block; margin: 0 auto; }
      #shave-overlay .status { text-align: center; font-size: 11px; color: #888; margin-top: 6px; min-height: 14px; }
      #shave-overlay .result { text-align: center; font-size: 16px; font-weight: 700; margin-top: 2px; min-height: 20px; }
      #shave-overlay .actions { display: flex; justify-content: center; gap: 6px; margin-top: 6px; }
      #shave-overlay .btn { padding: 3px 10px; border-radius: 5px; border: 1px solid #333; background: #1a1a1a; color: #aaa; font-size: 10px; cursor: pointer; }
      #shave-overlay .btn:hover { background: #262626; }
      #shave-overlay .hint { text-align: center; font-size: 9px; color: #555; margin-top: 4px; }
      #shave-overlay .observer { margin-top: 8px; padding: 8px; background: #0d0d0d; border: 1px solid #262626; border-radius: 8px; font-size: 10px; font-family: monospace; color: #888; max-height: 200px; overflow-y: auto; white-space: pre-wrap; display: none; }
      #shave-overlay .observer.active { display: block; }
      #shave-overlay .observer .label { color: #1d9bf0; font-family: system-ui; font-size: 10px; font-weight: 600; margin-bottom: 4px; display: block; }
    </style>
    <div class="hdr">
      <span class="title">Shave and a Haircut</span>
      <button class="close" id="shave-close">&times;</button>
    </div>
    <canvas id="shave-canvas" width="180" height="180" style="display:none"></canvas>
    <div class="status" id="shave-status">Click the like button when the dot hits a marker</div>
    <div class="result" id="shave-result"></div>
    <div class="hint">doot doo-da-loot doot &hellip; doot doot!</div>
    <div class="actions">
      <button class="btn" id="shave-start-observer" style="border-color:#1d9bf0;color:#1d9bf0">Start Observer</button>
      <button class="btn" id="shave-reset">Reset</button>
    </div>
    <div id="shave-config" style="margin-top:6px">
      <input id="shave-pat" type="password" placeholder="GitHub PAT (ghp_...)" style="width:100%;background:#0d0d0d;border:1px solid #262626;border-radius:5px;padding:4px 6px;color:#e5e5e5;font-size:10px;margin-bottom:4px">
      <input id="shave-repo" type="text" value="amiller/login-with-anything" style="width:100%;background:#0d0d0d;border:1px solid #262626;border-radius:5px;padding:4px 6px;color:#888;font-size:10px;margin-bottom:4px">
      <input id="shave-proxy" type="text" placeholder="Proxy URL (ngrok, optional)" style="width:100%;background:#0d0d0d;border:1px solid #262626;border-radius:5px;padding:4px 6px;color:#888;font-size:10px">
    </div>
    <div class="observer" id="shave-observer"></div>
    <canvas id="shave-timeline" width="240" height="50" style="display:none;margin-top:6px;border-radius:6px;background:#0d0d0d;border:1px solid #262626"></canvas>
  `;
  document.body.appendChild(el);

  // Persist config inputs across reloads
  const configKeys = ['shave-pat', 'shave-repo', 'shave-proxy'];
  chrome.storage?.local?.get(configKeys, (saved) => {
    for (const k of configKeys) {
      const input = el.querySelector(`#${k}`);
      if (input && saved[k]) input.value = saved[k];
    }
  });
  for (const k of configKeys) {
    el.querySelector(`#${k}`)?.addEventListener('change', (e) => {
      chrome.storage?.local?.set({ [k]: e.target.value });
    });
    el.querySelector(`#${k}`)?.addEventListener('blur', (e) => {
      chrome.storage?.local?.set({ [k]: e.target.value });
    });
  }

  const canvas = el.querySelector('#shave-canvas');
  const ctx = canvas.getContext('2d');
  const statusEl = el.querySelector('#shave-status');
  const resultEl = el.querySelector('#shave-result');
  const CX = 90, CY = 90, R = 70;

  // Audio
  const audioCtx = new AudioContext();
  function playClick(freq = 800) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);
    osc.start(); osc.stop(audioCtx.currentTime + 0.05);
  }

  let lastClickedBeat = -1;

  function fracToXY(frac, r) {
    const angle = frac * Math.PI * 2 - Math.PI / 2; // 0 = top
    return [CX + Math.cos(angle) * r, CY + Math.sin(angle) * r];
  }

  function draw() {
    const now = Date.now();
    const elapsed = (now - cycleStart) % CYCLE_MS;
    const frac = elapsed / CYCLE_MS;

    ctx.clearRect(0, 0, 180, 180);

    // Draw circle track
    ctx.beginPath();
    ctx.arc(CX, CY, R, 0, Math.PI * 2);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw beat markers (7 beats + 1 rest)
    BEAT_FRACS.forEach((bf, i) => {
      const [x, y] = fracToXY(bf, R);
      const isRest = (i === 7);
      const isLarge = (i === 0 || i === 6);
      const size = isRest ? 4 : (isLarge ? 8 : (i === 2 ? 5 : 6));

      let color;
      if (isRest) {
        color = '#282828'; // dim rest marker
      } else if (i < taps.length) {
        color = '#22c55e';
      } else {
        color = '#444';
      }

      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      if (isRest) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.fill();
      }

      // Label
      ctx.fillStyle = isRest ? '#333' : '#888';
      ctx.font = '9px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const [lx, ly] = fracToXY(bf, R - 18);
      ctx.fillText(isRest ? '·' : String(i + 1), lx, ly);
    });

    // Sweeping dot
    const [sx, sy] = fracToXY(frac, R);
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#1d9bf0';
    ctx.fill();
    // Glow
    ctx.beginPath();
    ctx.arc(sx, sy, 10, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(29,155,240,0.15)';
    ctx.fill();

    // Tick sound when sweeper crosses a beat marker (skip rest)
    for (let i = 0; i < BEAT_FRACS.length; i++) {
      if (i === 7) continue; // rest — no tick
      const bf = BEAT_FRACS[i];
      const dist = Math.abs(frac - bf);
      const wrapped = Math.min(dist, 1 - dist);
      if (wrapped < 0.012 && lastClickedBeat !== i) {
        lastClickedBeat = i;
        playClick(i === 6 ? 1000 : 700);
      }
    }
    const nearAny = BEAT_FRACS.some(bf => { const d = Math.abs(frac - bf); return Math.min(d, 1 - d) < 0.025; });
    if (!nearAny) lastClickedBeat = -1;

    // Center text
    if (taps.length > 0 && taps.length < 7) {
      ctx.fillStyle = '#e5e5e5';
      ctx.font = 'bold 20px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(`${taps.length}/7`, CX, CY + 6);
    }

    if (listening) animFrame = requestAnimationFrame(draw);
  }

  function reset() {
    taps = [];
    listening = true;
    cycleStart = Date.now();
    lastClickedBeat = -1;
    serverTaps.length = 0;
    statusEl.textContent = 'Click the like button when the dot hits a marker';
    statusEl.style.color = '#888';
    resultEl.textContent = '';
    observerEl.classList.remove('active');
    observerEl.innerHTML = '';
    el.querySelector('#shave-config').style.display = '';
    const obsBtn = el.querySelector('#shave-start-observer');
    obsBtn.disabled = false;
    obsBtn.textContent = 'Start Observer';
    obsBtn.style.borderColor = '#1d9bf0';
    obsBtn.style.color = '#1d9bf0';
    // Restart animation
    if (animFrame) cancelAnimationFrame(animFrame);
    animFrame = null;
    draw();
  }

  function validateRhythm(timestamps) {
    if (timestamps.length !== 7) return { valid: false, reason: `Need 7, got ${timestamps.length}` };
    const t = timestamps.map(ts => ts - timestamps[0]);
    const scale = t[6] / BEATS[6];
    if (scale < 0.3 || scale > 5) return { valid: false, reason: 'Tempo way off' };
    const tolerance = 200 * scale;
    const errors = [];
    for (let i = 1; i < 7; i++) {
      if (Math.abs(t[i] - BEATS[i] * scale) > tolerance) errors.push(i + 1);
    }
    if (errors.length) return { valid: false, reason: `Off at beat${errors.length > 1 ? 's' : ''} ${errors.join(', ')}`, errors };
    return { valid: true, scale, duration: t[6] };
  }

  const observerEl = el.querySelector('#shave-observer');

  // Send tap directly to the runner's tap server
  async function notifyTap(tapIndex) {
    if (!tapServerUrl) return null;
    try {
      const res = await fetch(`${tapServerUrl}/tap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
        body: JSON.stringify({ tap: tapIndex + 1, client_ts: Date.now() }),
      });
      return await res.json();
    } catch (e) {
      console.error('Tap notify failed:', e);
      return { error: e.message };
    }
  }

  // Server tap observations for time series
  const serverTaps = [];
  const tlCanvas = el.querySelector('#shave-timeline');
  const tlCtx = tlCanvas.getContext('2d');

  function drawObserverTimeline() {
    if (!serverTaps.length) return;
    tlCanvas.style.display = 'block';
    observerEl.classList.add('active');

    const W = tlCanvas.width, H = tlCanvas.height;
    tlCtx.clearRect(0, 0, W, H);

    const t0 = serverTaps[0].client_ts;
    const tEnd = serverTaps[serverTaps.length - 1].client_ts;
    const range = Math.max(tEnd - t0, 1000);
    const pad = 4;

    // Background
    tlCtx.fillStyle = '#0d0d0d';
    tlCtx.fillRect(0, 0, W, H);

    // Draw liked/unliked regions
    for (let i = 0; i < serverTaps.length; i++) {
      const s = serverTaps[i];
      const x = pad + ((s.client_ts - t0) / range) * (W - 2 * pad);
      const nextX = (i + 1 < serverTaps.length)
        ? pad + ((serverTaps[i + 1].client_ts - t0) / range) * (W - 2 * pad)
        : W - pad;

      // Filled region: top half = liked, bottom half = unliked
      const y = s.liked ? pad : H / 2;
      const h = H / 2 - pad;
      tlCtx.fillStyle = s.liked ? 'rgba(239,68,68,0.25)' : 'rgba(100,100,100,0.15)';
      tlCtx.fillRect(x, y, nextX - x, h);
    }

    // Center line
    tlCtx.strokeStyle = '#333';
    tlCtx.lineWidth = 1;
    tlCtx.beginPath();
    tlCtx.moveTo(pad, H / 2);
    tlCtx.lineTo(W - pad, H / 2);
    tlCtx.stroke();

    // Draw tap dots and step line
    tlCtx.strokeStyle = '#1d9bf0';
    tlCtx.lineWidth = 1.5;
    tlCtx.beginPath();
    for (let i = 0; i < serverTaps.length; i++) {
      const s = serverTaps[i];
      const x = pad + ((s.client_ts - t0) / range) * (W - 2 * pad);
      const y = s.liked ? H * 0.25 : H * 0.75;
      if (i === 0) tlCtx.moveTo(x, y); else tlCtx.lineTo(x, y);

      // Dot
      tlCtx.fillStyle = s.changed ? '#22c55e' : (s.error ? '#ef4444' : '#1d9bf0');
      tlCtx.fillRect(x - 3, y - 3, 6, 6);
    }
    tlCtx.stroke();

    // Labels
    tlCtx.fillStyle = '#666';
    tlCtx.font = '8px system-ui';
    tlCtx.textAlign = 'left';
    tlCtx.fillText('\u2665 liked', pad, 10);
    tlCtx.fillText('\u2661 unliked', pad, H - 3);
    tlCtx.textAlign = 'right';
    tlCtx.fillText(`${serverTaps.length}/7 taps`, W - pad, 10);

    // Show result text
    const last = serverTaps[serverTaps.length - 1];
    if (last.result) {
      const r = last.result;
      observerEl.innerHTML = `<span class="label">Observer: ${last.status?.toUpperCase()}</span>` +
        (r.valid ? `Duration: ${(r.duration/1000).toFixed(1)}s Tempo: ${r.scale.toFixed(2)}x` : r.reason);
    } else {
      observerEl.innerHTML = `<span class="label">Observer</span>${serverTaps.length}/7 verified`;
    }
  }

  function onLikeClick(e) {
    if (!listening || taps.length >= 7) return;

    taps.push(Date.now());
    const i = taps.length;
    const btn = e.currentTarget;
    const wasLiked = btn.getAttribute('data-testid') === 'unlike';
    statusEl.textContent = `${i}/7: ${wasLiked ? 'unliked' : 'liked'}`;

    // Send tap to runner and draw time series
    notifyTap(taps.length - 1).then(resp => {
      if (!resp) return;
      serverTaps.push({ ...resp, client_ts: Date.now() });
      drawObserverTimeline();
    });

    if (taps.length === 7) {
      const v = validateRhythm(taps);
      listening = false;
      if (v.valid) {
        resultEl.textContent = 'AUTHENTICATED';
        resultEl.style.color = '#22c55e';
        statusEl.textContent = `${(v.duration / 1000).toFixed(1)}s at ${v.scale.toFixed(2)}x`;
      } else {
        resultEl.textContent = 'DENIED';
        resultEl.style.color = '#ef4444';
        statusEl.textContent = v.reason;
      }
      draw();
    }
  }

  // Hook the like button
  let hooked = null;
  function hookLikeButton() {
    const article = document.querySelector('article[data-testid="tweet"]');
    if (!article) return;
    const btn = article.querySelector('[data-testid="like"], [data-testid="unlike"]');
    if (!btn || btn === hooked) return;
    if (hooked) hooked.removeEventListener('click', onLikeClick);
    btn.addEventListener('click', onLikeClick);
    hooked = btn;
  }

  const observer = new MutationObserver(hookLikeButton);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-testid'] });
  hookLikeButton();

  // Store the runner's tap server URL once connected
  let tapServerUrl = null;

  el.querySelector('#shave-start-observer').addEventListener('click', async () => {
    const btn = el.querySelector('#shave-start-observer');
    btn.disabled = true;
    btn.textContent = 'Starting...';
    observerEl.classList.add('active');

    try {
      const ghToken = el.querySelector('#shave-pat').value.trim();
      const repo = el.querySelector('#shave-repo').value.trim();
      if (!ghToken) throw new Error('Paste a GitHub PAT first');
      el.dataset.ghToken = ghToken;

      // Create a gist for the runner to signal its tunnel URL
      observerEl.innerHTML = '<span class="label">Observer</span>Creating signal gist...';
      const gistRes = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${ghToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: 'login-with-anything signal',
          public: false,
          files: { 'status.json': { content: JSON.stringify({status: 'waiting'}) } },
        }),
      });
      if (!gistRes.ok) throw new Error(`Gist creation failed: ${gistRes.status}`);
      const gistId = (await gistRes.json()).id;

      // Dispatch the workflow with gist_id
      observerEl.innerHTML = '<span class="label">Observer</span>Dispatching workflow...';
      const dispatchRes = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/twitter-like.yml/dispatches`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${ghToken}`, 'Accept': 'application/vnd.github.v3+json' },
        body: JSON.stringify({ ref: 'main', inputs: { tweet_id: tweetId, gist_id: gistId } }),
      });
      if (!dispatchRes.ok) throw new Error(`Dispatch failed: ${dispatchRes.status}`);
      btn.textContent = 'Dispatched';
      el.querySelector('#shave-config').style.display = 'none';

      // Wait for runner to write tunnel URL to gist
      let tunnelUrl = null;
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const elapsed = (i + 1) * 3;
        observerEl.innerHTML = `<span class="label">Observer</span>Waiting for runner... ${elapsed}s`;
        const gRes = await fetch(`https://api.github.com/gists/${gistId}`, {
          headers: { 'Authorization': `Bearer ${ghToken}` },
        });
        if (!gRes.ok) continue;
        const gData = await gRes.json();
        const content = gData.files?.['status.json']?.content;
        if (!content) continue;
        const status = JSON.parse(content);
        if (status.tunnel) { tunnelUrl = status.tunnel; break; }
      }
      if (!tunnelUrl) throw new Error('Runner did not provide tunnel URL');

      tapServerUrl = tunnelUrl;
      btn.textContent = 'Connected';
      btn.style.borderColor = '#22c55e';
      btn.style.color = '#22c55e';

      // Show the clock and enable tapping
      el.querySelector('#shave-canvas').style.display = '';
      listening = true;
      cycleStart = Date.now();
      if (animFrame) cancelAnimationFrame(animFrame);
      animFrame = null;
      draw();

      observerEl.innerHTML = `<span class="label">Observer</span>Connected to runner!\nTunnel: ${tunnelUrl}\nClick the like button in rhythm now.`;

    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Start Observer';
      observerEl.innerHTML = `<span class="label">Observer</span>${e.message}`;
    }
  });

  el.querySelector('#shave-reset').addEventListener('click', reset);
  el.querySelector('#shave-close').addEventListener('click', () => {
    observer.disconnect();
    listening = false;
    if (animFrame) cancelAnimationFrame(animFrame);
    el.remove();
  });

  // Start the animation loop
  draw();
}
