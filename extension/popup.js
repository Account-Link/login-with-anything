const $ = id => document.getElementById(id)
let currentDomain = null

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.url) {
    try { currentDomain = new URL(tab.url).hostname.replace(/^www\./, '') } catch {}
  }

  const el = $('current')
  if (currentDomain && !currentDomain.startsWith('chrome')) {
    // Check if we already have permission
    const origins = [`https://${currentDomain}/*`, `https://*.${currentDomain}/*`]
    const hasPermission = await chrome.permissions.contains({ origins })

    if (hasPermission) {
      const res = await chrome.runtime.sendMessage({ type: 'getCookies', domain: currentDomain })
      const count = Array.isArray(res) ? res.length : 0
      el.innerHTML = `<div class="domain">${currentDomain}</div><div class="count">${count} cookies available</div>`
    } else {
      el.innerHTML = `<div class="domain">${currentDomain}</div><div class="count">Click a button below to grant access</div>`
    }
    $('btnTee').disabled = false
    $('btnGh').disabled = false
  } else {
    el.innerHTML = '<div class="domain" style="color:#999">Navigate to a site first</div>'
    $('btnTee').disabled = true
    $('btnGh').disabled = true
  }

  loadSettings()
  loadHistory()
}

function setStatus(type, msg) {
  const el = $('status')
  el.className = type
  el.textContent = msg
}

async function ensurePermission(domain) {
  const origins = [
    `https://${domain}/*`, `http://${domain}/*`,
    `https://*.${domain}/*`, `http://*.${domain}/*`
  ]
  const has = await chrome.permissions.contains({ origins })
  if (has) return true
  return chrome.permissions.request({ origins })
}

$('btnTee').addEventListener('click', async () => {
  if (!currentDomain) return
  $('btnTee').disabled = true

  const granted = await ensurePermission(currentDomain)
  if (!granted) { setStatus('err', 'Permission denied'); $('btnTee').disabled = false; return }

  setStatus('wait', 'Grabbing cookies and sending to TEE...')

  const { settings } = await chrome.storage.local.get('settings')
  const forumUrl = settings?.forumUrl
  if (!forumUrl) { setStatus('err', 'Set forum URL in settings first'); $('btnTee').disabled = false; return }

  const res = await chrome.runtime.sendMessage({
    type: 'verifyViaTEE', domain: currentDomain, forumUrl
  })

  if (res?.error) {
    setStatus('err', res.error)
  } else {
    setStatus('ok', `Verified: ${res.identity || 'success'}`)
  }
  $('btnTee').disabled = false
  loadHistory()
})

$('btnGh').addEventListener('click', async () => {
  if (!currentDomain) return
  $('btnGh').disabled = true

  const granted = await ensurePermission(currentDomain)
  if (!granted) { setStatus('err', 'Permission denied'); $('btnGh').disabled = false; return }

  setStatus('wait', 'Dispatching GitHub Actions workflow...')

  const { settings } = await chrome.storage.local.get('settings')
  const forumUrl = settings?.forumUrl
  if (!forumUrl) { setStatus('err', 'Set forum URL in settings first'); $('btnGh').disabled = false; return }

  const res = await chrome.runtime.sendMessage({
    type: 'verifyViaGitHub', domain: currentDomain, forumUrl
  })

  if (res?.error) {
    setStatus('err', res.error)
  } else {
    setStatus('ok', `Dispatched! Run: ${res.runUrl || 'pending'}`)
  }
  $('btnGh').disabled = false
  loadHistory()
})

async function loadHistory() {
  const { loginHistory = [] } = await chrome.storage.local.get('loginHistory')
  const el = $('history')
  if (!loginHistory.length) { el.innerHTML = '<div style="color:#ccc; font-size:11px;">No logins yet</div>'; return }
  el.innerHTML = loginHistory.slice(0, 10).map((h, i) => `
    <div class="login-entry">
      <span class="domain">${h.domain || '?'}</span>
      <span class="meta">${h.identity || h.method || ''} · ${timeAgo(h.timestamp)}</span>
      <span class="clear" data-idx="${i}">&times;</span>
    </div>
  `).join('')
  el.querySelectorAll('.clear').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { loginHistory = [] } = await chrome.storage.local.get('loginHistory')
      loginHistory.splice(parseInt(btn.dataset.idx), 1)
      await chrome.storage.local.set({ loginHistory })
      loadHistory()
    })
  })
}

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 60) return 'just now'
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings')
  $('forumUrl').value = settings.forumUrl || ''
  $('teeUrl').value = settings.teeUrl || ''
  $('ghToken').value = settings.ghToken || ''
  $('ghRepo').value = settings.ghRepo || ''
}

$('saveSettings').addEventListener('click', async () => {
  await chrome.storage.local.set({
    settings: {
      forumUrl: $('forumUrl').value.replace(/\/$/, ''),
      teeUrl: $('teeUrl').value.replace(/\/$/, ''),
      ghToken: $('ghToken').value,
      ghRepo: $('ghRepo').value
    }
  })
  $('saveSettings').textContent = 'Saved!'
  setTimeout(() => $('saveSettings').textContent = 'Save', 1500)
})

$('dash').addEventListener('click', (e) => {
  e.preventDefault()
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })
})

init()
