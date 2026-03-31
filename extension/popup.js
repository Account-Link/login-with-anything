const $ = id => document.getElementById(id);

let trackedSites = [];
let currentDomain = null;

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) {
    try { currentDomain = new URL(tab.url).hostname.replace(/^www\./, ''); } catch {}
  }

  const stored = await chrome.storage.local.get('trackedSites');
  trackedSites = stored.trackedSites || [];

  render();

  if (!currentDomain || currentDomain.startsWith('chrome') || trackedSites.some(s => s.domain === currentDomain)) {
    $('add').disabled = true;
    if (trackedSites.some(s => s.domain === currentDomain)) $('add').textContent = 'Already tracking';
  }
}

function render() {
  const container = $('sites');
  container.innerHTML = '';
  $('empty').style.display = trackedSites.length ? 'none' : 'block';

  for (const site of trackedSites) {
    const row = document.createElement('div');
    row.className = 'site';

    const dot = document.createElement('div');
    dot.className = `dot ${site.syncEnabled ? (site.status || 'pending') : 'tracking'}`;

    const domain = document.createElement('div');
    domain.className = 'domain';
    domain.textContent = site.domain;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = site.syncEnabled ? (site.lastUpload ? timeAgo(site.lastUpload) : 'not synced') : 'tracking only';

    const syncBtn = document.createElement('button');
    syncBtn.className = 'sync-toggle';
    syncBtn.textContent = site.syncEnabled ? 'syncing' : 'sync off';
    syncBtn.title = site.syncEnabled ? 'Syncing to TEE (click to stop)' : 'Tracking only (click to enable sync)';
    syncBtn.style.fontSize = '11px';
    syncBtn.onclick = () => toggleSync(site.domain, !site.syncEnabled);

    const remove = document.createElement('button');
    remove.textContent = '\u00d7';
    remove.onclick = () => removeSite(site.domain);

    row.append(dot, domain, meta, syncBtn, remove);
    container.appendChild(row);
  }
}

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

async function addSite() {
  if (!currentDomain) return;
  $('add').disabled = true;
  $('status').textContent = 'Requesting permission...';

  const origins = [`https://*.${currentDomain}/*`, `http://*.${currentDomain}/*`];
  if (currentDomain === 'youtube.com') origins.push('https://*.google.com/*', 'http://*.google.com/*');
  const granted = await chrome.permissions.request({ origins });
  if (!granted) {
    $('status').textContent = 'Permission denied';
    $('add').disabled = false;
    return;
  }

  trackedSites.push({ domain: currentDomain, lastUpload: null, status: 'tracking', syncEnabled: false });
  await chrome.storage.local.set({ trackedSites });
  render();

  $('status').textContent = 'Tracking locally.';
  $('status').style.color = '#22c55e';
  $('add').textContent = 'Already tracking';

  const { ownerToken } = await chrome.storage.local.get('ownerToken');
  if (ownerToken) {
    const banner = $('consent-banner');
    banner.style.display = 'block';
    $('consent-domain').textContent = currentDomain;
    $('consent-yes').onclick = async () => {
      banner.style.display = 'none';
      await toggleSync(currentDomain, true);
    };
    $('consent-no').onclick = () => {
      banner.style.display = 'none';
      $('status').textContent = 'Tracking locally only.';
      $('status').style.color = '#22c55e';
    };
  }
}

async function toggleSync(domain, enabled) {
  $('status').textContent = enabled ? 'Enabling sync...' : 'Disabling sync...';
  $('status').style.color = '#666';
  const res = await chrome.runtime.sendMessage({ type: 'setSyncEnabled', domain, enabled });
  if (res?.error) {
    $('status').textContent = `Error: ${res.error}`;
    $('status').style.color = '#ef4444';
  } else {
    $('status').textContent = enabled ? 'Sync enabled' : 'Sync disabled';
    $('status').style.color = '#22c55e';
    const stored = await chrome.storage.local.get('trackedSites');
    trackedSites = stored.trackedSites || trackedSites;
    render();
  }
}

async function removeSite(domain) {
  trackedSites = trackedSites.filter(s => s.domain !== domain);
  await chrome.storage.local.set({ trackedSites });
  render();
  if (domain === currentDomain) {
    $('add').disabled = false;
    $('add').textContent = 'Track this site';
  }
}

async function updateSiteStatus(domain, status) {
  const idx = trackedSites.findIndex(s => s.domain === domain);
  if (idx !== -1) {
    trackedSites[idx].status = status;
    await chrome.storage.local.set({ trackedSites });
    render();
  }
}

$('add').addEventListener('click', addSite);
$('dash').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

async function loadAccount() {
  const { ownerToken, accountEmail } = await chrome.storage.local.get(['ownerToken', 'accountEmail']);
  const info = $('account-info');
  const emailInput = $('email-input');
  const loginBtn = $('login-btn');

  if (accountEmail) {
    info.textContent = accountEmail;
    emailInput.style.display = 'none';
    loginBtn.style.display = 'none';
  } else if (ownerToken) {
    try {
      const payload = JSON.parse(atob(ownerToken.split('.')[1]));
      info.textContent = payload.tenant_id?.slice(0, 12) + '... (no email linked)';
    } catch { info.textContent = 'Anonymous'; }
    emailInput.style.display = 'block';
    loginBtn.style.display = 'block';
  } else {
    info.textContent = 'Not logged in';
    emailInput.style.display = 'block';
    loginBtn.style.display = 'block';
  }
}

$('login-btn').addEventListener('click', async () => {
  const email = $('email-input').value.trim();
  if (!email) return;
  $('login-btn').disabled = true;
  $('login-btn').textContent = 'Sending...';
  try {
    const ORCH = 'https://oauth3-stage.monerolink.com';
    // Try signup first (idempotent if email exists)
    const signupRes = await fetch(`${ORCH}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await signupRes.json();
    if (!signupRes.ok) throw new Error(data.error);
    if (data.tee_token) {
      await chrome.storage.local.set({
        ownerToken: data.tee_token,
        accountEmail: email,
        apiKey: data.api_key
      });
      $('login-btn').textContent = 'Linked!';
      $('login-btn').style.background = '#22c55e';
      $('account-info').textContent = email;
      $('email-input').style.display = 'none';
      // Re-sync cookies with new token
      chrome.runtime.sendMessage({ type: 'syncAll' });
    }
  } catch (e) {
    $('login-btn').textContent = e.message;
    $('login-btn').style.background = '#ef4444';
  }
});

init();
loadAccount();
