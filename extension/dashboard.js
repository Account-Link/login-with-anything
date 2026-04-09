// Dashboard for Login with Everything.
// Lives as an external script because MV3's default CSP blocks inline <script>
// on extension pages — until this file existed, the dashboard's inline script
// silently never ran, so the forum URL didn't load and the captures grid
// couldn't render.

const $ = (id) => document.getElementById(id)

async function init() {
  const { settings = {} } = await chrome.storage.local.get('settings')
  $('forumUrl').value = settings.forumUrl || ''
  if (settings.forumUrl) {
    $('forumFrame').src = settings.forumUrl
    $('connStatus').textContent = 'Connected'
    $('connStatus').style.color = '#22c55e'
  }
  // Neko is on port 8080 of the same host, or 8082 locally
  if (settings.forumUrl) {
    try {
      const u = new URL(settings.forumUrl)
      const nekoPort = u.hostname === 'localhost' ? '8082' : '8080'
      const nekoUrl = u.port === '3003'
        ? settings.forumUrl.replace('-3003.', '-8080.').replace(':3003', `:${nekoPort}`)
        : `${u.protocol}//${u.hostname}:${nekoPort}`
      $('nekoFrame').src = nekoUrl
    } catch {}
  }
  // Default inject domain from current tab
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.url) {
    try {
      const domain = new URL(tab.url).hostname.replace(/^www\./, '')
      if (!domain.startsWith('chrome')) $('injectDomain').value = domain
    } catch {}
  }
}

$('saveUrl').addEventListener('click', async () => {
  const forumUrl = $('forumUrl').value.replace(/\/$/, '')
  const { settings = {} } = await chrome.storage.local.get('settings')
  settings.forumUrl = forumUrl
  await chrome.storage.local.set({ settings })
  $('forumFrame').src = forumUrl
  $('connStatus').textContent = 'Saved'
  $('connStatus').style.color = '#22c55e'
})

$('openForum').addEventListener('click', () => {
  const url = $('forumUrl').value
  if (url) chrome.tabs.create({ url })
})

$('btnInject').addEventListener('click', async () => {
  const domain = $('injectDomain').value.trim()
  if (!domain) return
  $('injectStatus').textContent = 'Injecting...'
  const { settings = {} } = await chrome.storage.local.get('settings')
  const bridgeUrl = settings.teeUrl || settings.forumUrl?.replace(':3003', ':3002')?.replace('-3003.', '-3000.')
  if (!bridgeUrl) { $('injectStatus').textContent = 'No bridge URL'; return }

  const res = await chrome.runtime.sendMessage({ type: 'injectCookies', domain, bridgeUrl })
  if (res?.error) {
    $('injectStatus').textContent = res.error
    $('injectStatus').style.color = '#ef4444'
  } else {
    $('injectStatus').textContent = `Injected ${res?.set || '?'} cookies`
    $('injectStatus').style.color = '#22c55e'
  }
})

$('btnNav').addEventListener('click', () => {
  const domain = $('injectDomain').value.trim()
  if (domain) $('navUrl').value = `https://${domain}`
})

$('btnNavGo').addEventListener('click', async () => {
  const url = $('navUrl').value.trim()
  if (!url) return
  const { settings = {} } = await chrome.storage.local.get('settings')
  const bridgeUrl = settings.teeUrl || settings.forumUrl?.replace(':3003', ':3002')?.replace('-3003.', '-3000.')
  if (!bridgeUrl) return
  await fetch(bridgeUrl + '/navigate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  })
})

$('toggleNeko').addEventListener('click', () => {
  const panel = $('nekoPanel')
  const btn = $('toggleNeko')
  if (panel.style.display === 'none') {
    panel.style.display = 'flex'
    btn.textContent = 'Hide'
  } else {
    panel.style.display = 'none'
    btn.textContent = 'Show Browser'
  }
})

// ---- Captures strip ----

function timeAgo(ts) {
  if (!ts) return ''
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime()
  const sec = Math.floor((Date.now() - t) / 1000)
  if (sec < 60) return 'just now'
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

let modalIdx = -1
let cachedHistory = []

async function renderCaptures() {
  const { loginHistory = [] } = await chrome.storage.local.get('loginHistory')
  cachedHistory = loginHistory
  const grid = $('capturesGrid')
  const empty = $('capturesEmpty')
  if (!loginHistory.length) {
    grid.innerHTML = ''
    empty.style.display = 'block'
    return
  }
  empty.style.display = 'none'
  // Sort: pending/running first, then by timestamp desc
  const sorted = [...loginHistory].sort((a, b) => {
    const order = s => (s === 'pending' || s === 'running') ? 0 : (s === 'failed' ? 1 : 2)
    const oa = order(a.status), ob = order(b.status)
    if (oa !== ob) return oa - ob
    return (b.timestamp || 0) - (a.timestamp || 0)
  })
  grid.innerHTML = sorted.map(c => {
    const idx = loginHistory.indexOf(c)
    const status = c.status || (c.method === 'tee' ? 'tee' : 'completed')
    const isPending = status === 'pending' || status === 'running'
    const thumb = c.screenshot
      ? `<img class="cap-thumb" src="${c.screenshot}" alt="">`
      : `<div class="cap-thumb-placeholder">${isPending ? 'capturing…' : (status === 'failed' ? 'failed' : 'no screenshot')}</div>`
    const badge = status === 'tee' ? '<span class="cap-status-badge tee">TEE</span>'
                : isPending ? `<span class="cap-status-badge ${status}">${status}</span>`
                : status === 'failed' ? '<span class="cap-status-badge failed">failed</span>'
                : ''
    return `
      <div class="cap-card ${status}" data-idx="${idx}">
        ${thumb}
        <div class="cap-info">
          <div class="cap-domain">${c.domain || '?'}${badge}</div>
          <div class="cap-meta">${c.identity || c.method || ''} · ${timeAgo(c.timestamp || c.startTime)}</div>
          ${c.error ? `<div class="cap-error">${c.error}</div>` : ''}
        </div>
      </div>
    `
  }).join('')
  grid.querySelectorAll('.cap-card').forEach(card => {
    card.addEventListener('click', () => {
      const i = parseInt(card.dataset.idx)
      const c = loginHistory[i]
      if (c.status === 'pending' || c.status === 'running') {
        const url = chrome.runtime.getURL('status.html') +
          `?run=${c.runId}&repo=${encodeURIComponent(c.repo)}&url=${encodeURIComponent(c.url || '')}`
        chrome.tabs.create({ url })
      } else {
        openCapModal(i)
      }
    })
  })
}

function openCapModal(i) {
  modalIdx = i
  const c = cachedHistory[i]
  $('capModalImg').src = c.screenshot || ''
  $('capModalImg').style.display = c.screenshot ? 'block' : 'none'
  $('capModalDomain').textContent = c.domain || '?'
  $('capModalUrl').textContent = c.url ? `URL: ${c.url}` : ''
  $('capModalTime').textContent = `Captured: ${new Date(c.timestamp || c.startTime || Date.now()).toLocaleString()}`
  $('capModalRunUrl').innerHTML = c.runUrl ? `Run: <a href="${c.runUrl}" target="_blank">${c.runUrl}</a>` : ''
  $('capModalIdentity').textContent = c.identity ? `Identity: ${c.identity}` : ''
  $('capModalRun').href = c.runUrl || '#'
  $('capModalRun').style.display = c.runUrl ? 'inline-block' : 'none'
  $('capModalCert').style.display = c.certificate ? 'inline-block' : 'none'
  $('capModal').classList.add('open')
}

$('capModalClose').addEventListener('click', () => $('capModal').classList.remove('open'))
$('capModal').addEventListener('click', e => { if (e.target === $('capModal')) $('capModal').classList.remove('open') })
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('capModal').classList.remove('open') })
$('capModalCert').addEventListener('click', () => {
  const c = cachedHistory[modalIdx]
  if (!c?.certificate) return
  const blob = new Blob([JSON.stringify(c.certificate, null, 2)], { type: 'application/json' })
  window.open(URL.createObjectURL(blob), '_blank')
})
$('capModalDelete').addEventListener('click', async () => {
  const { loginHistory = [] } = await chrome.storage.local.get('loginHistory')
  loginHistory.splice(modalIdx, 1)
  await chrome.storage.local.set({ loginHistory })
  $('capModal').classList.remove('open')
  renderCaptures()
})

// Live updates: re-render whenever loginHistory changes (status.js writes to it)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.loginHistory) renderCaptures()
})

init()
renderCaptures()
