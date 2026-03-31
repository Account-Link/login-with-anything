const DSTACK_URL = 'https://tee.oauth3-stage.monerolink.com';

const debounceTimers = {};
const shortsDedup = {};
let captchaNovncUrl = null;

async function ensureOwnerToken() {
  const { ownerToken, accountEmail } = await chrome.storage.local.get(['ownerToken', 'accountEmail']);
  if (ownerToken) {
    try {
      const payload = JSON.parse(atob(ownerToken.split('.')[1]));
      if (payload.exp && payload.exp > Date.now() / 1000) return ownerToken;
    } catch {}
  }
  const res = await fetch(`${DSTACK_URL}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'owner', email: accountEmail || undefined })
  });
  if (!res.ok) throw new Error(`Signup failed: ${res.status}`);
  const data = await res.json();
  await chrome.storage.local.set({ ownerToken: data.token });
  return data.token;
}

async function migrateTrackedSites() {
  const { trackedSites } = await chrome.storage.local.get('trackedSites');
  if (!trackedSites) return;
  let changed = false;
  for (const site of trackedSites) {
    if (site.syncEnabled === undefined) {
      site.syncEnabled = false;
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ trackedSites });
}

async function syncAllTracked() {
  const { trackedSites } = await chrome.storage.local.get('trackedSites');
  if (!trackedSites) return;
  for (const site of trackedSites) {
    if (site.syncEnabled) uploadCookies(site.domain).catch(() => {});
  }
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

async function clearStaleShortsSession() {
  await chrome.storage.local.remove('dietShortsSession');
  await chrome.alarms.clear('shorts-escalation');
}

chrome.runtime.onStartup.addListener(() => { clearStaleShortsSession(); migrateTrackedSites().then(syncAllTracked); });
chrome.runtime.onInstalled.addListener(() => {
  clearStaleShortsSession();
  migrateTrackedSites().then(syncAllTracked);
  chrome.alarms.create('cookie-sync', { periodInMinutes: 30 });
  chrome.alarms.create('diet-tick', { periodInMinutes: 1 });
  scheduleWeeklyDigest();
});
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'cookie-sync') syncAllTracked();
  if (a.name === 'diet-tick') dietTick();
  if (a.name === 'shorts-escalation') shortsEscalation();
  if (a.name === 'weekly-digest') weeklyDigest();
});

chrome.cookies.onChanged.addListener(async ({ cookie }) => {
  const { trackedSites } = await chrome.storage.local.get('trackedSites');
  if (!trackedSites) return;
  const domain = cookie.domain.replace(/^\./, '');
  const site = trackedSites.find(s => domain.endsWith(s.domain));
  if (!site || !site.syncEnabled) return;

  clearTimeout(debounceTimers[site.domain]);
  debounceTimers[site.domain] = setTimeout(() => uploadCookies(site.domain), 500);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'uploadCookies') {
    uploadCookies(msg.domain).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'syncAll') {
    syncAllTracked().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'shortsNavigation') {
    const tabId = _sender.tab?.id;
    dedupedShortsNav(tabId, msg.platform).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'captchaDetected') {
    captchaNovncUrl = msg.novncUrl || null;
    chrome.notifications.create('captcha-alert', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Captcha needs solving',
      message: msg.reason || 'Captcha detected'
    });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'captchaResolved') {
    chrome.notifications.create('captcha-resolved', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Captcha solved, resuming',
      message: 'The captcha has been resolved. Scrolling resumed.'
    });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'injectCookies') {
    (async () => {
      const { domain, bridgeUrl } = msg;
      let cookies = await chrome.cookies.getAll({ domain });
      if (domain === 'youtube.com') {
        const gCookies = await chrome.cookies.getAll({ domain: '.google.com' });
        cookies = [...cookies, ...gCookies];
      }
      if (!cookies.length) throw new Error(`No cookies for ${domain}`);

      const res = await fetch(bridgeUrl + '/api/bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'inject-' + Date.now(), tool: 'setCookies', args: [cookies] })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'setCookies failed');
      sendResponse({ set: data.result.set, failed: data.result.failed, total: cookies.length });
    })().catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'setSyncEnabled') {
    (async () => {
      const { trackedSites } = await chrome.storage.local.get('trackedSites');
      if (!trackedSites) throw new Error('No tracked sites');
      const idx = trackedSites.findIndex(s => s.domain === msg.domain);
      if (idx === -1) throw new Error('Site not found');
      trackedSites[idx].syncEnabled = msg.enabled;
      await chrome.storage.local.set({ trackedSites });
      // Respond immediately so the popup can re-render with the correct state.
      // Upload is best-effort — failure doesn't roll back the preference.
      sendResponse({ ok: true });
      if (msg.enabled) uploadCookies(msg.domain).catch(e => console.error('uploadCookies:', e));
    })().catch(e => sendResponse({ error: e.message }));
    return true;
  }
});

chrome.notifications.onClicked.addListener(notificationId => {
  if (notificationId === 'captcha-alert' && captchaNovncUrl) {
    chrome.tabs.create({ url: captchaNovncUrl });
  }
});

async function uploadCookies(domain) {
  const ownerToken = await ensureOwnerToken();
  const { trackedSites } = await chrome.storage.local.get('trackedSites');
  if (!trackedSites) throw new Error('No tracked sites');

  let cookies = await chrome.cookies.getAll({ domain });
  // YouTube auth requires Google-domain cookies (SID, SAPISID, etc.)
  if (domain === 'youtube.com') {
    const gCookies = await chrome.cookies.getAll({ domain: '.google.com' });
    cookies = [...cookies, ...gCookies];
  }
  if (!cookies.length) throw new Error(`No cookies for ${domain}`);

  let res = await fetch(`${DSTACK_URL}/cookies/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({
      domain,
      cookies: cookies.map(c => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
        expirationDate: c.expirationDate
      })),
      user_agent: navigator.userAgent
    })
  });
  if (res.status === 401) {
    await chrome.storage.local.remove('ownerToken');
    const freshToken = await ensureOwnerToken();
    res = await fetch(`${DSTACK_URL}/cookies/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshToken}` },
      body: JSON.stringify({
        domain,
        cookies: cookies.map(c => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
          expirationDate: c.expirationDate
        })),
        user_agent: navigator.userAgent
      })
    });
  }
  if (!res.ok) throw new Error(`Upload ${res.status}: ${await res.text().catch(() => '')}`);

  const idx = trackedSites.findIndex(s => s.domain === domain);
  if (idx !== -1) {
    trackedSites[idx].lastUpload = Date.now();
    trackedSites[idx].status = 'ok';
    await chrome.storage.local.set({ trackedSites });
  }

  const { syncHealth = {} } = await chrome.storage.local.get('syncHealth');
  syncHealth.lastCookieSync = Date.now();
  await chrome.storage.local.set({ syncHealth });
}

// --- Information Diet ---

const SHORTS_PATTERNS = [
  { hostSuffix: 'youtube.com', pathPrefix: '/shorts/' },
  { hostSuffix: 'tiktok.com', pathPrefix: '/@' },
  { hostSuffix: 'tiktok.com', pathPrefix: '/foryou' },
  { hostSuffix: 'tiktok.com', pathPrefix: '/video/' },
  { hostSuffix: 'instagram.com', pathPrefix: '/reels/' }
];

function isShortsUrl(url) {
  const u = new URL(url);
  for (const p of SHORTS_PATTERNS) {
    if (!u.hostname.endsWith(p.hostSuffix)) continue;
    if (!u.pathname.startsWith(p.pathPrefix)) continue;
    if (p.pathPrefix === '/@' && !u.pathname.includes('/video/')) continue;
    return true;
  }
  return false;
}

const DEDUP_MS = 2000;

async function dedupedShortsNav(tabId, platform) {
  const now = Date.now();
  const key = tabId || 'no-tab';
  if (shortsDedup[key] && now - shortsDedup[key] < DEDUP_MS) return;
  shortsDedup[key] = now;
  await incrementShortsCount(platform);
  await handleShortsNavigation(tabId, platform);
}

async function handleShortsNavigation(tabId, platform) {
  const settings = await getDietSettings();
  if (!settings.enabled || !settings.shortsAlerts) return;

  const { dietShortsSession } = await chrome.storage.local.get('dietShortsSession');
  if (dietShortsSession && dietShortsSession.domain === platform) {
    if (tabId && !dietShortsSession.tabIds.includes(tabId)) {
      dietShortsSession.tabIds.push(tabId);
      await chrome.storage.local.set({ dietShortsSession });
    }
    return;
  }
  const carryover = dietShortsSession ? (dietShortsSession.carryoverMinutes || 0) + (Date.now() - dietShortsSession.startedAt) / 60000 : 0;
  if (dietShortsSession) {
    await chrome.storage.local.remove('dietShortsSession');
    chrome.alarms.clear('shorts-escalation');
  }
  const tabIds = tabId ? [tabId] : [];
  await chrome.storage.local.set({ dietShortsSession: { startedAt: Date.now(), domain: platform, tabIds, lastNotificationLevel: -1, carryoverMinutes: carryover } });
  if (settings.notificationsEnabled) {
    chrome.notifications.create('shorts-alert', { type: 'basic', iconUrl: 'icon128.png', title: 'Shorts detected', message: `You're watching ${platform} shorts` });
  }
  chrome.alarms.create('shorts-escalation', { periodInMinutes: 1 });
}

async function incrementShortsCount(platform) {
  const { dietShortsLog = {} } = await chrome.storage.local.get('dietShortsLog');
  const d = today();
  if (!dietShortsLog[d]) dietShortsLog[d] = { youtube: 0, tiktok: 0, instagram: 0 };
  dietShortsLog[d][platform]++;
  await chrome.storage.local.set({ dietShortsLog });
}

function today() { return new Date().toISOString().slice(0, 10); }

async function getDietSettings() {
  const { dietSettings } = await chrome.storage.local.get('dietSettings');
  return dietSettings || { enabled: true, notificationsEnabled: true, shortsAlerts: true, thresholds: [5, 15, 30], anthropicKey: '' };
}

// Shorts detection is handled solely by shorts-counter.js content script
// to avoid double-counting with webNavigation.onCompleted.

async function clearShortsIfMatchesTab(tabId) {
  const { dietShortsSession } = await chrome.storage.local.get('dietShortsSession');
  if (!dietShortsSession) return;
  dietShortsSession.tabIds = dietShortsSession.tabIds.filter(id => id !== tabId);
  if (dietShortsSession.tabIds.length === 0) {
    await chrome.storage.local.remove('dietShortsSession');
    chrome.alarms.clear('shorts-escalation');
  } else {
    await chrome.storage.local.set({ dietShortsSession });
  }
}

chrome.tabs.onRemoved.addListener(tabId => clearShortsIfMatchesTab(tabId));

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const { dietShortsSession } = await chrome.storage.local.get('dietShortsSession');
  if (!dietShortsSession || !dietShortsSession.tabIds.includes(tabId)) return;
  if (!isShortsUrl(changeInfo.url)) {
    await clearShortsIfMatchesTab(tabId);
  }
});

async function shortsEscalation() {
  const { dietShortsSession } = await chrome.storage.local.get('dietShortsSession');
  if (!dietShortsSession) { chrome.alarms.clear('shorts-escalation'); return; }

  const settings = await getDietSettings();
  if (!settings.notificationsEnabled) return;

  const elapsed = (dietShortsSession.carryoverMinutes || 0) + (Date.now() - dietShortsSession.startedAt) / 60000;
  let nextLevel = -1;
  for (let i = settings.thresholds.length - 1; i >= 0; i--) {
    if (settings.thresholds[i] <= elapsed && i > dietShortsSession.lastNotificationLevel) { nextLevel = i; break; }
  }
  if (nextLevel === -1) {
    if (dietShortsSession.lastNotificationLevel >= settings.thresholds.length - 1) chrome.alarms.clear('shorts-escalation');
    return;
  }

  dietShortsSession.lastNotificationLevel = nextLevel;
  await chrome.storage.local.set({ dietShortsSession });

  if (nextLevel >= settings.thresholds.length - 1) chrome.alarms.clear('shorts-escalation');

  const mins = Math.round(elapsed);
  const msg = await getEscalationMessage(mins, settings.anthropicKey);
  chrome.notifications.create(`shorts-escalation-${nextLevel}`, { type: 'basic', iconUrl: 'icon128.png', title: `${mins} min on shorts`, message: msg });
}

async function getEscalationMessage(minutes, apiKey) {
  const statics = [
    `${minutes} minutes of shorts. Still scrolling?`,
    `${minutes} minutes gone. What were you going to do instead?`,
    `${minutes} minutes. Your future self is watching.`
  ];
  if (!apiKey) return statics[Math.min(minutes > 20 ? 2 : minutes > 10 ? 1 : 0, statics.length - 1)];

  const { dietTimeLog = {}, dietShortsLog = {} } = await chrome.storage.local.get(['dietTimeLog', 'dietShortsLog']);
  const todayLog = dietShortsLog[today()] || {};
  const todayTime = dietTimeLog[today()] || {};
  const totalScreenMin = Math.round(Object.values(todayTime).reduce((a, b) => a + b, 0) / 60);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 80,
      messages: [{ role: 'user', content: `You're a blunt coach. User has been on shorts for ${minutes} min today. Total screen time: ${totalScreenMin} min. Shorts counts: YT=${todayLog.youtube||0} TT=${todayLog.tiktok||0} IG=${todayLog.instagram||0}. Give a 1-sentence roast to snap them out of it.` }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text;
}

async function dietTick() {
  const settings = await getDietSettings();

  const { dietShortsSession } = await chrome.storage.local.get('dietShortsSession');
  if (dietShortsSession && dietShortsSession.tabIds.length > 0) {
    const tabs = await Promise.all(dietShortsSession.tabIds.map(id => chrome.tabs.get(id).catch(() => null)));
    const alive = tabs.filter(t => t && t.url && isShortsUrl(t.url));
    if (alive.length === 0) {
      await chrome.storage.local.remove('dietShortsSession');
      chrome.alarms.clear('shorts-escalation');
    } else {
      const aliveIds = alive.map(t => t.id);
      if (aliveIds.length !== dietShortsSession.tabIds.length) {
        dietShortsSession.tabIds = aliveIds;
        await chrome.storage.local.set({ dietShortsSession });
      }
    }
  }

  if (!settings.enabled) return;

  // Time tracking
  const win = await chrome.windows.getLastFocused();
  if (!win.focused) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  if (!tab?.url || tab.url.startsWith('chrome://')) return;

  const domain = new URL(tab.url).hostname.replace(/^www\./, '');
  const { dietTimeLog = {} } = await chrome.storage.local.get('dietTimeLog');
  const d = today();
  if (!dietTimeLog[d]) dietTimeLog[d] = {};
  dietTimeLog[d][domain] = (dietTimeLog[d][domain] || 0) + 60;

  // Prune >30 days
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const key of Object.keys(dietTimeLog)) { if (key < cutoffStr) delete dietTimeLog[key]; }

  await chrome.storage.local.set({ dietTimeLog });

  const { feedlingEnabled } = await chrome.storage.local.get('feedlingEnabled');
  if (feedlingEnabled) postFeedlingActivity();
}

async function postFeedlingActivity() {
  const ownerToken = await ensureOwnerToken();
  const { ytHistory, ttHistory, dietTimeLog = {}, dietShortsLog = {} } = await chrome.storage.local.get(['ytHistory', 'ttHistory', 'dietTimeLog', 'dietShortsLog']);

  const d = new Date().toISOString().slice(0, 10);
  const todayTime = dietTimeLog[d] || {};
  const screenTimeMinutes = Math.round(Object.values(todayTime).reduce((a, b) => a + b, 0) / 60);
  const todayShorts = dietShortsLog[d] || {};
  const shortsCount = Object.values(todayShorts).reduce((a, b) => a + b, 0);

  const CATS = {
    Music: ['music', 'song', 'album', 'live', 'concert', 'dj set', 'jazz', 'funk', 'rock', 'remix', 'guitar', 'piano'],
    Tech: ['code', 'programming', 'python', 'javascript', 'react', 'tutorial', 'dev', 'api', 'linux', 'ai', 'gpt'],
    Gaming: ['gameplay', 'playthrough', 'gaming', 'game', 'minecraft', 'speedrun'],
    Education: ['explained', 'how to', 'learn', 'course', 'lecture', 'documentary', 'science'],
    Entertainment: ['podcast', 'interview', 'comedy', 'funny', 'reaction', 'vlog', 'review'],
    'News/Commentary': ['news', 'politics', 'analysis', 'debate', 'opinion', 'breaking']
  };
  const categories = {};
  const allTexts = [
    ...(ytHistory?.items || []).map(v => ((v.title || '') + ' ' + (v.channel || '')).toLowerCase()),
    ...(ttHistory?.items || []).map(v => ((v.title || '') + ' ' + (v.author || '')).toLowerCase())
  ];
  for (const text of allTexts) {
    let matched = false;
    for (const [cat, kws] of Object.entries(CATS)) {
      if (kws.some(kw => text.includes(kw))) { categories[cat] = (categories[cat] || 0) + 1; matched = true; break; }
    }
    if (!matched) categories['Other'] = (categories['Other'] || 0) + 1;
  }

  const res = await fetch(`${DSTACK_URL}/feedling/activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ shortsCount, screenTimeMinutes, categories, timestamp: Date.now() })
  });
  if (!res.ok) {
    const errText = await res.text();
    await chrome.storage.local.set({ feedlingLastError: `${res.status}: ${errText}` });
    throw new Error(`Feedling POST ${res.status}: ${errText}`);
  }
  await chrome.storage.local.set({ feedlingLastSync: Date.now(), feedlingLastError: null });
}

function scheduleWeeklyDigest() {
  const now = new Date();
  const daysUntilSun = (7 - now.getDay()) % 7 || 7;
  const nextSunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilSun, 9, 0, 0);
  chrome.alarms.create('weekly-digest', { when: nextSunday.getTime(), periodInMinutes: 7 * 24 * 60 });
}

async function weeklyDigest() {
  const settings = await getDietSettings();
  if (!settings.enabled || !settings.notificationsEnabled) return;

  const { dietTimeLog = {}, dietShortsLog = {}, weeklyWrapped, ytHistory, ttHistory } = await chrome.storage.local.get(['dietTimeLog', 'dietShortsLog', 'weeklyWrapped', 'ytHistory', 'ttHistory']);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  let totalSecs = 0, totalShorts = 0;
  const domainTotals = {};
  const shortsByPlatform = { youtube: 0, tiktok: 0, instagram: 0 };
  for (const [date, domains] of Object.entries(dietTimeLog)) {
    if (date >= cutoffStr) {
      for (const [d, secs] of Object.entries(domains)) {
        totalSecs += secs;
        domainTotals[d] = (domainTotals[d] || 0) + secs;
      }
    }
  }
  for (const [date, platforms] of Object.entries(dietShortsLog)) {
    if (date >= cutoffStr) {
      for (const [p, count] of Object.entries(platforms)) {
        totalShorts += count;
        shortsByPlatform[p] = (shortsByPlatform[p] || 0) + count;
      }
    }
  }

  const h = Math.floor(totalSecs / 3600), m = Math.round((totalSecs % 3600) / 60);
  chrome.notifications.create('weekly-digest', { type: 'basic', iconUrl: 'icon128.png', title: 'Weekly Screen Time', message: `${h}h ${m}m total screen time. ${totalShorts} shorts watched.` });

  if (!weeklyWrapped?.enabled) return;

  const topDomains = Object.entries(domainTotals).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([domain, secs]) => ({ domain, minutes: Math.round(secs / 60) }));

  const cutoffMs = cutoff.getTime();
  let ytStats = null;
  if (ytHistory?.items?.length) {
    const weekItems = ytHistory.items.filter(v => (typeof v.date === 'number' ? v.date : 0) >= cutoffMs);
    const shorts = weekItems.filter(v => v.isShort);
    const channels = {};
    for (const v of weekItems) if (v.channel) channels[v.channel] = (channels[v.channel] || 0) + 1;
    const topChannels = Object.entries(channels).sort((a, b) => b[1] - a[1]).slice(0, 5);
    ytStats = { total: weekItems.length, shorts: shorts.length, topChannels };
  }

  let ttStats = null;
  if (ttHistory?.items?.length) {
    const weekItems = ttHistory.items.filter(v => (typeof v.watchedAt === 'number' ? v.watchedAt : 0) >= cutoffMs);
    const creators = {};
    for (const v of weekItems) if (v.authorId) creators[v.authorId] = (creators[v.authorId] || 0) + 1;
    const topCreators = Object.entries(creators).sort((a, b) => b[1] - a[1]).slice(0, 5);
    ttStats = { total: weekItems.length, topCreators };
  }

  const ownerToken = await ensureOwnerToken();
  const res = await fetch(`${DSTACK_URL}/weekly-wrapped`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({
      week: cutoffStr,
      screenTime: { totalMinutes: Math.round(totalSecs / 60), topDomains },
      shorts: shortsByPlatform,
      youtube: ytStats,
      tiktok: ttStats
    })
  });
  if (!res.ok) throw new Error(`Weekly wrapped POST failed: ${res.status}`);
}
