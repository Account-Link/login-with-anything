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

function deriveNekoUrl(forumUrl) {
  if (!forumUrl) return null
  try {
    const u = new URL(forumUrl)
    if (u.hostname === 'localhost') return `${u.protocol}//${u.hostname}:8082`
    return forumUrl.replace('-3003.', '-8080.').replace(':3003', ':8080')
  } catch { return null }
}

async function init() {
  const { settings = {} } = await chrome.storage.local.get('settings')
  const forumUrl = settings.forumUrl
  const nekoUrl = deriveNekoUrl(forumUrl)
  $('openForumBtn').disabled = !forumUrl
  $('openNekoBtn').disabled = !nekoUrl
  $('openForumBtn').onclick = () => forumUrl && chrome.tabs.create({ url: forumUrl })
  $('openNekoBtn').onclick = () => nekoUrl && chrome.tabs.create({ url: nekoUrl })
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

init()
renderCaptures()
