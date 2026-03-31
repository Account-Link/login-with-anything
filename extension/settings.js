async function renderSettings() {
  const el = document.getElementById('settings-content');
  const { dietSettings, weeklyWrapped, accountEmail } = await chrome.storage.local.get(['dietSettings', 'weeklyWrapped', 'accountEmail']);
  const s = dietSettings || { enabled: true, notificationsEnabled: true, shortsAlerts: true, thresholds: [5, 15, 30], anthropicKey: '' };
  const wrappedEnabled = weeklyWrapped?.enabled || false;

  el.innerHTML = `
    <div class="card">
      <h2 style="margin:0 0 16px">Diet Tracking</h2>
      <label class="setting-row"><input type="checkbox" id="s-enabled" ${s.enabled ? 'checked' : ''}> Enable time tracking</label>
      <label class="setting-row"><input type="checkbox" id="s-notifications" ${s.notificationsEnabled ? 'checked' : ''}> Browser notifications</label>
      <label class="setting-row"><input type="checkbox" id="s-shorts" ${s.shortsAlerts ? 'checked' : ''}> Shorts/Reels alerts</label>
      <div class="setting-row">
        <label style="margin-right:8px">Alert thresholds (minutes):</label>
        <input type="text" id="s-thresholds" value="${s.thresholds.join(', ')}"
          style="background:#1a1a1a;color:#e5e5e5;border:1px solid #333;border-radius:6px;padding:6px 10px;font-size:13px;width:160px">
      </div>
    </div>
    <div class="card">
      <h2 style="margin:0 0 16px">AI Roast (Optional)</h2>
      <p style="color:#888;font-size:12px;margin-bottom:12px">Paste an Anthropic API key to get personalized roasts when you doom-scroll. Uses Claude Haiku (~$0.001/roast).</p>
      <input type="password" id="s-apikey" value="${esc(s.anthropicKey || '')}" placeholder="sk-ant-..."
        style="background:#1a1a1a;color:#e5e5e5;border:1px solid #333;border-radius:6px;padding:6px 10px;font-size:13px;width:100%">
    </div>
    <div class="card">
      <h2 style="margin:0 0 16px">Weekly Wrapped</h2>
      <p style="color:#888;font-size:12px;margin-bottom:12px">Get a weekly email digest with your screen time, shorts usage, and watch history stats. Requires a linked account email.</p>
      <label class="setting-row"><input type="checkbox" id="s-wrapped" ${wrappedEnabled ? 'checked' : ''}> Enable Weekly Wrapped emails</label>
      <div style="font-size:12px;color:#555;margin-top:8px">${accountEmail ? `Email: ${esc(accountEmail)}` : 'No email linked — set one in the popup.'}</div>
    </div>
    <div class="card">
      <h2 style="margin:0 0 16px">Push Alerts</h2>
      <p style="color:#888;font-size:12px;margin-bottom:12px">Get alerts on your phone or other devices, even when Chrome is closed.</p>
      <button class="btn primary" id="s-push">Get alerts on your phone</button>
      <span id="s-push-status" style="font-size:12px;margin-left:12px"></span>
    </div>
    <button class="btn primary" id="s-save">Save Settings</button>
    <span id="s-saved" style="color:#22c55e;font-size:12px;margin-left:12px;display:none">Saved</span>
  `;

  document.getElementById('s-save').onclick = async () => {
    const thresholds = document.getElementById('s-thresholds').value.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n)).sort((a, b) => a - b);
    await chrome.storage.local.set({ weeklyWrapped: { enabled: document.getElementById('s-wrapped').checked } });
    await chrome.storage.local.set({ dietSettings: {
      enabled: document.getElementById('s-enabled').checked,
      notificationsEnabled: document.getElementById('s-notifications').checked,
      shortsAlerts: document.getElementById('s-shorts').checked,
      thresholds: thresholds.length ? thresholds : [5, 15, 30],
      anthropicKey: document.getElementById('s-apikey').value.trim()
    }});
    const saved = document.getElementById('s-saved');
    saved.style.display = 'inline';
    setTimeout(() => saved.style.display = 'none', 2000);
  };

  const { pushRegistered } = await chrome.storage.local.get('pushRegistered');
  const pushStatus = document.getElementById('s-push-status');
  if (pushRegistered) {
    document.getElementById('s-push').disabled = true;
    pushStatus.style.color = '#22c55e';
    pushStatus.textContent = 'Registered';
  }
  document.getElementById('s-push').onclick = async () => {
    pushStatus.style.color = '#888';
    pushStatus.textContent = 'Registering...';
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'registerPush' });
      if (resp?.error) throw new Error(resp.error);
      pushStatus.style.color = '#22c55e';
      pushStatus.textContent = 'Registered!';
      document.getElementById('s-push').disabled = true;
    } catch (e) {
      pushStatus.style.color = '#ef4444';
      pushStatus.textContent = e.message || 'Failed';
    }
  };
}
