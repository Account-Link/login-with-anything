// Content script — hooks the real like button on x.com tweet pages
// Like/unlike 3 times to authenticate via GitHub Actions observer

if (location.hostname === 'x.com' && location.pathname.match(/\/status\/\d+/)) {
  init(location.pathname.match(/\/status\/(\d+)/)[1]);
}

function init(tweetId) {
  const REQUIRED = 3;
  let listening = false;
  let tapServerUrl = null;
  const serverTaps = [];

  const el = document.createElement('div');
  el.id = 'shave-overlay';
  el.innerHTML = `
    <style>
      #shave-overlay { position:fixed; bottom:24px; right:24px; z-index:99999; background:#161616ee; border:1px solid #333; border-radius:14px; padding:16px 20px; width:260px; font-family:system-ui; color:#e5e5e5; box-shadow:0 8px 32px rgba(0,0,0,0.5); backdrop-filter:blur(8px); }
      #shave-overlay .hdr { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
      #shave-overlay .title { font-size:13px; font-weight:600; }
      #shave-overlay .close { background:none; border:none; color:#555; font-size:14px; cursor:pointer; }
      #shave-overlay .dots { display:flex; justify-content:center; gap:12px; margin:12px 0; }
      #shave-overlay .dot { width:24px; height:24px; border-radius:50%; border:2px solid #444; transition:all 0.2s; }
      #shave-overlay .dot.hit { background:#22c55e; border-color:#22c55e; }
      #shave-overlay .status { text-align:center; font-size:11px; color:#888; margin-top:6px; min-height:14px; }
      #shave-overlay .result { text-align:center; font-size:18px; font-weight:700; margin-top:4px; min-height:24px; }
      #shave-overlay .actions { display:flex; justify-content:center; gap:6px; margin-top:8px; }
      #shave-overlay .btn { padding:4px 12px; border-radius:5px; border:1px solid #333; background:#1a1a1a; color:#aaa; font-size:10px; cursor:pointer; }
      #shave-overlay .btn:hover { background:#262626; }
      #shave-overlay .observer { margin-top:8px; padding:8px; background:#0d0d0d; border:1px solid #262626; border-radius:8px; font-size:10px; font-family:monospace; color:#888; white-space:pre-wrap; display:none; }
      #shave-overlay .observer.active { display:block; }
      #shave-overlay .observer .label { color:#1d9bf0; font-family:system-ui; font-size:10px; font-weight:600; display:block; margin-bottom:4px; }
    </style>
    <div class="hdr">
      <span class="title">Log in with Twitter Like</span>
      <button class="close" id="shave-close">&times;</button>
    </div>
    <div class="dots">
      <div class="dot" data-i="0"></div>
      <div class="dot" data-i="1"></div>
      <div class="dot" data-i="2"></div>
    </div>
    <div class="status" id="shave-status">Like/unlike this tweet 3 times to authenticate</div>
    <div class="result" id="shave-result"></div>
    <div class="actions">
      <button class="btn" id="shave-start-observer" style="border-color:#1d9bf0;color:#1d9bf0">Start Observer</button>
      <button class="btn" id="shave-reset">Reset</button>
    </div>
    <div id="shave-config" style="margin-top:6px">
      <input id="shave-pat" type="password" placeholder="GitHub PAT (ghp_...)" style="width:100%;background:#0d0d0d;border:1px solid #262626;border-radius:5px;padding:4px 6px;color:#e5e5e5;font-size:10px;margin-bottom:4px">
      <input id="shave-repo" type="text" value="amiller/login-with-anything" style="width:100%;background:#0d0d0d;border:1px solid #262626;border-radius:5px;padding:4px 6px;color:#888;font-size:10px">
    </div>
    <div class="observer" id="shave-observer"></div>
    <canvas id="shave-timeline" width="240" height="60" style="display:none;margin-top:6px;border-radius:6px"></canvas>
  `;
  document.body.appendChild(el);

  // Persist config
  const configKeys = ['shave-pat', 'shave-repo'];
  chrome.storage?.local?.get(configKeys, (saved) => {
    for (const k of configKeys) { const input = el.querySelector(`#${k}`); if (input && saved?.[k]) input.value = saved[k]; }
  });
  for (const k of configKeys) {
    el.querySelector(`#${k}`)?.addEventListener('blur', (e) => chrome.storage?.local?.set({ [k]: e.target.value }));
  }

  const statusEl = el.querySelector('#shave-status');
  const resultEl = el.querySelector('#shave-result');
  const observerEl = el.querySelector('#shave-observer');
  const tlCanvas = el.querySelector('#shave-timeline');
  const tlCtx = tlCanvas.getContext('2d');
  const dots = el.querySelectorAll('.dot');

  function reset() {
    listening = false;
    tapServerUrl = null;
    serverTaps.length = 0;
    statusEl.textContent = 'Like/unlike this tweet 3 times to authenticate';
    statusEl.style.color = '#888';
    resultEl.textContent = '';
    observerEl.classList.remove('active');
    observerEl.innerHTML = '';
    tlCanvas.style.display = 'none';
    dots.forEach(d => d.classList.remove('hit'));
    el.querySelector('#shave-config').style.display = '';
    const obsBtn = el.querySelector('#shave-start-observer');
    obsBtn.disabled = false;
    obsBtn.textContent = 'Start Observer';
    obsBtn.style.borderColor = '#1d9bf0';
    obsBtn.style.color = '#1d9bf0';
  }

  // Send tap to runner
  async function notifyTap() {
    if (!tapServerUrl) return null;
    try {
      const res = await fetch(`${tapServerUrl}/tap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
        body: JSON.stringify({ tap: serverTaps.length + 1, client_ts: Date.now() }),
      });
      return await res.json();
    } catch (e) { return { error: e.message }; }
  }

  function drawTimeline() {
    if (!serverTaps.length) return;
    tlCanvas.style.display = 'block';
    const W = tlCanvas.width, H = tlCanvas.height;
    tlCtx.clearRect(0, 0, W, H);
    tlCtx.fillStyle = '#0d0d0d';
    tlCtx.fillRect(0, 0, W, H);

    const t0 = serverTaps[0].client_ts;
    const range = Math.max((serverTaps[serverTaps.length - 1].client_ts) - t0, 1000);
    const pad = 4;

    // Step regions
    for (let i = 0; i < serverTaps.length; i++) {
      const s = serverTaps[i];
      const x = pad + ((s.client_ts - t0) / range) * (W - 2*pad);
      const nx = (i+1 < serverTaps.length) ? pad + ((serverTaps[i+1].client_ts - t0) / range) * (W - 2*pad) : W - pad;
      tlCtx.fillStyle = s.liked ? 'rgba(239,68,68,0.3)' : 'rgba(100,100,100,0.15)';
      tlCtx.fillRect(x, s.liked ? pad : H/2, nx - x, H/2 - pad);
    }

    // Center line
    tlCtx.strokeStyle = '#333';
    tlCtx.beginPath(); tlCtx.moveTo(pad, H/2); tlCtx.lineTo(W-pad, H/2); tlCtx.stroke();

    // Step line + dots
    tlCtx.strokeStyle = '#1d9bf0'; tlCtx.lineWidth = 1.5; tlCtx.beginPath();
    for (let i = 0; i < serverTaps.length; i++) {
      const s = serverTaps[i];
      const x = pad + ((s.client_ts - t0) / range) * (W - 2*pad);
      const y = s.liked ? H*0.25 : H*0.75;
      if (i === 0) tlCtx.moveTo(x, y); else tlCtx.lineTo(x, y);
      tlCtx.fillStyle = s.changed ? '#22c55e' : '#1d9bf0';
      tlCtx.fillRect(x-3, y-3, 6, 6);
    }
    tlCtx.stroke();

    // Labels
    tlCtx.fillStyle = '#555'; tlCtx.font = '8px system-ui';
    tlCtx.textAlign = 'left'; tlCtx.fillText('\u2665 liked', pad, 10);
    tlCtx.fillText('\u2661 unliked', pad, H-3);
    const changes = serverTaps.filter(s => s.changed).length;
    tlCtx.textAlign = 'right'; tlCtx.fillText(`${changes}/${REQUIRED} changes`, W-pad, 10);
  }

  function onLikeClick(e) {
    if (!listening) return;
    const changes = serverTaps.filter(s => s.changed).length;
    if (changes >= REQUIRED) return;

    statusEl.textContent = 'Verifying...';
    notifyTap().then(resp => {
      if (!resp) return;
      serverTaps.push({ ...resp, client_ts: Date.now() });
      drawTimeline();

      const newChanges = serverTaps.filter(s => s.changed).length;
      // Light up dots for each verified change
      dots.forEach((d, i) => { if (i < newChanges) d.classList.add('hit'); });
      statusEl.textContent = `${newChanges}/${REQUIRED} state changes verified`;

      if (resp.status === 'authenticated') {
        listening = false;
        resultEl.textContent = 'AUTHENTICATED';
        resultEl.style.color = '#22c55e';
        statusEl.textContent = `Verified by GitHub Actions in ${(resp.result.duration/1000).toFixed(1)}s`;
        observerEl.classList.add('active');
        observerEl.innerHTML = `<span class="label">Observer: AUTHENTICATED</span>` +
          `${resp.result.changes} state changes in ${(resp.result.duration/1000).toFixed(1)}s\n` +
          `Tweet: ${tweetId}\n` +
          `Run: github.com/amiller/login-with-anything/actions`;
      } else if (resp.status === 'denied') {
        listening = false;
        resultEl.textContent = 'DENIED';
        resultEl.style.color = '#ef4444';
        statusEl.textContent = resp.result?.reason || 'Failed';
      } else if (resp.error) {
        statusEl.textContent = `Error: ${resp.error}`;
      }
    });
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
  const obs = new MutationObserver(hookLikeButton);
  obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-testid'] });
  hookLikeButton();

  // Start Observer button
  el.querySelector('#shave-start-observer').addEventListener('click', async () => {
    const btn = el.querySelector('#shave-start-observer');
    btn.disabled = true;
    btn.textContent = 'Starting...';
    observerEl.classList.add('active');

    try {
      const ghToken = el.querySelector('#shave-pat').value.trim();
      const repo = el.querySelector('#shave-repo').value.trim();
      if (!ghToken) throw new Error('Paste a GitHub PAT first');

      observerEl.innerHTML = '<span class="label">Observer</span>Creating gist...';
      const gistRes = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${ghToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'login-with-anything signal', public: false, files: { 'status.json': { content: '{"status":"waiting"}' } } }),
      });
      if (!gistRes.ok) throw new Error(`Gist: ${gistRes.status}`);
      const gistId = (await gistRes.json()).id;

      observerEl.innerHTML = '<span class="label">Observer</span>Dispatching workflow...';
      const dispatchRes = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/twitter-like.yml/dispatches`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${ghToken}`, 'Accept': 'application/vnd.github.v3+json' },
        body: JSON.stringify({ ref: 'main', inputs: { tweet_id: tweetId, gist_id: gistId } }),
      });
      if (!dispatchRes.ok) throw new Error(`Dispatch: ${dispatchRes.status}`);
      btn.textContent = 'Dispatched';
      el.querySelector('#shave-config').style.display = 'none';

      // Wait for runner to write tunnel URL to gist
      let tunnelUrl = null;
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 3000));
        observerEl.innerHTML = `<span class="label">Observer</span>Waiting for runner... ${(i+1)*3}s`;
        try {
          const g = await (await fetch(`https://api.github.com/gists/${gistId}`, { headers: { 'Authorization': `Bearer ${ghToken}` } })).json();
          const s = JSON.parse(g.files?.['status.json']?.content || '{}');
          if (s.tunnel) { tunnelUrl = s.tunnel; break; }
        } catch {}
      }
      if (!tunnelUrl) throw new Error('Runner did not start');

      tapServerUrl = tunnelUrl;
      listening = true;
      btn.textContent = 'Connected';
      btn.style.borderColor = '#22c55e';
      btn.style.color = '#22c55e';
      observerEl.innerHTML = '<span class="label">Observer</span>Connected! Click the like button 3 times.';

    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Start Observer';
      observerEl.innerHTML = `<span class="label">Observer</span>${e.message}`;
    }
  });

  el.querySelector('#shave-reset').addEventListener('click', reset);
  el.querySelector('#shave-close').addEventListener('click', () => { obs.disconnect(); el.remove(); });
}
