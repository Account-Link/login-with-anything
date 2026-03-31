// Login with Everything — background service worker

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getCookies') {
    getCookiesForDomain(msg.domain).then(sendResponse).catch(e => sendResponse({ error: e.message }))
    return true
  }
  if (msg.type === 'verifyViaTEE') {
    verifyViaTEE(msg).then(sendResponse).catch(e => sendResponse({ error: e.message }))
    return true
  }
  if (msg.type === 'verifyViaGitHub') {
    verifyViaGitHub(msg).then(sendResponse).catch(e => sendResponse({ error: e.message }))
    return true
  }
})

async function getCookiesForDomain(domain) {
  const cookies = await chrome.cookies.getAll({ domain })
  if (domain.includes('youtube.com') || domain.includes('google.com')) {
    const gCookies = await chrome.cookies.getAll({ domain: '.google.com' })
    return [...cookies, ...gCookies]
  }
  return cookies
}

function formatCookies(cookies) {
  return cookies.map(c => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
    expirationDate: c.expirationDate
  }))
}

async function verifyViaTEE({ domain, forumUrl, boardId }) {
  const { settings } = await chrome.storage.local.get('settings')
  const bridgeUrl = settings?.teeUrl
  if (!bridgeUrl) throw new Error('TEE bridge URL not configured. Open extension settings.')

  const cookies = await getCookiesForDomain(domain)
  if (!cookies.length) throw new Error(`No cookies for ${domain}`)

  const res = await fetch(`${forumUrl}/api/verify-cookie`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      boardId,
      cookieName: '_all',
      cookieValue: '_all',
      cookies: formatCookies(cookies),
      site: domain
    })
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)

  // Save to login history
  await saveLogin({ domain, method: 'tee', ...data })
  return data
}

async function verifyViaGitHub({ domain, forumUrl, boardId }) {
  const { settings } = await chrome.storage.local.get('settings')
  const ghToken = settings?.ghToken
  const repo = settings?.ghRepo
  if (!ghToken || !repo) throw new Error('GitHub PAT and repo not configured. Open extension settings.')

  const cookies = await getCookiesForDomain(domain)
  if (!cookies.length) throw new Error(`No cookies for ${domain}`)

  const headers = { Authorization: `Bearer ${ghToken}`, 'Content-Type': 'application/json' }

  // Create private gist with cookies
  const gistRes = await fetch('https://api.github.com/gists', {
    method: 'POST', headers,
    body: JSON.stringify({
      description: `lwa-${domain}-${Date.now()}`,
      public: false,
      files: { 'session.json': { content: JSON.stringify(formatCookies(cookies)) } }
    })
  })
  if (!gistRes.ok) throw new Error('Failed to create gist')
  const gist = await gistRes.json()

  // Dispatch workflow
  const dispatchRes = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/verify.yml/dispatches`, {
    method: 'POST', headers,
    body: JSON.stringify({ ref: 'main', inputs: { domain, gist_id: gist.id } })
  })
  if (!dispatchRes.ok) throw new Error(`Workflow dispatch failed: ${dispatchRes.status}`)

  // Poll for completion
  await new Promise(r => setTimeout(r, 5000))
  for (let i = 0; i < 30; i++) {
    const runsRes = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=1`, { headers })
    const runs = await runsRes.json()
    const run = runs.workflow_runs?.[0]
    if (run?.conclusion === 'success') {
      await saveLogin({ domain, method: 'github', runUrl: run.html_url })
      return { dispatched: true, runUrl: run.html_url, domain }
    }
    if (run?.conclusion === 'failure') throw new Error('Workflow failed')
    await new Promise(r => setTimeout(r, 10000))
  }
  throw new Error('Workflow timed out')
}

async function saveLogin(entry) {
  const { loginHistory = [] } = await chrome.storage.local.get('loginHistory')
  loginHistory.unshift({ ...entry, timestamp: Date.now() })
  if (loginHistory.length > 50) loginHistory.length = 50
  await chrome.storage.local.set({ loginHistory })
}
