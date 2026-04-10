// Live step-streaming UI for the verify.yml workflow.
// Adapted from provenance-snapshot-extension/extension/status.js with our
// settings storage shape, our verify.yml step names, and gist (not secret)
// cleanup on success.

const $ = (id) => document.getElementById(id)

const params = new URLSearchParams(window.location.search)
const runId = params.get('run')
const repo = params.get('repo')
const captureUrl = params.get('url')
const gistId = params.get('gist')

const API_BASE = 'https://api.github.com'
let pat = ''

// Map raw verify.yml step names to friendly demo-stage labels.
// Filtered: only steps in this map render in the UI.
const STEP_NAMES = {
  'Set up job': 'Provisioning GitHub runner',
  'Pull cookies from gist': 'Pulling session cookies',
  'Start OpenVPN + SOCKS5 sidecar (residential egress)': 'Connecting to Mullvad VPN',
  'Start TEE browser container': 'Booting TEE browser',
  'Determine target URL': 'Choosing target page',
  'Inject cookies, navigate, capture': 'Logging in & screenshotting',
  'Upload proof artifact': 'Uploading proof',
  'Attest screenshot': 'Signing attestation',
  'Cleanup': 'Tearing down',
  'Complete job': 'Done'
}

async function init() {
  $('captureUrl').textContent = captureUrl || 'Unknown URL'

  if (runId && repo) {
    const link = $('runlink')
    link.href = `https://github.com/${repo}/actions/runs/${runId}`
    link.textContent = `View on GitHub: ${repo} run #${runId}`
  }

  const stored = await chrome.storage.local.get(['settings'])
  pat = stored.settings?.ghToken || ''

  if (!runId || !repo || !pat) {
    showError('Missing run id, repo, or GitHub token in settings')
    return
  }
  // Insert a pending record into loginHistory so the dashboard sees it immediately
  await upsertCapture({
    runId, repo, domain: extractDomain(captureUrl), url: captureUrl,
    method: 'github', status: 'pending',
    runUrl: `https://github.com/${repo}/actions/runs/${runId}`,
    startTime: new Date().toISOString(), timestamp: Date.now()
  })
  poll()
}

function extractDomain(u) {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u }
}

async function poll() {
  try {
    const run = await fetchRun()
    updateStatus(run)
    if (run.status === 'in_progress') {
      await upsertCapture({ runId, status: 'running' })
    }
    if (run.status === 'completed') {
      if (run.conclusion === 'success') {
        await fetchAndDisplayResult()
      } else {
        await upsertCapture({ runId, status: 'failed', error: `Workflow ${run.conclusion}` })
      }
      if (gistId) await deleteGist()
    } else {
      setTimeout(poll, 1500)
    }
  } catch (err) {
    await upsertCapture({ runId, status: 'failed', error: err.message })
    showError(err.message)
  }
}

async function fetchRun() {
  const res = await fetch(`${API_BASE}/repos/${repo}/actions/runs/${runId}`, {
    headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) throw new Error(`Failed to fetch run: ${res.status}`)
  return res.json()
}

async function fetchJobs() {
  const res = await fetch(`${API_BASE}/repos/${repo}/actions/runs/${runId}/jobs`, {
    headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) return { jobs: [] }
  return res.json()
}

function updateStatus(run) {
  const icon = $('statusIcon')
  const title = $('statusTitle')
  const subtitle = $('statusSubtitle')
  icon.className = 'status-icon'

  if (run.status === 'queued') {
    icon.classList.add('pending')
    icon.textContent = '...'
    title.textContent = 'Queued'
    subtitle.textContent = 'Waiting for GitHub Actions runner...'
  } else if (run.status === 'in_progress') {
    icon.classList.add('running')
    icon.textContent = '...'
    title.textContent = 'Capturing'
    subtitle.textContent = 'Workflow in progress'
  } else if (run.status === 'completed') {
    if (run.conclusion === 'success') {
      icon.classList.add('success')
      icon.textContent = '✓'
      title.textContent = 'Verified'
      subtitle.textContent = 'Capture complete'
    } else {
      icon.classList.add('failure')
      icon.textContent = '✗'
      title.textContent = 'Failed'
      subtitle.textContent = `Conclusion: ${run.conclusion}`
    }
  }
  // Always fetch steps — not just on state transitions — so progress
  // appears gradually instead of jumping from all-pending to all-done.
  fetchJobs().then(updateSteps)
}

function updateSteps(data) {
  const job = data.jobs?.[0]
  if (!job) return
  const stepsEl = $('steps')
  stepsEl.innerHTML = job.steps
    .filter(s => STEP_NAMES[s.name])
    .map(s => {
      let iconClass = 'pending'
      let icon = '·'
      if (s.status === 'completed') {
        iconClass = s.conclusion === 'success' ? 'done' : 'failed'
        icon = s.conclusion === 'success' ? '✓' : '✗'
      } else if (s.status === 'in_progress') {
        iconClass = 'running'
        icon = '…'
      }
      return `
        <div class="step">
          <div class="step-icon ${iconClass}">${icon}</div>
          <span class="step-name ${s.status === 'queued' ? 'pending' : ''}">${STEP_NAMES[s.name]}</span>
        </div>
      `
    }).join('')
}

async function fetchAndDisplayResult() {
  $('resultLoading').textContent = 'Downloading artifact'
  $('resultLoading').style.display = 'block'

  const res = await fetch(`${API_BASE}/repos/${repo}/actions/runs/${runId}/artifacts`, {
    headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) { showError('Failed to fetch artifacts'); return }

  const data = await res.json()
  const artifact = data.artifacts?.[0]
  if (!artifact) { showError('No artifacts found'); return }

  $('resultLoading').textContent = 'Extracting files'
  const dlRes = await fetch(`${API_BASE}/repos/${repo}/actions/artifacts/${artifact.id}/zip`, {
    headers: { Authorization: `Bearer ${pat}` }
  })
  if (!dlRes.ok) { showError(`Failed to download artifact: ${dlRes.status}`); return }

  const zipBlob = await dlRes.blob()
  let files
  try {
    files = await unzipArtifact(zipBlob)
  } catch (e) {
    showError(`Failed to extract: ${e.message}`)
    return
  }

  $('resultLoading').style.display = 'none'
  $('result').style.display = 'block'

  let screenshotDataUrl = null
  if (files['screenshot.png']) {
    $('screenshot').src = URL.createObjectURL(files['screenshot.png'])
    screenshotDataUrl = await blobToDataUrl(files['screenshot.png'])
  } else {
    $('screenshot').alt = 'screenshot.png not in artifact'
  }

  let cert = null
  if (files['certificate.json']) {
    cert = JSON.parse(await files['certificate.json'].text())
    $('resultMeta').textContent = `${cert.domain} → ${cert.url}  ·  ${cert.timestamp}`
    $('viewCertificate').onclick = () => {
      const blob = new Blob([JSON.stringify(cert, null, 2)], { type: 'application/json' })
      window.open(URL.createObjectURL(blob), '_blank')
    }
    $('viewCertificate').style.display = 'inline-block'
  }

  await upsertCapture({
    runId,
    domain: cert?.domain || extractDomain(captureUrl),
    url: cert?.url || captureUrl,
    method: 'github',
    status: 'completed',
    runUrl: `https://github.com/${repo}/actions/runs/${runId}`,
    screenshot: screenshotDataUrl,
    certificate: cert,
    timestamp: Date.now(),
    completedAt: new Date().toISOString()
  })
  $('savedNotice').style.display = 'block'
}

function blobToDataUrl(blob) {
  return new Promise(resolve => {
    const r = new FileReader()
    r.onloadend = () => resolve(r.result)
    r.readAsDataURL(blob)
  })
}

async function deleteGist() {
  $('cleanupStatus').textContent = 'Removing session gist from GitHub...'
  $('cleanupStatus').style.display = 'block'
  try {
    const res = await fetch(`${API_BASE}/gists/${gistId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' }
    })
    if (res.ok || res.status === 404) {
      $('cleanupStatus').textContent = 'Session gist removed'
      $('cleanupStatus').classList.add('success')
    } else {
      $('cleanupStatus').textContent = `Failed to remove gist: ${res.status}`
      $('cleanupStatus').classList.add('error')
    }
  } catch (e) {
    $('cleanupStatus').textContent = `Cleanup error: ${e.message}`
    $('cleanupStatus').classList.add('error')
  }
}

// Idempotent: find by runId and merge, or insert at the front.
async function upsertCapture(partial) {
  const { loginHistory = [] } = await chrome.storage.local.get('loginHistory')
  const idx = loginHistory.findIndex(e => e.runId && e.runId === partial.runId)
  if (idx >= 0) {
    loginHistory[idx] = { ...loginHistory[idx], ...partial }
  } else {
    loginHistory.unshift(partial)
    if (loginHistory.length > 50) loginHistory.length = 50
  }
  await chrome.storage.local.set({ loginHistory })
}

// Minimal client-side ZIP reader (no deps). Handles store + deflate.
async function unzipArtifact(blob) {
  const files = {}
  const arrayBuffer = await blob.arrayBuffer()
  const view = new DataView(arrayBuffer)
  const bytes = new Uint8Array(arrayBuffer)

  // End of Central Directory: scan back for 0x06054b50
  let eocdPos = -1
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdPos = i; break }
  }
  if (eocdPos < 0) throw new Error('Invalid ZIP: no EOCD')

  const cdOffset = view.getUint32(eocdPos + 16, true)
  const cdEntries = view.getUint16(eocdPos + 10, true)

  let pos = cdOffset
  for (let i = 0; i < cdEntries; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break
    const method = view.getUint16(pos + 10, true)
    const compSize = view.getUint32(pos + 20, true)
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    const localHeaderOffset = view.getUint32(pos + 42, true)
    const fileName = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + nameLen))
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true)
    const dataStart = localHeaderOffset + 30 + nameLen + localExtraLen
    const compData = bytes.slice(dataStart, dataStart + compSize)

    if (compSize > 0 && !fileName.endsWith('/')) {
      if (method === 0) {
        files[fileName] = new Blob([compData])
      } else if (method === 8) {
        const ds = new DecompressionStream('deflate-raw')
        const writer = ds.writable.getWriter()
        writer.write(compData)
        writer.close()
        const decompressed = await new Response(ds.readable).arrayBuffer()
        files[fileName] = new Blob([decompressed])
      }
    }
    pos += 46 + nameLen + extraLen + commentLen
  }
  return files
}

function showError(msg) {
  $('resultLoading').style.display = 'none'
  $('error').style.display = 'block'
  $('error').textContent = msg
}

init()
