const DSTACK_URL = 'https://7f5dee210fd22e418cf0999280226355d6cfa913-3012.dstack-pha-prod7.phala.network';

const DSTACK_WORKER_INFO_URL = DSTACK_URL + '/health';

let trackedSites = [];
let expandedSites = new Set();

// --- Tab switching ---
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'tee') loadTeePanel();
    if (tab.dataset.tab === 'feedling') renderFeedlingTab();
    if (tab.dataset.tab === 'feed-browser') renderFeedBrowser();
    if (tab.dataset.tab === 'settings') renderSettings();
    if (tab.dataset.tab === 'hivemind') renderHivemindTab();
  });
});

// --- TEE attestation ---
const SHIELD_CHECKING = `<svg viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
const SHIELD_OK = `<svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>`;
const SHIELD_FAIL = `<svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M15 9l-6 6M9 9l6 6"/></svg>`;

async function fetchAttestation() {
  const panel = document.getElementById('tee-panel');
  const shield = document.getElementById('tee-shield');
  const statusText = document.getElementById('tee-status-text');
  const platform = document.getElementById('tee-platform');
  const measurements = document.getElementById('tee-measurements');
  const copyBtn = document.getElementById('tee-copy-quote');

  shield.innerHTML = SHIELD_CHECKING;

  let res;
  try {
    res = await fetch(DSTACK_WORKER_INFO_URL);
  } catch (e) {
    panel.className = 'tee-panel failed';
    shield.innerHTML = SHIELD_FAIL;
    statusText.textContent = 'TEE Unreachable';
    platform.textContent = e.message;
    return;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    panel.className = 'tee-panel failed';
    shield.innerHTML = SHIELD_FAIL;
    statusText.textContent = 'TEE Attestation Failed';
    platform.textContent = `${res.status}: ${body}`;
    return;
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    panel.className = 'tee-panel failed';
    shield.innerHTML = SHIELD_FAIL;
    statusText.textContent = 'TEE Attestation Failed';
    platform.textContent = 'Invalid response from attestation endpoint';
    return;
  }

  const tcb = typeof data.tcb_info === 'string' ? JSON.parse(data.tcb_info) : (data.tcb_info || {});

  panel.className = 'tee-panel verified';
  shield.innerHTML = SHIELD_OK;
  statusText.textContent = data.status === 'ok' ? 'TEE Browser Connected' : 'Confidential VM Verified';
  platform.textContent = data.cloud_vendor ? `dstack · Intel TDX · ${data.cloud_vendor}` : 'dstack · Phala Network';

  const lines = [];
  if (tcb.mrtd)   lines.push(`MRTD:    ${tcb.mrtd.slice(0, 24)}…`);
  if (tcb.rtmr0)  lines.push(`RTMR[0]: ${tcb.rtmr0.slice(0, 24)}…`);
  if (tcb.rtmr1)  lines.push(`RTMR[1]: ${tcb.rtmr1.slice(0, 24)}…`);
  if (tcb.rtmr2)  lines.push(`RTMR[2]: ${tcb.rtmr2.slice(0, 24)}…`);
  if (tcb.rtmr3)  lines.push(`RTMR[3]: ${tcb.rtmr3.slice(0, 24)}…`);
  if (tcb.compose_hash)   lines.push(`Compose: ${tcb.compose_hash.slice(0, 24)}…`);
  if (tcb.os_image_hash)  lines.push(`OS img:  ${tcb.os_image_hash.slice(0, 24)}…`);
  if (data.app_id)        lines.push(`App ID:  ${data.app_id}`);
  measurements.textContent = lines.join('\n');

  // Copy the full app_cert chain as the verifiable artifact
  if (data.app_cert) {
    copyBtn.style.display = 'inline-block';
    copyBtn.dataset.quote = data.app_cert;
    copyBtn.textContent = 'Copy Cert';
  }
}

document.getElementById('tee-toggle').addEventListener('click', () => {
  const explainer = document.getElementById('tee-explainer');
  const measurements = document.getElementById('tee-measurements');
  const btn = document.getElementById('tee-toggle');
  const open = explainer.classList.toggle('open');
  measurements.classList.toggle('open', open && measurements.textContent);
  btn.textContent = open ? 'Hide details' : 'What does this mean?';
});

document.getElementById('tee-copy-quote').addEventListener('click', (e) => {
  const quote = e.target.dataset.quote;
  navigator.clipboard.writeText(quote);
  const label = e.target.textContent;
  e.target.textContent = 'Copied!';
  setTimeout(() => { e.target.textContent = label; }, 1500);
});

// --- Sync health panel ---
function freshnessColor(ts) {
  if (!ts) return 'gray';
  const h = (Date.now() - ts) / 3600000;
  if (h < 6) return 'green';
  if (h < 24) return 'yellow';
  return 'red';
}

function findCoverageGaps(timestamps, limit) {
  if (timestamps.length < 2) return [];
  const min = Math.min(...timestamps);
  const max = Math.max(...timestamps);
  const daySet = new Set(timestamps.map(d => new Date(d).toISOString().slice(0, 10)));
  const gaps = [];
  const cur = new Date(min); cur.setHours(0, 0, 0, 0);
  const end = new Date(max); end.setHours(0, 0, 0, 0);
  while (cur <= end) {
    const k = cur.toISOString().slice(0, 10);
    if (!daySet.has(k)) gaps.push(k);
    cur.setDate(cur.getDate() + 1);
    if (limit && gaps.length >= limit) break;
  }
  return gaps;
}

function buildSparkline(itemCountHistory) {
  const days = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const vals = days.map(d => itemCountHistory[d]?.total ?? null);
  const defined = vals.filter(v => v !== null);
  if (defined.length < 2) return '';
  const max = Math.max(...defined);
  const min = Math.min(...defined);
  const range = max - min || 1;
  const w = 84, h = 24;
  const points = vals.map((v, i) => {
    if (v === null) return null;
    return `${(i / 6 * w).toFixed(1)},${(h - (v - min) / range * h).toFixed(1)}`;
  }).filter(Boolean);
  return `<svg viewBox="0 0 ${w} ${h}" style="width:84px;height:24px;vertical-align:middle"><polyline points="${points.join(' ')}" fill="none" stroke="#3b82f6" stroke-width="1.5"/></svg>`;
}

function collapseGapRanges(gaps) {
  if (!gaps.length) return '';
  const sorted = [...gaps].sort();
  const ranges = [];
  let start = sorted[0], prev = sorted[0];
  const fmt = d => { const m = new Date(d + 'T00:00:00'); return m.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    const prevDate = new Date(prev + 'T00:00:00');
    const nextDay = new Date(prevDate); nextDay.setDate(nextDay.getDate() + 1);
    if (cur === nextDay.toISOString().slice(0, 10)) { prev = cur; continue; }
    ranges.push(start === prev ? fmt(start) : `${fmt(start)}–${fmt(prev)}`);
    start = cur; prev = cur;
  }
  if (ranges.length > 3) return `${ranges.slice(0, 2).join(', ')} +${ranges.length - 2} more`;
  return ranges.join(', ');
}

async function renderSyncHealth() {
  const { ytHistory, ttHistory, trackedSites: sites, syncHealth, itemCountHistory = {}, dietTimeLog = {} } = await chrome.storage.local.get(['ytHistory', 'ttHistory', 'trackedSites', 'syncHealth', 'itemCountHistory', 'dietTimeLog']);
  const el = document.getElementById('sync-health');

  const syncTimes = [];
  if (syncHealth?.lastCookieSync) syncTimes.push(syncHealth.lastCookieSync);
  if (ytHistory?.lastSync) syncTimes.push(ytHistory.lastSync);
  if (ttHistory?.lastSync) syncTimes.push(ttHistory.lastSync);
  for (const s of (sites || [])) { if (s.lastUpload) syncTimes.push(s.lastUpload); }
  const lastSync = syncTimes.length ? Math.max(...syncTimes) : null;

  const ytCount = ytHistory?.items?.length || 0;
  const ttCount = ttHistory?.items?.length || 0;
  const total = ytCount + ttCount;

  // Delta from yesterday's snapshot
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = yesterday.toISOString().slice(0, 10);
  const prevTotal = itemCountHistory[yesterdayKey]?.total;
  const delta = prevTotal != null ? total - prevTotal : null;

  // Coverage gaps: ytHistory
  const ytDates = (ytHistory?.items || []).map(v => typeof v.date === 'number' ? v.date : null).filter(Boolean);
  const ytGaps = findCoverageGaps(ytDates, 50);

  // Coverage gaps: ttHistory
  const ttDates = (ttHistory?.items || []).map(v => typeof v.watchedAt === 'number' ? v.watchedAt : null).filter(Boolean);
  const ttGaps = findCoverageGaps(ttDates, 50);

  // Coverage gaps: dietTimeLog (missing days in last 14 days)
  const dietGaps = [];
  const now = new Date();
  for (let i = 1; i <= 14; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const k = d.toISOString().slice(0, 10);
    if (!dietTimeLog[k]) dietGaps.push(k);
  }

  const allGaps = [...new Set([...ytGaps, ...ttGaps, ...dietGaps])].sort();

  let html = '';

  // Overall sync status
  const syncColor = freshnessColor(lastSync);
  html += `<div class="health-card"><div class="health-label">Last Sync</div><div class="health-value"><span class="health-dot ${syncColor}"></span>${lastSync ? timeAgo(lastSync) : 'never'}</div></div>`;

  // Item delta + sparkline + trend arrow
  const sparkline = buildSparkline(itemCountHistory);
  const deltaStr = delta != null ? (delta > 0 ? `+${delta}` : String(delta)) + ' since yesterday' : 'no prior snapshot';
  const days7 = Object.keys(itemCountHistory).sort().slice(-7);
  const avg7 = days7.length >= 2 ? days7.slice(0, -1).reduce((s, k) => s + (itemCountHistory[k]?.total || 0), 0) / (days7.length - 1) : null;
  const trendArrow = avg7 != null ? (total > avg7 * 1.05 ? '<span class="trend-arrow up">&#9650;</span>' : total < avg7 * 0.95 ? '<span class="trend-arrow down">&#9660;</span>' : '<span class="trend-arrow flat">&#9654;</span>') : '';
  html += `<div class="health-card"><div class="health-label">Items</div><div class="health-value">${total > 0 ? `${total} total · ${deltaStr}` : 'no data'} ${sparkline} ${trendArrow}</div></div>`;

  // Coverage gaps with source breakdown
  const gapColor = allGaps.length === 0 ? 'green' : allGaps.length <= 3 ? 'yellow' : 'red';
  html += `<div class="health-card"><div class="health-label">Coverage Gaps</div><div class="health-value"><span class="health-dot ${gapColor}"></span>${allGaps.length === 0 ? 'none' : `${allGaps.length} missing day${allGaps.length > 1 ? 's' : ''}`}</div>`;
  if (allGaps.length > 0) {
    const labels = [];
    if (ytGaps.length) labels.push(`YT: ${collapseGapRanges(ytGaps)}`);
    if (ttGaps.length) labels.push(`TT: ${collapseGapRanges(ttGaps)}`);
    if (dietGaps.length) labels.push(`Diet: ${collapseGapRanges(dietGaps)}`);
    html += `<div class="health-gaps">${labels.join(' · ')}</div>`;
  }
  html += '</div>';

  // Cookie freshness per domain
  const allSites = sites || [];
  const syncedSites = allSites.filter(s => s.syncEnabled);
  const trackingOnly = allSites.filter(s => !s.syncEnabled);
  if (syncedSites.length || trackingOnly.length) {
    let domainHtml = '<div class="health-domains">';
    for (const s of syncedSites) {
      const c = freshnessColor(s.lastUpload);
      domainHtml += `<div class="hd-row"><span class="health-dot ${c}"></span>${esc(s.domain)} — ${s.lastUpload ? timeAgo(s.lastUpload) : 'never'}</div>`;
    }
    for (const s of trackingOnly) {
      domainHtml += `<div class="hd-row"><span class="health-dot blue"></span>${esc(s.domain)} — tracking only</div>`;
    }
    domainHtml += '</div>';
    html += `<div class="health-card"><div class="health-label">Cookie Freshness</div>${domainHtml}</div>`;
  }

  // Summary sentence combining all signals
  const syncAgo = lastSync ? timeAgo(lastSync) : 'never';
  const deltaLabel = delta != null ? (delta > 0 ? `+${delta} new` : delta === 0 ? 'no new' : `${delta}`) + ' items since yesterday' : '';
  const gapLabel = allGaps.length === 0 ? 'no gaps' : `${allGaps.length} gap${allGaps.length > 1 ? 's' : ''}`;
  const parts = [`Last synced ${syncAgo}`, deltaLabel, gapLabel].filter(Boolean);
  html = `<div class="sync-hero ${syncColor}"><span class="health-dot ${syncColor}"></span>${parts.join(' · ')}</div>` + html;

  el.innerHTML = html;
}

async function updateItemCountHistory() {
  const { ytHistory, ttHistory, itemCountHistory = {} } = await chrome.storage.local.get(['ytHistory', 'ttHistory', 'itemCountHistory']);
  const yt = ytHistory?.items?.length || 0;
  const tt = ttHistory?.items?.length || 0;
  const d = new Date().toISOString().slice(0, 10);
  itemCountHistory[d] = { yt, tt, total: yt + tt };
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const key of Object.keys(itemCountHistory)) { if (key < cutoffStr) delete itemCountHistory[key]; }
  await chrome.storage.local.set({ itemCountHistory });
}

// --- Sites tab ---
async function init() {
  const stored = await chrome.storage.local.get(['trackedSites', 'ownerToken']);
  trackedSites = stored.trackedSites || [];

  render();
  renderSyncHealth();
  checkServer();
  fetchAttestation();

  document.getElementById('token-status').textContent = stored.ownerToken ? 'Registered' : 'Not registered';

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.trackedSites) {
      trackedSites = changes.trackedSites.newValue || [];
      render();
    }
    if (changes.trackedSites || changes.ytHistory || changes.ttHistory || changes.syncHealth || changes.itemCountHistory) renderSyncHealth();
  });
}

async function checkServer() {
  const el = document.getElementById('server-status');
  try {
    const res = await fetch(`${DSTACK_URL}/health`);
    el.textContent = res.ok ? 'Server: connected' : `Server: ${res.status}`;
    el.style.color = res.ok ? '#22c55e' : '#ef4444';
  } catch {
    el.textContent = 'Server: unreachable';
    el.style.color = '#ef4444';
  }
}

function render() {
  const container = document.getElementById('sites');
  const empty = document.getElementById('empty');
  const count = document.getElementById('count');

  container.innerHTML = '';
  empty.style.display = trackedSites.length ? 'none' : 'block';
  count.textContent = trackedSites.length ? `${trackedSites.length} site${trackedSites.length > 1 ? 's' : ''}` : '';

  for (const site of trackedSites) {
    const card = document.createElement('div');
    card.className = 'card';
    const dotClass = site.syncEnabled ? (site.status || 'pending') : 'tracking';
    const syncLabel = site.syncEnabled ? 'Syncing to TEE' : 'Tracking only';
    card.innerHTML = `
      <div class="site-header">
        <div class="dot ${dotClass}"></div>
        <div class="domain">${esc(site.domain)}</div>
        <div class="actions">
          <label class="sync-switch" title="${syncLabel}">
            <input type="checkbox" data-action="toggle-sync" data-domain="${esc(site.domain)}" ${site.syncEnabled ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
          ${site.syncEnabled ? `<button class="btn primary" data-action="sync" data-domain="${esc(site.domain)}">Sync now</button>` : ''}
          <button class="toggle" data-action="toggle" data-domain="${esc(site.domain)}">${expandedSites.has(site.domain) ? 'Hide cookies' : 'Show cookies'}</button>
          <button class="btn danger" data-action="remove" data-domain="${esc(site.domain)}">&times;</button>
        </div>
      </div>
      <div class="meta-row">
        <span><span class="label">Status:</span> ${syncLabel}</span>
        <span><span class="label">Last sync:</span> ${site.lastUpload ? timeAgo(site.lastUpload) : 'never'}</span>
        <span class="cookie-count" data-domain="${esc(site.domain)}"><span class="label">Cookies:</span> loading...</span>
      </div>
      <div class="cookie-detail" data-domain="${esc(site.domain)}" style="display:${expandedSites.has(site.domain) ? 'block' : 'none'}"></div>
    `;
    container.appendChild(card);
    loadCookieInfo(site.domain);
  }

  container.onclick = handleAction;
}

async function loadCookieInfo(domain) {
  const cookies = await chrome.cookies.getAll({ domain });
  const countEl = document.querySelector(`.cookie-count[data-domain="${domain}"]`);
  if (countEl) countEl.innerHTML = `<span class="label">Cookies:</span> ${cookies.length}`;

  const detailEl = document.querySelector(`.cookie-detail[data-domain="${domain}"]`);
  if (!detailEl || !expandedSites.has(domain)) return;

  if (!cookies.length) {
    detailEl.innerHTML = '<div style="color:#555;font-size:12px;padding:8px 0">No cookies found</div>';
    return;
  }

  const now = Date.now() / 1000;
  const rows = cookies.map(c => {
    let expiryText = 'session', expiryClass = '';
    if (c.expirationDate) {
      const rem = c.expirationDate - now;
      if (rem < 0) { expiryText = 'expired'; expiryClass = 'expiry-expired'; }
      else if (rem < 3600) { expiryText = `${Math.floor(rem / 60)}m`; expiryClass = 'expiry-warn'; }
      else if (rem < 86400) { expiryText = `${Math.floor(rem / 3600)}h`; expiryClass = 'expiry-warn'; }
      else { expiryText = `${Math.floor(rem / 86400)}d`; }
    }
    return `<tr><td>${esc(c.name)}</td><td class="val" title="${esc(c.value)}">${esc(c.value)}</td><td>${esc(c.domain)}</td><td>${c.httpOnly ? 'Y' : ''}</td><td>${c.secure ? 'Y' : ''}</td><td class="${expiryClass}">${expiryText}</td></tr>`;
  }).join('');

  detailEl.innerHTML = `<table class="cookies-table"><thead><tr><th>Name</th><th>Value</th><th>Domain</th><th>HttpOnly</th><th>Secure</th><th>Expires</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function handleAction(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, domain } = btn.dataset;

  if (action === 'remove') {
    trackedSites = trackedSites.filter(s => s.domain !== domain);
    expandedSites.delete(domain);
    await chrome.storage.local.set({ trackedSites });
    render();
  } else if (action === 'sync') {
    btn.textContent = 'Syncing...';
    btn.disabled = true;
    const res = await chrome.runtime.sendMessage({ type: 'uploadCookies', domain });
    if (res?.error) { btn.textContent = 'Failed'; btn.style.borderColor = '#ef4444'; }
    else { const stored = await chrome.storage.local.get('trackedSites'); trackedSites = stored.trackedSites || trackedSites; render(); }
  } else if (action === 'toggle-sync') {
    const enabled = btn.checked;
    const res = await chrome.runtime.sendMessage({ type: 'setSyncEnabled', domain, enabled });
    if (res?.error) { btn.checked = !enabled; alert(res.error); }
    else { const stored = await chrome.storage.local.get('trackedSites'); trackedSites = stored.trackedSites || trackedSites; render(); }
  } else if (action === 'toggle') {
    if (expandedSites.has(domain)) expandedSites.delete(domain); else expandedSites.add(domain);
    render();
  }
}

// --- YouTube tab (persistent) ---

// Dates are stored as epoch ms (numbers) to survive chrome.storage serialization.
// Date objects become {} via structured clone — never store them directly.

function prepareForStorage(items) {
  return items.map(v => ({
    ...v,
    date: v.date instanceof Date ? v.date.getTime() : (typeof v.date === 'number' ? v.date : null)
  }));
}

function hydrateFromStorage(items) {
  return items.map(v => ({
    ...v,
    date: typeof v.date === 'number' ? new Date(v.date) : (v.date instanceof Date ? v.date : null)
  }));
}

async function loadYtStore() {
  const { ytHistory } = await chrome.storage.local.get('ytHistory');
  if (!ytHistory) return { items: [], lastSync: null };
  ytHistory.items = hydrateFromStorage(ytHistory.items);
  return ytHistory;
}

async function saveYtStore(store) {
  const toSave = { ...store, items: prepareForStorage(store.items) };
  await chrome.storage.local.set({ ytHistory: toSave });
}

function mergeYtItems(existing, fresh) {
  const seen = new Set(existing.map(v => v.id));
  let newCount = 0;
  for (const v of fresh) {
    if (!v.id || seen.has(v.id)) continue;
    seen.add(v.id);
    existing.push(v);
    newCount++;
  }
  existing.sort((a, b) => (b.date || 0) - (a.date || 0));
  return newCount;
}

function renderYtCoverage(store) {
  const el = document.getElementById('yt-coverage');
  const btn = document.getElementById('yt-load-more');
  if (!store.items.length) {
    el.textContent = 'No history stored. Click "Sync New" to fetch.';
    btn.style.display = 'none';
    return;
  }
  const dated = store.items.filter(v => v.date instanceof Date && !isNaN(v.date));
  dated.sort((a, b) => b.date - a.date);
  const newest = dated[0]?.date;
  const oldest = dated[dated.length - 1]?.date;
  const shorts = store.items.filter(v => v.isShort).length;
  const videos = store.items.length - shorts;
  const syncAge = store.lastSync ? timeAgo(store.lastSync) : 'never';
  const oldestStr = oldest ? oldest.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '?';
  const newestStr = newest ? newest.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '?';
  el.innerHTML = `${store.items.length} items (${videos} videos, ${shorts} shorts) · <strong>${oldestStr}</strong> → <strong>${newestStr}</strong> · Synced ${syncAge}`;
  // Always show Load Older — fetches deeper from YouTube
  btn.style.display = 'inline-block';
}

function rolling7Days() {
  const days = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    days.push(d);
  }
  return days;
}

function buildYtHistogram(byDate, shortsItems) {
  const days = rolling7Days();
  const today = dateKey(new Date());
  const shortsByDate = {};
  for (const v of shortsItems) { const k = dateKey(v.date); (shortsByDate[k] ??= []).push(v); }

  const data = days.map(d => {
    const k = dateKey(d);
    const longCount = (byDate[k] || []).length;
    const shortCount = (shortsByDate[k] || []).length;
    return { k, day: d.toLocaleDateString('en-US', { weekday: 'short' }), longCount, shortCount, total: longCount + shortCount, isToday: k === today };
  });
  const max = Math.max(1, ...data.map(d => d.total));

  let html = '<div class="histogram">';
  for (const d of data) {
    const longH = (d.longCount / max * 100).toFixed(0);
    const shortH = (d.shortCount / max * 100).toFixed(0);
    html += `<div class="hist-day${d.isToday ? ' today' : ''}">
      <div class="hist-count">${d.total || ''}</div>
      <div class="hist-stack">
        ${d.shortCount ? `<div class="hist-bar shorts" style="height:${shortH}%"></div>` : ''}
        ${d.longCount ? `<div class="hist-bar long" style="height:${longH}%"></div>` : ''}
      </div>
      <div class="hist-label">${d.day}</div>
    </div>`;
  }
  html += '</div>';
  return html;
}

function buildTtHistogram(byDate) {
  const days = rolling7Days();
  const today = new Date().toISOString().slice(0, 10);

  const data = days.map(d => {
    const k = d.toISOString().slice(0, 10);
    const count = (byDate[k] || []).length;
    return { day: d.toLocaleDateString('en-US', { weekday: 'short' }), count, isToday: k === today };
  });
  const max = Math.max(1, ...data.map(d => d.count));

  let html = '<div class="histogram">';
  for (const d of data) {
    const h = (d.count / max * 100).toFixed(0);
    html += `<div class="hist-day${d.isToday ? ' today' : ''}">
      <div class="hist-count">${d.count || ''}</div>
      <div class="hist-stack">
        ${d.count ? `<div class="hist-bar tt" style="height:${h}%"></div>` : ''}
      </div>
      <div class="hist-label">${d.day}</div>
    </div>`;
  }
  html += '</div>';
  return html;
}

function renderYtResults(store) {
  const week = analyze(store.items, 7);
  const all = analyze(store.items, 99999);
  document.getElementById('yt-results').innerHTML = renderYouTubeStats(week, all);
}

// Load stored history on tab init
(async () => {
  const store = await loadYtStore();
  renderYtCoverage(store);
  if (store.items.length) renderYtResults(store);
})();

document.getElementById('yt-sync').addEventListener('click', async () => {
  const status = document.getElementById('yt-status');
  status.textContent = 'Checking permissions...';
  status.style.color = '#888';

  const granted = await chrome.permissions.request({ origins: ['https://*.youtube.com/*'] });
  if (!granted) { status.textContent = 'Permission denied'; status.style.color = '#ef4444'; return; }

  status.textContent = 'Fetching new history...';
  try {
    const store = await loadYtStore();
    const fresh = await fetchHistory(5, null, msg => { status.textContent = msg; });
    const newCount = mergeYtItems(store.items, fresh);
    store.lastSync = Date.now();
    await saveYtStore(store);
    await updateItemCountHistory();
    renderYtCoverage(store);
    renderYtResults(store);
    status.textContent = `+${newCount} new items`;
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    status.style.color = '#ef4444';
  }
});

document.getElementById('yt-load-more').addEventListener('click', async () => {
  const status = document.getElementById('yt-status');
  status.textContent = 'Loading older history...';
  status.style.color = '#888';

  const granted = await chrome.permissions.request({ origins: ['https://*.youtube.com/*'] });
  if (!granted) { status.textContent = 'Permission denied'; status.style.color = '#ef4444'; return; }

  try {
    const store = await loadYtStore();
    // Fetch all pages (up to 20) going as deep as possible
    const fresh = await fetchHistory(20, null, msg => { status.textContent = msg; });
    const newCount = mergeYtItems(store.items, fresh);
    store.lastSync = Date.now();
    await saveYtStore(store);
    await updateItemCountHistory();
    renderYtCoverage(store);
    renderYtResults(store);
    status.textContent = `+${newCount} older items`;
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    status.style.color = '#ef4444';
  }
});

document.getElementById('yt-clear').addEventListener('click', async () => {
  await saveYtStore({ items: [], continuation: null, lastSync: null });
  renderYtCoverage({ items: [] });
  document.getElementById('yt-results').innerHTML = '';
  document.getElementById('yt-status').textContent = 'Cleared';
});

function renderYouTubeStats(week, all) {
  const catColors = { Music: '#a855f7', Tech: '#3b82f6', Gaming: '#22c55e', Education: '#eab308', Entertainment: '#f97316', 'News/Commentary': '#ef4444', Other: '#555' };
  let html = '';

  // Week summary hero
  html += `<div class="week-hero">
    <div class="hero-title">Your Week in YouTube</div>
    <div class="hero-stats">
      <div class="hero-stat"><div class="value">${week.videos.length + week.shorts.length}</div><div class="label">Videos</div></div>
      <div class="hero-stat"><div class="value">${week.shorts.length}</div><div class="label">Shorts</div></div>
      <div class="hero-stat"><div class="value">${fmtDur(week.totalSecs)}</div><div class="label">Watch Time</div></div>
    </div>
  </div>`;

  // Today section
  const todayKey = dateKey(new Date());
  const todayVids = (week.byDate[todayKey] || []);
  const todayShorts = week.shorts.filter(v => dateKey(v.date) === todayKey);
  const todaySecs = todayVids.reduce((s, v) => s + parseDuration(v.duration), 0);
  html += `<h2>Today</h2><div class="stats-grid">
    <div class="stat-card"><div class="value">${todayVids.length + todayShorts.length}</div><div class="label">Videos</div></div>
    <div class="stat-card"><div class="value">${todayShorts.length}</div><div class="label">Shorts</div></div>
    <div class="stat-card"><div class="value">${fmtDur(todaySecs)}</div><div class="label">Watch Time</div></div>
  </div>`;

  // 7-day histogram
  html += '<h2>Last 7 Days</h2>';
  html += buildYtHistogram(week.byDate, week.shorts);

  // All-time stats
  const s = all;
  html += '<h2>All Time</h2>';
  html += `<div class="stats-grid">
    <div class="stat-card"><div class="value">${s.videos.length}</div><div class="label">Videos</div></div>
    <div class="stat-card"><div class="value">${s.shorts.length}</div><div class="label">Shorts</div></div>
    <div class="stat-card"><div class="value">${fmtDur(s.totalSecs)}</div><div class="label">Watch Time</div></div>
    <div class="stat-card"><div class="value">${s.uniqueChannels}</div><div class="label">Channels</div></div>
    <div class="stat-card"><div class="value">${fmtDur(s.avgDuration)}</div><div class="label">Avg Length</div></div>
  </div>`;

  if (s.topChannels.length) {
    const maxCount = s.topChannels[0][1];
    html += '<h2>Top Channels</h2><div class="card">';
    for (let i = 0; i < Math.min(10, s.topChannels.length); i++) {
      const [ch, count] = s.topChannels[i];
      const chTime = s.videos.filter(v => v.channel === ch).reduce((t, v) => t + parseDuration(v.duration), 0);
      html += `<div class="channel-row">
        <div class="rank">${i + 1}</div>
        <div class="name">${esc(ch)}</div>
        <div class="bar-bg"><div class="bar" style="width:${(count / maxCount * 100).toFixed(0)}%"></div></div>
        <div class="count">${count} vids, ${fmtDur(chTime)}</div>
      </div>`;
    }
    html += '</div>';
  }

  const sortedCats = Object.entries(s.cats).sort((a, b) => b[1].length - a[1].length);
  if (sortedCats.length) {
    html += '<h2>Content Breakdown</h2><div class="card">';
    for (const [cat, vids] of sortedCats) {
      const pct = (vids.length / s.videos.length * 100);
      const color = catColors[cat] || '#555';
      html += `<div class="cat-row">
        <div class="cat-name">${esc(cat)}</div>
        <div class="cat-bar-bg"><div class="cat-bar" style="width:${pct.toFixed(0)}%;background:${color}"></div></div>
        <div class="cat-pct">${pct.toFixed(0)}%</div>
      </div>`;
    }
    html += '</div>';
  }

  html += '<h2>Highlights</h2><div class="card">';
  if (s.longestVideo) {
    html += `<div class="insight">Longest video: <span class="highlight">${esc(s.longestVideo.title)}</span> (${fmtDur(parseDuration(s.longestVideo.duration))}) by ${esc(s.longestVideo.channel || '?')}</div>`;
  }
  if (s.busiestDay) {
    const [dk, vids] = s.busiestDay;
    html += `<div class="insight">Busiest day: <span class="highlight">${dk}</span> — ${vids.length} videos</div>`;
  }
  if (s.longestDay) {
    const [dk, vids] = s.longestDay;
    const t = vids.reduce((s, v) => s + parseDuration(v.duration), 0);
    html += `<div class="insight">Longest day: <span class="highlight">${dk}</span> — ${fmtDur(t)}</div>`;
  }
  for (const b of s.binges.sort((a, b) => b.count - a.count).slice(0, 5)) {
    html += `<div class="insight">Binge: <span class="highlight">${b.count} videos</span> of ${esc(b.channel)} on ${b.date}</div>`;
  }
  html += '</div>';

  html += '<h2>Watch History</h2>';
  let lastDate = null;
  const allItems = [...s.videos, ...s.shorts].sort((a, b) => (b.date || 0) - (a.date || 0));
  for (const v of allItems) {
    const dk = dateKey(v.date);
    if (dk !== lastDate) {
      lastDate = dk;
      const d = v.date;
      html += `<div class="date-header">${d ? d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) : 'Unknown'}</div>`;
    }
    if (v.isShort) {
      html += `<div class="video-item">
        <img src="https://i.ytimg.com/vi/${esc(v.id)}/default.jpg" loading="lazy">
        <div class="video-meta">
          <div class="title"><a href="${esc(v.url)}" target="_blank">${esc(v.title || '(Short)')}</a></div>
          <div class="dur">Short${v.views ? ` · ${esc(v.views)} views` : ''}</div>
        </div>
      </div>`;
    } else {
      html += `<div class="video-item">
        <img src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg" loading="lazy">
        <div class="video-meta">
          <div class="title"><a href="${esc(v.url)}" target="_blank">${esc(v.title)}</a></div>
          <div class="channel">${esc(v.channel || '?')}</div>
          <div class="dur">${esc(v.duration || '')}</div>
        </div>
      </div>`;
    }
  }

  return html;
}

// --- TikTok tab (persistent) ---

function prepareTtForStorage(items) {
  return items.map(v => ({
    ...v,
    watchedAt: v.watchedAt instanceof Date ? v.watchedAt.getTime() : (typeof v.watchedAt === 'number' ? v.watchedAt : null)
  }));
}

function hydrateTtFromStorage(items) {
  return items.map(v => ({
    ...v,
    watchedAt: typeof v.watchedAt === 'number' ? new Date(v.watchedAt) : (v.watchedAt instanceof Date ? v.watchedAt : null)
  }));
}

async function loadTtStore() {
  const { ttHistory } = await chrome.storage.local.get('ttHistory');
  if (!ttHistory) return { items: [], lastSync: null };
  ttHistory.items = hydrateTtFromStorage(ttHistory.items);
  return ttHistory;
}

async function saveTtStore(store) {
  const toSave = { ...store, items: prepareTtForStorage(store.items) };
  await chrome.storage.local.set({ ttHistory: toSave });
}

function mergeTtItems(existing, fresh) {
  const seen = new Set(existing.map(v => v.id));
  let newCount = 0;
  for (const v of fresh) {
    if (!v.id || seen.has(v.id)) continue;
    seen.add(v.id);
    existing.push(v);
    newCount++;
  }
  existing.sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));
  return newCount;
}

function renderTtCoverage(store) {
  const el = document.getElementById('tt-coverage');
  const btn = document.getElementById('tt-load-more');
  if (!store.items.length) {
    el.textContent = 'No history stored. Click "Sync New" to fetch.';
    btn.style.display = 'none';
    return;
  }
  const dated = store.items.filter(v => v.watchedAt instanceof Date && !isNaN(v.watchedAt));
  dated.sort((a, b) => b.watchedAt - a.watchedAt);
  const newest = dated[0]?.watchedAt;
  const oldest = dated[dated.length - 1]?.watchedAt;
  const syncAge = store.lastSync ? timeAgo(store.lastSync) : 'never';
  const oldestStr = oldest ? oldest.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '?';
  const newestStr = newest ? newest.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '?';
  el.innerHTML = `${store.items.length} items · <strong>${oldestStr}</strong> → <strong>${newestStr}</strong> · Synced ${syncAge}`;
  btn.style.display = 'inline-block';
}

function renderTtResults(store) {
  const week = analyzeTikTok(store.items, 7);
  const all = analyzeTikTok(store.items, 99999);
  document.getElementById('tt-results').innerHTML = renderTikTokStats(week, all);
}

(async () => {
  const store = await loadTtStore();
  renderTtCoverage(store);
  if (store.items.length) renderTtResults(store);
})();

document.getElementById('tt-sync').addEventListener('click', async () => {
  const status = document.getElementById('tt-status');
  status.textContent = 'Checking permissions...';
  status.style.color = '#888';

  const granted = await chrome.permissions.request({ origins: ['https://*.tiktok.com/*'] });
  if (!granted) { status.textContent = 'Permission denied'; status.style.color = '#ef4444'; return; }

  status.textContent = 'Fetching new history...';
  try {
    const store = await loadTtStore();
    const fresh = await fetchTikTokHistory(10, null, msg => { status.textContent = msg; });
    const newCount = mergeTtItems(store.items, fresh);
    store.lastSync = Date.now();
    await saveTtStore(store);
    await updateItemCountHistory();
    renderTtCoverage(store);
    renderTtResults(store);
    status.textContent = `+${newCount} new items`;
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    status.style.color = '#ef4444';
  }
});

document.getElementById('tt-load-more').addEventListener('click', async () => {
  const status = document.getElementById('tt-status');
  status.textContent = 'Loading older history...';
  status.style.color = '#888';

  const granted = await chrome.permissions.request({ origins: ['https://*.tiktok.com/*'] });
  if (!granted) { status.textContent = 'Permission denied'; status.style.color = '#ef4444'; return; }

  try {
    const store = await loadTtStore();
    const fresh = await fetchTikTokHistory(20, null, msg => { status.textContent = msg; });
    const newCount = mergeTtItems(store.items, fresh);
    store.lastSync = Date.now();
    await saveTtStore(store);
    await updateItemCountHistory();
    renderTtCoverage(store);
    renderTtResults(store);
    status.textContent = `+${newCount} older items`;
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    status.style.color = '#ef4444';
  }
});

document.getElementById('tt-clear').addEventListener('click', async () => {
  await saveTtStore({ items: [], lastSync: null });
  renderTtCoverage({ items: [] });
  document.getElementById('tt-results').innerHTML = '';
  document.getElementById('tt-status').textContent = 'Cleared';
});

function renderTikTokStats(week, all) {
  let html = '';

  // Week summary hero
  html += `<div class="week-hero">
    <div class="hero-title">Your Week in TikTok</div>
    <div class="hero-stats">
      <div class="hero-stat"><div class="value">${week.vids.length}</div><div class="label">Videos</div></div>
      <div class="hero-stat"><div class="value">${fmtDur(week.totalSecs)}</div><div class="label">Watch Time</div></div>
      <div class="hero-stat"><div class="value">${week.uniqueAuthors}</div><div class="label">Creators</div></div>
    </div>
  </div>`;

  // Today
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayVids = week.byDate[todayKey] || [];
  const todaySecs = todayVids.reduce((s, v) => s + v.duration, 0);
  html += `<h2>Today</h2><div class="stats-grid">
    <div class="stat-card"><div class="value">${todayVids.length}</div><div class="label">Videos</div></div>
    <div class="stat-card"><div class="value">${fmtDur(todaySecs)}</div><div class="label">Watch Time</div></div>
  </div>`;

  // 7-day histogram
  html += '<h2>Last 7 Days</h2>';
  html += buildTtHistogram(week.byDate);

  // All-time stats
  const s = all;
  html += '<h2>All Time</h2>';
  html += `<div class="stats-grid">
    <div class="stat-card"><div class="value">${s.vids.length}</div><div class="label">Videos</div></div>
    <div class="stat-card"><div class="value">${fmtDur(s.totalSecs)}</div><div class="label">Watch Time</div></div>
    <div class="stat-card"><div class="value">${s.uniqueAuthors}</div><div class="label">Creators</div></div>
    <div class="stat-card"><div class="value">${s.vids.length ? fmtDur(Math.floor(s.totalSecs / s.vids.length)) : '0s'}</div><div class="label">Avg Length</div></div>
  </div>`;

  if (s.topAuthors.length) {
    const maxCount = s.topAuthors[0][1];
    html += '<h2>Top Creators</h2><div class="card">';
    for (let i = 0; i < Math.min(10, s.topAuthors.length); i++) {
      const [author, count] = s.topAuthors[i];
      html += `<div class="channel-row">
        <div class="rank">${i + 1}</div>
        <div class="name">${esc(author)}</div>
        <div class="bar-bg"><div class="bar" style="width:${(count / maxCount * 100).toFixed(0)}%;background:#ee1d52"></div></div>
        <div class="count">${count} vids</div>
      </div>`;
    }
    html += '</div>';
  }

  html += '<h2>Highlights</h2><div class="card">';
  if (s.mostLiked) {
    html += `<div class="insight">Most liked: <span class="highlight">${esc(s.mostLiked.title.slice(0, 80))}</span> by ${esc(s.mostLiked.author)} (${(s.mostLiked.likes/1000).toFixed(1)}k likes)</div>`;
  }
  if (s.busiestDay) {
    const [dk, vids] = s.busiestDay;
    html += `<div class="insight">Busiest day: <span class="highlight">${dk}</span> — ${vids.length} videos</div>`;
  }
  html += '</div>';

  html += '<h2>Watch History</h2>';
  let lastDate = null;
  const sorted = [...s.vids].sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));
  for (const v of sorted) {
    const dk = v.watchedAt?.toISOString().slice(0,10);
    if (dk !== lastDate) {
      lastDate = dk;
      html += `<div class="date-header">${v.watchedAt ? v.watchedAt.toLocaleDateString('en-US', {weekday:'long', month:'short', day:'numeric'}) : 'Unknown'}</div>`;
    }
    html += `<div class="video-item">
      ${v.cover ? `<img src="${esc(v.cover)}" loading="lazy">` : '<div style="width:120px;height:68px;background:#1a1a1a;border-radius:6px;flex-shrink:0"></div>'}
      <div class="video-meta">
        <div class="title"><a href="${esc(v.url)}" target="_blank">${esc(v.title || '(untitled)')}</a></div>
        <div class="channel">@${esc(v.authorId)}</div>
        <div class="dur">${v.duration}s · ${(v.plays/1000).toFixed(1)}k plays · ${(v.likes/1000).toFixed(1)}k likes</div>
      </div>
    </div>`;
  }

  return html;
}

// --- TEE observability tab ---

async function loadTeePanel() {
  const el = document.getElementById('tee-content');
  el.innerHTML = 'Loading TEE state...';

  const { ownerToken, trackedSites: sites } = await chrome.storage.local.get(['ownerToken', 'trackedSites']);
  if (!ownerToken) {
    el.innerHTML = '<div class="card" style="text-align:center;color:#888;padding:40px">Not registered — sync cookies from a tracked site to auto-register with the TEE.</div>';
    return;
  }

  let html = '';

  const healthRes = await fetch(`${DSTACK_URL}/health`);
  if (!healthRes.ok) throw new Error(`TEE /health returned ${healthRes.status}: ${await healthRes.text()}`);
  const health = await healthRes.json();
  const healthFields = Object.entries(health).map(([k, v]) => `<span><span class="label">${esc(k)}:</span> ${esc(String(v))}</span>`).join('');
  html += `<div class="card"><div class="site-header"><div class="dot ok"></div><div class="domain">TEE Server</div></div><div class="meta-row">${healthFields}</div></div>`;

  const syncedSites = (sites || []).filter(s => s.syncEnabled);
  if (!syncedSites.length) {
    html += '<div class="card" style="color:#888">No synced domains to compare.</div>';
  } else {
    const localCounts = await Promise.all(syncedSites.map(async s => {
      const cookies = await chrome.cookies.getAll({ domain: s.domain });
      return { domain: s.domain, local: cookies.length, lastUpload: s.lastUpload, status: s.status };
    }));

    // GET /cookies may not exist yet on TEE server
    let remoteCounts = null;
    const remoteRes = await fetch(`${DSTACK_URL}/cookies`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    if (remoteRes.ok) remoteCounts = await remoteRes.json();

    html += '<h2>Cookie Sync Status</h2><div class="card"><table class="tee-table"><thead><tr><th>Domain</th><th>Local</th><th>Remote</th><th>Last Sync</th><th>Status</th></tr></thead><tbody>';
    for (const row of localCounts) {
      const remoteCount = remoteCounts?.domains?.[row.domain]?.count;
      const remoteStr = remoteCount != null ? String(remoteCount) : '—';
      const matchClass = remoteCount != null ? (remoteCount === row.local ? 'sync-match' : 'sync-mismatch') : '';
      const dotClass = row.status || 'pending';
      const syncTime = row.lastUpload ? timeAgo(row.lastUpload) : 'never';
      html += `<tr><td>${esc(row.domain)}</td><td>${row.local}</td><td class="${matchClass}">${remoteStr}</td><td>${syncTime}</td><td><span class="dot ${dotClass}" style="display:inline-block"></span></td></tr>`;
    }
    html += '</tbody></table></div>';

    if (remoteCounts && !remoteCounts.domains) {
      html += `<h2>Remote Response</h2><div class="card"><pre style="font-size:12px;color:#888;white-space:pre-wrap">${esc(JSON.stringify(remoteCounts, null, 2))}</pre></div>`;
    }
  }

  el.innerHTML = html;
}

const _loadTeePanelInner = loadTeePanel;
loadTeePanel = async function () {
  try { await _loadTeePanelInner(); }
  catch (e) { document.getElementById('tee-content').innerHTML = `<div class="tee-error">${esc(e.stack || e.message)}</div>`; }
};

// --- Feedling tab ---

const FEEDLING_CATEGORIES = {
  Music: ['music', 'song', 'album', 'live', 'concert', 'dj set', 'jazz', 'funk', 'rock', 'remix', 'guitar', 'piano'],
  Tech: ['code', 'programming', 'python', 'javascript', 'react', 'tutorial', 'dev', 'api', 'linux', 'ai', 'gpt'],
  Gaming: ['gameplay', 'playthrough', 'gaming', 'game', 'minecraft', 'speedrun'],
  Education: ['explained', 'how to', 'learn', 'course', 'lecture', 'documentary', 'science'],
  Entertainment: ['podcast', 'interview', 'comedy', 'funny', 'reaction', 'vlog', 'review'],
  'News/Commentary': ['news', 'politics', 'analysis', 'debate', 'opinion', 'breaking']
};

function buildFeedlingActivity(ytItems, ttItems, dietTimeLog, dietShortsLog) {
  const d = new Date().toISOString().slice(0, 10);
  const todayTime = dietTimeLog[d] || {};
  const screenTimeMinutes = Math.round(Object.values(todayTime).reduce((a, b) => a + b, 0) / 60);
  const todayShorts = dietShortsLog[d] || {};
  const shortsCount = Object.values(todayShorts).reduce((a, b) => a + b, 0);

  const categories = {};
  const allTexts = [
    ...ytItems.map(v => ((v.title || '') + ' ' + (v.channel || '')).toLowerCase()),
    ...ttItems.map(v => ((v.title || '') + ' ' + (v.author || '')).toLowerCase())
  ];
  for (const text of allTexts) {
    let matched = false;
    for (const [cat, kws] of Object.entries(FEEDLING_CATEGORIES)) {
      if (kws.some(kw => text.includes(kw))) { categories[cat] = (categories[cat] || 0) + 1; matched = true; break; }
    }
    if (!matched) categories['Other'] = (categories['Other'] || 0) + 1;
  }

  return { shortsCount, screenTimeMinutes, categories, timestamp: Date.now() };
}

async function getFeedlingActivity() {
  const { ytHistory, ttHistory, dietTimeLog = {}, dietShortsLog = {} } = await chrome.storage.local.get(['ytHistory', 'ttHistory', 'dietTimeLog', 'dietShortsLog']);
  const ytItems = ytHistory?.items || [];
  const ttItems = ttHistory?.items || [];
  return buildFeedlingActivity(ytItems, ttItems, dietTimeLog, dietShortsLog);
}

async function renderFeedlingTab() {
  const { feedlingEnabled, feedlingLastSync, feedlingLastError } = await chrome.storage.local.get(['feedlingEnabled', 'feedlingLastSync', 'feedlingLastError']);
  const toggle = document.getElementById('feedling-toggle');
  toggle.checked = !!feedlingEnabled;
  toggle.onchange = async () => {
    await chrome.storage.local.set({ feedlingEnabled: toggle.checked });
    renderFeedlingTab();
  };

  const statusEl = document.getElementById('feedling-status');
  if (feedlingLastSync) statusEl.innerHTML = `Last sync: <span style="color:#22c55e">${timeAgo(feedlingLastSync)}</span>`;
  else if (feedlingLastError) statusEl.innerHTML = `Last error: <span style="color:#ef4444">${esc(feedlingLastError)}</span>`;
  else statusEl.textContent = feedlingEnabled ? 'Waiting for first sync...' : 'Disabled';

  const preview = document.getElementById('feedling-preview');
  const activity = await getFeedlingActivity();

  let html = '<h2>Activity Preview</h2><div class="card">';
  html += `<div class="stats-grid">
    <div class="stat-card"><div class="value">${activity.shortsCount}</div><div class="label">Shorts Today</div></div>
    <div class="stat-card"><div class="value">${activity.screenTimeMinutes}m</div><div class="label">Screen Time</div></div>
  </div>`;

  const cats = Object.entries(activity.categories).sort((a, b) => b[1] - a[1]);
  if (cats.length) {
    const total = cats.reduce((s, [, n]) => s + n, 0);
    const catColors = { Music: '#a855f7', Tech: '#3b82f6', Gaming: '#22c55e', Education: '#eab308', Entertainment: '#f97316', 'News/Commentary': '#ef4444', Other: '#555' };
    html += '<h3>Categories</h3>';
    for (const [cat, count] of cats) {
      const pct = (count / total * 100);
      const color = catColors[cat] || '#555';
      html += `<div class="cat-row">
        <div class="cat-name">${esc(cat)}</div>
        <div class="cat-bar-bg"><div class="cat-bar" style="width:${pct.toFixed(0)}%;background:${color}"></div></div>
        <div class="cat-pct">${pct.toFixed(0)}%</div>
      </div>`;
    }
  }
  html += '</div>';
  preview.innerHTML = html;
}

// --- Utils ---
function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// --- Feed Browser ---
const FB_DEFAULT_URL = 'https://7f5dee210fd22e418cf0999280226355d6cfa913-3012.dstack-pha-prod7.phala.network';

async function renderFeedBrowser() {
  const { bridgeUrl, novncUrl } = await chrome.storage.local.get({ bridgeUrl: FB_DEFAULT_URL, novncUrl: 'https://7f5dee210fd22e418cf0999280226355d6cfa913-8080.dstack-pha-prod7.phala.network' });
  document.getElementById('fb-bridge-url').value = bridgeUrl;
  document.getElementById('fb-novnc-url').value = novncUrl;
  checkBridgeStatus(bridgeUrl);
}

async function checkBridgeStatus(url) {
  const dot = document.getElementById('fb-status-dot');
  const text = document.getElementById('fb-status-text');
  try {
    const res = await fetch(url + '/health');
    if (!res.ok) throw new Error(res.status);
    dot.className = 'dot ok';
    text.textContent = 'Connected';
  } catch {
    dot.className = 'dot error';
    text.textContent = 'Disconnected';
  }
}

async function sendBridgeCommand(tool, args) {
  const { bridgeUrl } = await chrome.storage.local.get({ bridgeUrl: FB_DEFAULT_URL });
  const res = await fetch(bridgeUrl + '/api/bridge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'h-' + Date.now(), tool, args })
  });
  const data = await res.json();
  const log = document.getElementById('fb-log');
  log.textContent = `[${new Date().toLocaleTimeString()}] ${tool}(${JSON.stringify(args)}) → ${res.status}\n` + log.textContent;
  return data;
}

document.getElementById('fb-save-url').addEventListener('click', async () => {
  const url = document.getElementById('fb-bridge-url').value.trim();
  const novnc = document.getElementById('fb-novnc-url').value.trim();
  await chrome.storage.local.set({ bridgeUrl: url, novncUrl: novnc });
  checkBridgeStatus(url);
});

document.getElementById('fb-nav-yt').addEventListener('click', () => sendBridgeCommand('navigate', ['https://www.youtube.com/feed/history']));
document.getElementById('fb-nav-tt').addEventListener('click', () => sendBridgeCommand('navigate', ['https://www.tiktok.com/tpp/watch-history']));

document.getElementById('fb-nav-tee-dash').addEventListener('click', async () => {
  sendBridgeCommand('navigate', ['http://localhost:3000/dashboard']);
});

document.getElementById('fb-scroll-up').addEventListener('click', () => sendBridgeCommand('scroll', [0, -500]));
document.getElementById('fb-scroll-down').addEventListener('click', () => sendBridgeCommand('scroll', [0, 500]));

document.getElementById('fb-viewer-toggle').addEventListener('click', async () => {
  const iframe = document.getElementById('fb-viewer-iframe');
  const btn = document.getElementById('fb-viewer-toggle');
  if (iframe.style.display === 'none') {
    const { novncUrl } = await chrome.storage.local.get({ novncUrl: 'https://7f5dee210fd22e418cf0999280226355d6cfa913-8080.dstack-pha-prod7.phala.network' });
    iframe.src = novncUrl + (novncUrl.includes('?') ? '&' : '?') + 'pwd=neko&usr=neko';
    iframe.style.display = 'block';
    btn.textContent = 'Hide';
  } else {
    iframe.src = '';
    iframe.style.display = 'none';
    btn.textContent = 'Show';
  }
});

async function injectCookies(domain) {
  const status = document.getElementById('fb-inject-status');
  const { bridgeUrl } = await chrome.storage.local.get({ bridgeUrl: FB_DEFAULT_URL });
  status.textContent = `Injecting ${domain} cookies...`;
  status.style.color = '#eab308';
  const result = await chrome.runtime.sendMessage({ type: 'injectCookies', domain, bridgeUrl });
  const log = document.getElementById('fb-log');
  if (result.error) {
    status.textContent = `Failed: ${result.error}`;
    status.style.color = '#ef4444';
    log.textContent = `[${new Date().toLocaleTimeString()}] injectCookies(${domain}) → ERROR: ${result.error}\n` + log.textContent;
  } else {
    const parts = [`${result.set} set via CDP`];
    if (result.failed) parts.push(`${result.failed} failed`);
    status.textContent = `Injected ${result.set}/${result.total} cookies (${parts.join(', ')})`;
    status.style.color = result.failed ? '#eab308' : '#22c55e';
    log.textContent = `[${new Date().toLocaleTimeString()}] injectCookies(${domain}) → ${result.set}/${result.total} via CDP\n` + log.textContent;
  }
}

document.getElementById('fb-inject-yt').addEventListener('click', () => injectCookies('youtube.com'));
document.getElementById('fb-inject-tt').addEventListener('click', () => injectCookies('tiktok.com'));


const TT_FETCH_SCRIPT = `
(function() {
  var qs = new URLSearchParams({
    scene: '1', count: '20', timezone_offset: String(new Date().getTimezoneOffset() * -60),
    aid: '1180', device_type: 'web_h264', screen_width: '1920', screen_height: '1080',
    browser_language: navigator.language, browser_name: 'Mozilla', browser_online: 'true',
    browser_platform: navigator.platform, app_language: 'en-US', app_name: 'tiktok_web',
    channel: 'tiktok_web', cookie_enabled: 'true', device_platform: 'web_pc',
    from_page: 'watch_history', history_len: '4', os: 'windows', region: 'US',
    user_is_login: 'true', referer: 'https://www.tiktok.com/tpp/watch-history', webcast_language: 'en'
  }).toString();
  return fetch('https://www.tiktok.com/tiktok/watch/history/list/v1/?' + qs, {credentials: 'same-origin'})
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.status_code !== 0) return {error: 'TikTok API error ' + data.status_code + ': ' + (data.status_msg || 'unknown')};
      var timestamps = data.aweme_watch_history || [];
      var list = data.aweme_list || [];
      var firstTs = timestamps[0] ? parseInt(timestamps[0]) : null;
      var lastTs = timestamps.length > 1 ? parseInt(timestamps[timestamps.length - 1]) : firstTs;
      var items = [];
      for (var i = 0; i < list.length; i++) {
        var v = list[i];
        var watchedAt = null;
        if (firstTs && lastTs && list.length > 1) watchedAt = firstTs + (lastTs - firstTs) * i / (list.length - 1);
        else if (firstTs) watchedAt = firstTs;
        var a = v.author || {};
        items.push({
          id: v.aweme_id, title: v.desc || '', author: a.nickname || a.unique_id || '',
          authorId: a.unique_id || '', duration: Math.round((v.video && v.video.duration || 0) / 1000),
          watchedAt: watchedAt, plays: (v.statistics && v.statistics.play_count) || 0,
          likes: (v.statistics && v.statistics.digg_count) || 0,
          comments: (v.statistics && v.statistics.comment_count) || 0,
          cover: v.video && v.video.cover && v.video.cover.url_list && v.video.cover.url_list[0] || '',
          url: 'https://www.tiktok.com/@' + (a.unique_id || '') + '/video/' + v.aweme_id
        });
      }
      return {items: items, count: items.length, hasMore: !!data.has_more};
    });
})()`;

async function fetchTikTokOnTEE() {
  const status = document.getElementById('fb-sync-status');
  status.textContent = 'Navigating to TikTok...';
  status.style.color = '#eab308';
  await sendBridgeCommand('navigate', ['https://www.tiktok.com/tpp/watch-history']);
  await new Promise(r => setTimeout(r, 3000));
  status.textContent = 'Fetching TikTok watch history...';
  const res = await sendBridgeCommand('evaluate', [TT_FETCH_SCRIPT]);
  const result = res?.result;
  if (!result || result.error) {
    status.textContent = result?.error || 'Failed to fetch TikTok history';
    status.style.color = '#ef4444';
    return;
  }
  const { bridgeUrl } = await chrome.storage.local.get({ bridgeUrl: FB_DEFAULT_URL });
  await fetch((bridgeUrl || FB_DEFAULT_URL) + '/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttHistory: { items: result.items, lastSync: Date.now() } })
  });
  status.textContent = `TEE fetched ${result.count} TikTok items`;
  status.style.color = '#22c55e';
  fbLog(`TEE independently fetched ${result.count} TikTok history items`);
}

document.getElementById('fb-sync-history').addEventListener('click', fetchTikTokOnTEE);
document.getElementById('fb-sync-and-view').addEventListener('click', async () => {
  try { await fetchTikTokOnTEE(); } catch (e) { fbLog('Fetch error: ' + e.message); }
  await new Promise(r => setTimeout(r, 1500));
  await sendBridgeCommand('navigate', ['http://localhost:3000/dashboard']);
  fbLog('Navigated to TEE dashboard');
});

// --- Auto-Scroll & Capture ---
let fbScrollTimer = null;
let fbCapturedPosts = [];
let fbStallCount = 0;
let fbCaptchaPaused = false;
let fbCaptchaPollTimer = null;
let fbPausedPlatform = null;

const CAPTCHA_DETECTOR = `
(function() {
  const url = window.location.href;
  const captchaUrlPatterns = ['/sorry/', '/challenge/', '/recaptcha/', 'challenges.cloudflare.com'];
  const urlMatch = captchaUrlPatterns.some(p => url.includes(p));
  const iframes = document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="arkose"], iframe[src*="funcaptcha"], iframe[src*="challenge"]');
  const domMatch = iframes.length > 0;
  const detected = urlMatch || domMatch;
  const reason = urlMatch ? 'Captcha URL detected: ' + url : domMatch ? 'Captcha iframe found on page' : '';
  return { detected, reason, url };
})()
`;

async function generateRoast(post) {
  const { dietSettings } = await chrome.storage.local.get('dietSettings');
  const apiKey = dietSettings && dietSettings.anthropicKey;
  if (!apiKey) throw new Error('No Anthropic API key configured in diet settings');
  const label = post.title !== undefined
    ? `"${post.title}" by ${post.channel}${post.duration ? ' (' + post.duration + ')' : ''}`
    : `"${post.description}" by @${post.creator}${post.likes ? ' (' + post.likes + ' likes)' : ''}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 100,
      messages: [{ role: 'user', content: `You are a witty feed commentator. Given this post: ${label}, write a short (1-2 sentence) genuinely funny commentary. Be playful, not mean.` }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = await res.json();
  return data.content[0].text;
}

function appendRoastLog(post, roastText) {
  const log = document.getElementById('fb-roast-log');
  const entry = document.createElement('div');
  entry.style.cssText = 'padding:6px 0;border-bottom:1px solid #1a1a1a';
  const title = post.title !== undefined ? post.title : post.description;
  const titleSpan = document.createElement('span');
  titleSpan.style.color = '#888';
  titleSpan.textContent = title.length > 60 ? title.slice(0, 60) + '…' : title;
  const br = document.createElement('br');
  const roastSpan = document.createElement('span');
  roastSpan.style.cssText = 'color:#a78bfa;font-style:italic';
  roastSpan.textContent = roastText;
  entry.appendChild(titleSpan);
  entry.appendChild(br);
  entry.appendChild(roastSpan);
  log.prepend(entry);
}

function fbPostKey(post) {
  if (post.title) return post.title + '|' + post.channel;
  return post.description + '|' + post.creator;
}

async function fbDetectPlatform() {
  const data = await sendBridgeCommand('evaluate', [FEED_SCROLLER_DETECT]);
  const raw = data && data.result;
  if (raw && typeof raw === 'object' && raw.__evalError) throw new Error(raw.__evalError);
  const host = raw || '';
  const el = document.getElementById('fb-platform');
  if (host.includes('youtube')) { el.textContent = 'YouTube'; return 'youtube'; }
  if (host.includes('tiktok')) { el.textContent = 'TikTok'; return 'tiktok'; }
  el.textContent = host || 'Unknown';
  return null;
}

function renderCapturedPosts() {
  document.getElementById('fb-post-count').textContent = `${fbCapturedPosts.length} posts captured`;
  const container = document.getElementById('fb-captured-posts');
  container.textContent = '';
  for (let i = 0; i < fbCapturedPosts.length; i++) {
    const p = fbCapturedPosts[i];
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;padding:6px 0;border-bottom:1px solid #1a1a1a;font-size:12px;align-items:center';
    const num = document.createElement('span');
    num.style.cssText = 'color:#555;width:24px;text-align:right';
    num.textContent = i + 1;
    row.appendChild(num);
    if (p.title !== undefined) {
      if (p.thumbnail) {
        const img = document.createElement('img');
        img.src = p.thumbnail;
        img.style.cssText = 'width:60px;height:34px;object-fit:cover;border-radius:4px;background:#1a1a1a;flex-shrink:0';
        row.appendChild(img);
      }
      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';
      const titleEl = document.createElement('div');
      titleEl.style.cssText = 'color:#e5e5e5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      titleEl.textContent = p.title;
      const metaEl = document.createElement('div');
      metaEl.style.color = '#888';
      metaEl.textContent = p.channel + (p.duration ? ' \u00b7 ' + p.duration : '');
      info.appendChild(titleEl);
      info.appendChild(metaEl);
      row.appendChild(info);
    } else {
      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';
      const descEl = document.createElement('div');
      descEl.style.cssText = 'color:#e5e5e5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      descEl.textContent = p.description;
      const metaEl = document.createElement('div');
      metaEl.style.color = '#888';
      metaEl.textContent = '@' + p.creator + (p.likes ? ' \u00b7 ' + p.likes + ' likes' : '') + (p.comments ? ' \u00b7 ' + p.comments + ' comments' : '');
      info.appendChild(descEl);
      info.appendChild(metaEl);
      row.appendChild(info);
    }
    const roastEl = document.createElement('div');
    roastEl.style.cssText = 'color:#a78bfa;font-style:italic;font-size:11px;padding-left:32px;padding-bottom:4px';
    roastEl.id = 'fb-roast-' + i;
    roastEl.textContent = p.roast || '';
    container.appendChild(row);
    container.appendChild(roastEl);
  }
}

async function fbScrollTick(platform) {
  const script = platform === 'youtube' ? FEED_SCROLLER_YT : FEED_SCROLLER_TT;
  const data = await sendBridgeCommand('evaluate', [script]);
  const raw = data && data.result;
  if (raw && typeof raw === 'object' && raw.__evalError) throw new Error(raw.__evalError);
  const posts = raw || [];
  const seen = new Set(fbCapturedPosts.map(fbPostKey));
  let added = 0;
  for (const p of posts) {
    const key = fbPostKey(p);
    if (!seen.has(key)) {
      seen.add(key);
      fbCapturedPosts.push(p);
      added++;
      const idx = fbCapturedPosts.length - 1;
      generateRoast(p).then(text => {
        p.roast = text;
        const el = document.getElementById('fb-roast-' + idx);
        if (el) el.textContent = text;
        appendRoastLog(p, text);
      }).catch(e => { console.error('generateRoast failed:', e); throw e; });
    }
  }
  if (added) {
    fbStallCount = 0;
    renderCapturedPosts();
  } else {
    fbStallCount++;
  }

  const captchaData = await sendBridgeCommand('evaluate', [CAPTCHA_DETECTOR]);
  const captchaRaw = captchaData && captchaData.result;
  const captchaResult = (captchaRaw && typeof captchaRaw === 'object' && !captchaRaw.__evalError) ? captchaRaw : { detected: false };
  const stallDetected = fbStallCount >= 3;
  if (captchaResult.detected || stallDetected) {
    const reason = captchaResult.detected ? captchaResult.reason : `Content stalled (${fbStallCount} scrolls with no new posts)`;
    fbCaptchaPaused = true;
    fbPausedPlatform = platform;
    clearInterval(fbScrollTimer);
    fbScrollTimer = null;
    document.getElementById('fb-auto-start').disabled = true;
    document.getElementById('fb-auto-stop').disabled = true;
    const log = document.getElementById('fb-log');
    log.textContent = `[${new Date().toLocaleTimeString()}] CAPTCHA: ${reason} — paused\n` + log.textContent;
    const { novncUrl } = await chrome.storage.local.get({ novncUrl: 'https://7f5dee210fd22e418cf0999280226355d6cfa913-8080.dstack-pha-prod7.phala.network' });
    chrome.runtime.sendMessage({ type: 'captchaDetected', reason, novncUrl });
    startCaptchaPoll(platform);
  }
}

function startCaptchaPoll(platform) {
  if (fbCaptchaPollTimer) clearInterval(fbCaptchaPollTimer);
  fbCaptchaPollTimer = setInterval(async () => {
    const captchaData = await sendBridgeCommand('evaluate', [CAPTCHA_DETECTOR]);
    const captchaRaw = captchaData && captchaData.result;
    const captchaResult = (captchaRaw && typeof captchaRaw === 'object' && !captchaRaw.__evalError) ? captchaRaw : { detected: false };
    if (captchaResult.detected) return;
    const script = platform === 'youtube' ? FEED_SCROLLER_YT : FEED_SCROLLER_TT;
    const data = await sendBridgeCommand('evaluate', [script]);
    const raw = data && data.result;
    const posts = (raw && !raw.__evalError) ? raw : [];
    const seen = new Set(fbCapturedPosts.map(fbPostKey));
    const hasNew = posts.some(p => !seen.has(fbPostKey(p)));
    if (!captchaResult.detected && (hasNew || fbStallCount < 3)) {
      clearInterval(fbCaptchaPollTimer);
      fbCaptchaPollTimer = null;
      fbStallCount = 0;
      fbCaptchaPaused = false;
      fbPausedPlatform = null;
      const log = document.getElementById('fb-log');
      log.textContent = `[${new Date().toLocaleTimeString()}] CAPTCHA resolved — resuming\n` + log.textContent;
      chrome.runtime.sendMessage({ type: 'captchaResolved' });
      const interval = parseInt(document.getElementById('fb-scroll-interval').value) || 5000;
      document.getElementById('fb-auto-start').disabled = true;
      document.getElementById('fb-auto-stop').disabled = false;
      fbScrollTick(platform);
      fbScrollTimer = setInterval(() => fbScrollTick(platform), interval);
    }
  }, 5000);
}

async function startAutoScroll() {
  let platform;
  try {
    platform = await fbDetectPlatform();
  } catch (e) {
    document.getElementById('fb-log').textContent = `[${new Date().toLocaleTimeString()}] Platform detection error: ${e.message}\n` + document.getElementById('fb-log').textContent;
    return;
  }
  if (!platform) {
    document.getElementById('fb-log').textContent = `[${new Date().toLocaleTimeString()}] Cannot detect platform — navigate to YouTube or TikTok first\n` + document.getElementById('fb-log').textContent;
    return;
  }
  const interval = parseInt(document.getElementById('fb-scroll-interval').value) || 5000;
  document.getElementById('fb-auto-start').disabled = true;
  document.getElementById('fb-auto-stop').disabled = false;
  fbScrollTick(platform);
  fbScrollTimer = setInterval(() => fbScrollTick(platform), interval);
}

function stopAutoScroll() {
  clearInterval(fbScrollTimer);
  fbScrollTimer = null;
  document.getElementById('fb-auto-start').disabled = false;
  document.getElementById('fb-auto-stop').disabled = true;
}

document.getElementById('fb-auto-start').addEventListener('click', startAutoScroll);
document.getElementById('fb-auto-stop').addEventListener('click', stopAutoScroll);
document.getElementById('fb-clear-posts').addEventListener('click', () => {
  fbCapturedPosts = [];
  renderCapturedPosts();
});

// --- Hivemind Sync ---

const HM_DEFAULTS = {
  url: 'https://693d3fa15896bcff98d80cc67103e5ae54499890-8100.dstack-pha-prod7.phala.network',
  key: 'BAbqNXblGE9zqaIu7APlIvO17M3jfVvqmET1IXOER00'
};

async function loadHmConfig() {
  const { hivemindConfig } = await chrome.storage.local.get('hivemindConfig');
  return hivemindConfig || { ...HM_DEFAULTS };
}

async function saveHmConfig(config) {
  await chrome.storage.local.set({ hivemindConfig: config });
}

async function hmStore(sql, params, config) {
  const r = await fetch(`${config.url}/v1/store`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params: params || [] })
  });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

async function renderHivemindTab() {
  const config = await loadHmConfig();
  const configEl = document.getElementById('hm-config');
  const statusEl = document.getElementById('hm-status');
  const actionsEl = document.getElementById('hm-actions');
  const logEl = document.getElementById('hm-log');

  configEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;max-width:500px">
      <label style="font-size:12px;color:#888">Hivemind URL</label>
      <input id="hm-url" type="text" value="${config.url}" style="background:#1a1a1a;border:1px solid #333;color:#e5e5e5;padding:6px 10px;border-radius:4px;font-size:12px;font-family:inherit">
      <label style="font-size:12px;color:#888">API Key</label>
      <input id="hm-key" type="text" value="${config.key}" style="background:#1a1a1a;border:1px solid #333;color:#e5e5e5;padding:6px 10px;border-radius:4px;font-size:12px;font-family:inherit">
      <button class="btn" id="hm-save-config" style="width:fit-content">Save Config</button>
    </div>`;

  actionsEl.innerHTML = `
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn primary" id="hm-check">Check Status</button>
      <button class="btn primary" id="hm-sync">Sync New</button>
    </div>`;

  document.getElementById('hm-save-config').addEventListener('click', async () => {
    const c = { url: document.getElementById('hm-url').value.trim(), key: document.getElementById('hm-key').value.trim() };
    await saveHmConfig(c);
    statusEl.innerHTML = '<span style="color:#22c55e">Config saved</span>';
  });

  document.getElementById('hm-check').addEventListener('click', () => hmCheckStatus());
  document.getElementById('hm-sync').addEventListener('click', () => hmSyncNew());
}

function hmLog(msg) {
  const el = document.getElementById('hm-log');
  el.innerHTML = `<div>${msg}</div>` + el.innerHTML;
}

async function hmCheckStatus() {
  const statusEl = document.getElementById('hm-status');
  statusEl.innerHTML = '<span style="color:#888">Checking...</span>';

  try {
    const config = await loadHmConfig();
    const granted = await chrome.permissions.request({ origins: [`${new URL(config.url).origin}/*`] });
    if (!granted) { statusEl.innerHTML = '<span style="color:#ef4444">Permission denied</span>'; return; }

    const store = await loadYtStore();
    const localCount = store.items ? store.items.length : 0;

    const remoteResult = await hmStore('SELECT COUNT(*) as cnt FROM watch_history', [], config);
    const remoteCount = remoteResult.rows?.[0]?.cnt || 0;

    statusEl.innerHTML = `
      <div style="display:flex;gap:24px;padding:12px;background:#1a1a1a;border-radius:6px;border:1px solid #262626">
        <div><span style="color:#888;font-size:11px">LOCAL</span><br><span style="font-size:20px;color:#2563eb">${localCount}</span></div>
        <div><span style="color:#888;font-size:11px">REMOTE</span><br><span style="font-size:20px;color:#22c55e">${remoteCount}</span></div>
        <div><span style="color:#888;font-size:11px">DELTA</span><br><span style="font-size:20px;color:#f59e0b">${localCount > remoteCount ? '+' + (localCount - remoteCount) : '0'}</span></div>
      </div>`;
  } catch (e) {
    statusEl.innerHTML = `<span style="color:#ef4444">Error: ${e.message}</span>`;
  }
}

async function hmSyncNew() {
  const statusEl = document.getElementById('hm-status');
  const logEl = document.getElementById('hm-log');
  logEl.innerHTML = '';

  try {
    const config = await loadHmConfig();
    const granted = await chrome.permissions.request({ origins: [`${new URL(config.url).origin}/*`] });
    if (!granted) { statusEl.innerHTML = '<span style="color:#ef4444">Permission denied</span>'; return; }

    statusEl.innerHTML = '<span style="color:#888">Loading local history...</span>';
    const store = await loadYtStore();
    if (!store.items?.length) { statusEl.innerHTML = '<span style="color:#f59e0b">No local history to sync</span>'; return; }

    statusEl.innerHTML = '<span style="color:#888">Fetching remote video IDs...</span>';
    const remoteResult = await hmStore('SELECT video_id FROM watch_history', [], config);
    const remoteIds = new Set((remoteResult.rows || []).map(r => r.video_id));
    hmLog(`Remote has ${remoteIds.size} videos`);

    const newItems = store.items.filter(v => v.id && !remoteIds.has(v.id));
    hmLog(`${newItems.length} new items to sync`);

    if (!newItems.length) {
      statusEl.innerHTML = '<span style="color:#22c55e">Already in sync!</span>';
      return;
    }

    let synced = 0;
    for (const item of newItems) {
      const ts = item.date ? new Date(item.date).toISOString() : null;
      await hmStore(
        'INSERT INTO watch_history (video_id, title, url, is_short, views, watched_at) VALUES (%s, %s, %s, %s, %s, %s)',
        [item.id, item.title || '', item.url || '', item.isShort || false, item.views || '', ts],
        config
      );
      synced++;
      if (synced % 10 === 0 || synced === newItems.length) {
        statusEl.innerHTML = `<span style="color:#2563eb">Syncing ${synced}/${newItems.length}...</span>`;
      }
    }

    hmLog(`Synced ${synced} new items`);
    statusEl.innerHTML = `<span style="color:#22c55e">Done! Synced ${synced} new items</span>`;
    setTimeout(() => hmCheckStatus(), 500);
  } catch (e) {
    statusEl.innerHTML = `<span style="color:#ef4444">Error: ${e.message}</span>`;
    hmLog(`Error: ${e.message}`);
  }
}

init();
