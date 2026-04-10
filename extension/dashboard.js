// Dashboard for Login with Everything — captures gallery only.
// Lives as an external script because MV3's default CSP blocks inline <script>.

const $ = (id) => document.getElementById(id)

let modalIdx = -1
let cachedHistory = []

function timeAgo(ts) {
  if (!ts) return ''
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime()
  const sec = Math.floor((Date.now() - t) / 1000)
  if (sec < 60) return 'just now'
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

function deriveBridgeUrl(forumUrl, teeUrl) {
  if (teeUrl) return teeUrl.replace(/\/$/, '')
  if (!forumUrl) return null
  try {
    new URL(forumUrl)
    return forumUrl.replace('-3003.', '-3000.').replace(':3003', ':3000').replace(/\/$/, '')
  } catch { return null }
}

let bridgeUrl = null

async function init() {
  const { settings = {} } = await chrome.storage.local.get('settings')
  const forumUrl = settings.forumUrl
  bridgeUrl = deriveBridgeUrl(forumUrl, settings.teeUrl)
  $('openForumBtn').disabled = !forumUrl
  $('openForumBtn').onclick = () => forumUrl && chrome.tabs.create({ url: forumUrl })
}

async function renderCaptures() {
  const { loginHistory = [] } = await chrome.storage.local.get('loginHistory')
  cachedHistory = loginHistory
  const grid = $('grid')
  const empty = $('empty')
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
    const status = c.status || (c.method === 'tee' ? 'tee' : 'github')
    const isPending = status === 'pending' || status === 'running'
    const thumb = c.screenshot
      ? `<img class="thumb" src="${c.screenshot}" alt="">`
      : `<div class="thumb-placeholder">${isPending ? 'capturing…' : (status === 'failed' ? 'failed' : 'no screenshot')}</div>`
    let badge = ''
    if (isPending) badge = `<span class="badge ${status}">${status}</span>`
    else if (status === 'failed') badge = '<span class="badge failed">failed</span>'
    else if (c.method === 'tee') badge = '<span class="badge tee">TEE</span>'
    else if (c.method === 'github') badge = '<span class="badge github">GitHub</span>'
    return `
      <div class="card ${status}" data-idx="${idx}">
        ${badge}
        ${thumb}
        <div class="info">
          <div class="domain">${c.domain || '?'}</div>
          <div class="meta">${c.identity || c.method || ''} · ${timeAgo(c.timestamp || c.startTime)}</div>
          ${c.error ? `<div class="err">${c.error}</div>` : ''}
        </div>
      </div>
    `
  }).join('')
  grid.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', () => {
      const i = parseInt(card.dataset.idx)
      const c = loginHistory[i]
      if (c.status === 'pending' || c.status === 'running') {
        // Re-open the live status tab
        const url = chrome.runtime.getURL('status.html') +
          `?run=${c.runId}&repo=${encodeURIComponent(c.repo)}&url=${encodeURIComponent(c.url || '')}`
        chrome.tabs.create({ url })
      } else {
        openModal(i)
      }
    })
  })
}

function openModal(i) {
  modalIdx = i
  const c = cachedHistory[i]
  $('modalImg').src = c.screenshot || ''
  $('modalImg').style.display = c.screenshot ? 'block' : 'none'
  $('modalDomain').textContent = c.domain || '?'
  $('modalUrl').textContent = c.url ? `URL: ${c.url}` : ''
  $('modalTime').textContent = `Captured: ${new Date(c.timestamp || c.startTime || Date.now()).toLocaleString()}`
  $('modalRunUrl').innerHTML = c.runUrl ? `Run: <a href="${c.runUrl}" target="_blank">${c.runUrl}</a>` : ''
  $('modalIdentity').textContent = c.identity ? `Identity: ${c.identity}` : ''
  $('modalRun').href = c.runUrl || '#'
  $('modalRun').style.display = c.runUrl ? 'inline-block' : 'none'
  $('modalCert').style.display = c.certificate ? 'inline-block' : 'none'
  // Show "View status page" if we have a runId (can re-open the step view)
  const statusBtn = document.getElementById('modalStatus')
  if (statusBtn) {
    if (c.runId && c.repo) {
      statusBtn.style.display = 'inline-block'
      statusBtn.onclick = () => {
        const url = chrome.runtime.getURL('status.html') +
          `?run=${c.runId}&repo=${encodeURIComponent(c.repo)}&url=${encodeURIComponent(c.url || '')}`
        chrome.tabs.create({ url })
      }
    } else {
      statusBtn.style.display = 'none'
    }
  }
  $('modal').classList.add('open')
}

$('modalClose').addEventListener('click', () => $('modal').classList.remove('open'))
$('modal').addEventListener('click', e => { if (e.target === $('modal')) $('modal').classList.remove('open') })
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('modal').classList.remove('open') })

$('modalCert').addEventListener('click', () => {
  const c = cachedHistory[modalIdx]
  if (!c?.certificate) return
  const blob = new Blob([JSON.stringify(c.certificate, null, 2)], { type: 'application/json' })
  window.open(URL.createObjectURL(blob), '_blank')
})

$('modalDelete').addEventListener('click', async () => {
  const { loginHistory = [] } = await chrome.storage.local.get('loginHistory')
  loginHistory.splice(modalIdx, 1)
  await chrome.storage.local.set({ loginHistory })
  $('modal').classList.remove('open')
})

// Clear broken: drop github captures that are stuck pending/running/failed,
// or that completed without a screenshot. TEE captures are kept untouched.
$('clearBrokenBtn').addEventListener('click', async () => {
  const { loginHistory = [] } = await chrome.storage.local.get('loginHistory')
  const before = loginHistory.length
  const kept = loginHistory.filter(c => {
    if (c.method === 'tee') return true
    if (c.method === 'github') {
      if (c.status === 'pending' || c.status === 'running' || c.status === 'failed') return false
      if (!c.screenshot) return false
      return true
    }
    return true
  })
  const removed = before - kept.length
  if (removed === 0) {
    alert('No broken captures to clear.')
    return
  }
  if (!confirm(`Remove ${removed} broken capture${removed === 1 ? '' : 's'}?`)) return
  await chrome.storage.local.set({ loginHistory: kept })
})

// Live updates: re-render whenever loginHistory changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.loginHistory) renderCaptures()
})

// ---- Tabs ----

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name))
  $('section-captures').style.display = name === 'captures' ? '' : 'none'
  $('section-viewer').style.display = name === 'viewer' ? '' : 'none'
  if (name === 'viewer') startViewer()
  else stopViewer()
}

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => showTab(t.dataset.tab))
})

// ---- Live TEE browser viewer ----
// Polls bridge /screenshot at a configurable interval and swaps the <img>.
// Way simpler than getting Neko WebRTC working through the dstack gateway.

let viewerTimer = null
let viewerPaused = false
let lastObjectUrl = null

function setViewerStatus(text, kind) {
  const el = $('viewerStatus')
  el.textContent = text
  el.className = 'status' + (kind ? ' ' + kind : '')
}

async function fetchOneFrame() {
  if (!bridgeUrl) {
    $('viewerFrame').style.display = 'none'
    $('viewerEmpty').style.display = 'block'
    setViewerStatus('Bridge URL not set', 'err')
    return
  }
  try {
    const res = await fetch(`${bridgeUrl}/screenshot?_=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) {
      // 500 "No screenshot" happens when the browser has no active page.
      // Show a friendly message instead of a scary error.
      $('viewerFrame').style.display = 'none'
      $('viewerEmpty').style.display = 'block'
      $('viewerEmpty').innerHTML = '<h2>Browser idle</h2><p>The TEE browser has no page loaded. Run a verification to see it in action.</p>'
      setViewerStatus('Waiting for activity...', 'paused')
      return
    }
    const blob = await res.blob()
    if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl)
    lastObjectUrl = URL.createObjectURL(blob)
    $('viewerImg').src = lastObjectUrl
    $('viewerFrame').style.display = 'block'
    $('viewerEmpty').style.display = 'none'
    setViewerStatus(`Last frame: ${new Date().toLocaleTimeString()}`, 'ok')
  } catch (e) {
    setViewerStatus(`Bridge error: ${e.message}`, 'err')
  }
}

function startViewer() {
  if (viewerTimer || viewerPaused) {
    if (viewerPaused) setViewerStatus('Paused', 'paused')
    return
  }
  // Pull a frame immediately, then on interval
  fetchOneFrame()
  const interval = parseInt($('viewerInterval').value || '1500')
  viewerTimer = setInterval(fetchOneFrame, interval)
}

function stopViewer() {
  if (viewerTimer) {
    clearInterval(viewerTimer)
    viewerTimer = null
  }
}

$('viewerPauseBtn').addEventListener('click', () => {
  viewerPaused = !viewerPaused
  if (viewerPaused) {
    stopViewer()
    setViewerStatus('Paused', 'paused')
    $('viewerPauseBtn').textContent = 'Resume'
  } else {
    $('viewerPauseBtn').textContent = 'Pause'
    startViewer()
  }
})

$('viewerRefreshBtn').addEventListener('click', fetchOneFrame)

$('viewerInterval').addEventListener('change', () => {
  if (viewerTimer && !viewerPaused) {
    stopViewer()
    startViewer()
  }
})

init()
renderCaptures()
showTab('captures')
