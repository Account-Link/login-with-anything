import express from 'express'
import Anthropic from '@anthropic-ai/sdk'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { PROOF_CATALOG, getRandomProofs, getTotalProofCount } from './proofs.js'
import { getWorkflowRun, getWorkflowContent, downloadArtifacts } from './github.js'

const app = express()
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})
app.use(express.json())
app.use(express.static('public'))

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null
const sessions = new Map()  // runId -> { proof, screenshot, messages: [] }
const proofCache = new Map()
const workflowCache = new Map()

// SQLite for persistent boards + posts
const DB_PATH = process.env.DB_PATH || '/data/forum.db'
try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }) } catch {}
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    predicate TEXT NOT NULL,
    method TEXT NOT NULL,
    site TEXT,
    description TEXT
  );
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id TEXT NOT NULL REFERENCES boards(id),
    identity TEXT NOT NULL,
    evidence TEXT,
    message TEXT NOT NULL,
    members_only INTEGER DEFAULT 0,
    timestamp TEXT NOT NULL
  );
`)

// --- Forum: boards and posts ---
const verifiedSessions = new Map()  // token -> { boardId, identity, evidence }

// DB helpers
const stmts = {
  getBoards: db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM posts WHERE board_id = b.id) as postCount FROM boards b`),
  getBoard: db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM posts WHERE board_id = b.id) as postCount FROM boards b WHERE b.id = ?`),
  insertBoard: db.prepare(`INSERT INTO boards (id, name, predicate, method, site, description) VALUES (?, ?, ?, ?, ?, ?)`),
  getPosts: db.prepare(`SELECT * FROM posts WHERE board_id = ? ORDER BY id DESC`),
  insertPost: db.prepare(`INSERT INTO posts (board_id, identity, evidence, message, members_only, timestamp) VALUES (?, ?, ?, ?, ?, ?)`),
}

// Seed default boards if empty
if (stmts.getBoards.all().length === 0) {
  for (const b of [
    { name: 'Anthropic Customers', predicate: 'Valid Anthropic API key', method: 'api_key', site: 'api.anthropic.com', description: 'Paste an Anthropic API key to prove you are a customer.' },
    { name: 'GitHub Developers', predicate: 'Valid GitHub PAT', method: 'api_key', site: 'api.github.com', description: 'Paste a GitHub personal access token.' },
    { name: 'High Karma Redditors', predicate: 'Reddit karma > 1000', method: 'browser', site: 'reddit.com', description: 'Paste your reddit_session cookie. Verified via TEE browser.' },
    { name: "Today's Wordle", predicate: 'Solved today\'s Wordle', method: 'browser', site: 'nytimes.com', description: 'Paste your NYT-S cookie. Verified via TEE browser.' },
  ]) {
    const id = `board-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    stmts.insertBoard.run(id, b.name, b.predicate, b.method, b.site, b.description)
  }
}

// Board CRUD
app.get('/api/boards', (req, res) => {
  res.json({ boards: stmts.getBoards.all() })
})

app.post('/api/boards', (req, res) => {
  const { name, predicate, method, site, description } = req.body
  if (!name || !predicate) return res.status(400).json({ error: 'name and predicate required' })
  const id = `board-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  stmts.insertBoard.run(id, name, predicate, method || 'api_key', site || '', description || '')
  res.json(stmts.getBoard.get(id))
})

app.get('/api/boards/:id', (req, res) => {
  const board = stmts.getBoard.get(req.params.id)
  if (!board) return res.status(404).json({ error: 'Board not found' })
  res.json(board)
})

// Verify predicate (API key method)
app.post('/api/verify', async (req, res) => {
  const { boardId, apiKey } = req.body
  const board = stmts.getBoard.get(boardId)
  if (!board) return res.status(404).json({ error: 'Board not found' })

  try {
    let identity = null

    if (board.site === 'api.anthropic.com' || board.site.includes('anthropic')) {
      const r = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      })
      if (!r.ok) return res.json({ error: 'Invalid Anthropic API key' })
      identity = `anthropic-customer-${apiKey.slice(-6)}`
    } else if (board.site === 'api.github.com' || board.site.includes('github')) {
      const r = await fetch('https://api.github.com/user', {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'User-Agent': 'login-with-anything' }
      })
      if (!r.ok) return res.json({ error: 'Invalid GitHub token' })
      const user = await r.json()
      identity = user.login
    } else if (board.site.includes('openai')) {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      })
      if (!r.ok) return res.json({ error: 'Invalid OpenAI API key' })
      identity = `openai-customer-${apiKey.slice(-6)}`
    } else {
      return res.json({ error: `Unknown API verification for ${board.site}` })
    }

    const token = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    verifiedSessions.set(token, { boardId, identity, evidence: null, verifiedAt: new Date() })
    res.json({ sessionToken: token, identity, evidence: null })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Wordle share block verification
app.post('/api/verify-wordle', (req, res) => {
  const { boardId, shareText } = req.body
  const board = stmts.getBoard.get(boardId)
  if (!board) return res.status(404).json({ error: 'Board not found' })

  const lines = shareText.trim().split('\n').map(l => l.trim()).filter(Boolean)
  // First line: "Wordle 1,386 4/6" or "Wordle 1,386 X/6"
  const header = lines[0]
  const headerMatch = header.match(/Wordle\s+([\d,]+)\s+([X\d])\/6/)
  if (!headerMatch) return res.json({ error: 'Invalid Wordle share format. Paste the full share block including "Wordle #,### N/6"' })

  const puzzleNum = parseInt(headerMatch[1].replace(/,/g, ''))
  const score = headerMatch[2]

  // Validate grid lines (remaining lines should be rows of 5 emoji squares)
  const squares = ['⬛', '⬜', '🟨', '🟩']
  const gridLines = lines.slice(1).filter(l => [...l].some(c => squares.includes(c)))

  if (gridLines.length === 0) return res.json({ error: 'No valid grid rows found' })
  if (score !== 'X' && gridLines.length !== parseInt(score)) {
    return res.json({ error: `Score says ${score}/6 but found ${gridLines.length} rows` })
  }

  // If solved, last row should be all green
  if (score !== 'X') {
    const lastRow = gridLines[gridLines.length - 1]
    const greenCount = [...lastRow].filter(c => c === '🟩').length
    if (greenCount !== 5) return res.json({ error: 'Last row should be all 🟩 for a solved puzzle' })
  }

  const identity = `wordle-${puzzleNum}-${score}`
  const evidence = `Puzzle #${puzzleNum}, solved in ${score}/6, ${gridLines.length} guesses`

  const token = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  verifiedSessions.set(token, { boardId, identity, verifiedAt: new Date() })
  res.json({ sessionToken: token, identity, evidence })
})

// Browser queue — one verification at a time
const browserQueue = []
let browserBusy = false

function enqueueBrowserWork(fn) {
  return new Promise((resolve, reject) => {
    browserQueue.push(async () => {
      try { resolve(await fn()) } catch (e) { reject(e) }
    })
    drainQueue()
  })
}

async function drainQueue() {
  if (browserBusy || !browserQueue.length) return
  browserBusy = true
  const work = browserQueue.shift()
  try { await work() } finally {
    // Reset browser state between users
    try { await fetch(`${TEE_BROWSER}/navigate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"url":"about:blank"}' }) } catch {}
    browserBusy = false
    drainQueue()
  }
}

// Cookie-based verification via TEE browser
const findBoardBySite = db.prepare(`SELECT * FROM boards WHERE site LIKE ? LIMIT 1`)

app.post('/api/verify-cookie', async (req, res) => {
  const { boardId, cookieName, cookieValue, cookies: rawCookies, username, site } = req.body
  let board = boardId ? stmts.getBoard.get(boardId) : null
  if (!board && site) {
    const domainKey = site.replace(/^www\./, '').split('/')[0]
    board = findBoardBySite.get(`%${domainKey}%`)
  }
  if (!board) return res.status(404).json({ error: 'Board not found' })

  const domain = site.replace(/^www\./, '')
  // Accept full cookie array from extension, or single cookie from paste UI
  const cookies = rawCookies?.length ? rawCookies : [{
    name: cookieName, value: cookieValue,
    domain: `.${domain}`, path: '/', secure: true, httpOnly: true
  }]

  // Pick the right verification URL based on site
  let verifyUrl, extractIdentity
  if (site.includes('reddit')) {
    verifyUrl = 'https://www.reddit.com/api/me.json'
    extractIdentity = (json, pageText) => {
      const d = json?.data
      if (!d?.name) return null
      return { identity: d.name, evidence: `${d.total_karma} karma, account since ${new Date(d.created_utc * 1000).getFullYear()}` }
    }
  } else if (site.includes('nytimes')) {
    // Navigate to NYT's wordle state JSON endpoint instead of the splash page.
    // The bridge's evalScript will JSON.parse the body and we get authoritative
    // stats with the user's session cookie. Way more reliable than scraping the
    // splash page text, which only contains "Go ahead, add another day to your
    // N day streak" — never the post-solve "Great job on today" we used to look for.
    verifyUrl = 'https://www.nytimes.com/svc/games/state/wordleV2/latests'
    extractIdentity = (json) => {
      if (!json?.user_id) return null
      const stats = json?.player?.stats?.wordle?.calculatedStats || {}
      const total = json?.player?.stats?.wordle?.totalStats || {}
      if (!stats.hasPlayed) {
        throw new Error('This NYT account has never played Wordle.')
      }
      // NYT puzzle dates roll over at midnight ET, not UTC.
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      if (stats.lastCompletedPrintDate !== today) {
        throw new Error(`Last solved Wordle on ${stats.lastCompletedPrintDate}, but today (${today}) hasn't been done yet. Go finish today's puzzle and try again.`)
      }
      const accountYear = (json.player?.account_creation_date || '').slice(0, 4)
      return {
        identity: `nyt-${json.user_id}`,
        evidence: `Solved Wordle ${stats.lastCompletedPrintDate}, ${stats.currentStreak}-day streak (max ${stats.maxStreak}), ${total.gamesWon}/${total.gamesPlayed} lifetime${accountYear ? `, NYT account since ${accountYear}` : ''}`
      }
    }
  } else if (site.includes('twitter') || site.includes('x.com')) {
    verifyUrl = `https://x.com/${username}`
    extractIdentity = (json, pageText) => ({ identity: username, evidence: 'Session verified' })
  } else {
    verifyUrl = `https://${domain}`
    extractIdentity = (json, pageText) => ({ identity: username, evidence: 'Session verified' })
  }

  try {
    const result = await enqueueBrowserWork(async () => {
      // Inject cookie
      await fetch(`${TEE_BROWSER}/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies })
      })

      // Navigate
      await fetch(`${TEE_BROWSER}/navigate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: verifyUrl })
      })
      await new Promise(r => setTimeout(r, 4000))

      // Get structured data via eval
      const evalRes = await fetch(`${TEE_BROWSER}/eval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: 'ignored' })
      })
      const evalData = await evalRes.json()

      // Capture page text
      const captureRes = await fetch(`${TEE_BROWSER}/capture`, { method: 'POST' })
      const capture = await captureRes.json()
      const pageText = capture.certificate?.pageInfo?.bodyText || ''
      const pageTitle = capture.certificate?.pageInfo?.title || ''

      if (pageTitle.toLowerCase().includes('log in') || pageTitle.toLowerCase().includes('sign in') || pageText.includes('Log In')) {
        throw new Error('Cookie did not authenticate. Try copying a fresh cookie from DevTools.')
      }

      let r = null
      if (evalData?.json) r = extractIdentity(evalData.json, pageText)
      if (!r) r = extractIdentity(null, pageText)
      if (!r) throw new Error('Verification failed — could not extract identity from page')
      return r
    })

    const token = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    verifiedSessions.set(token, { boardId, identity: result.identity, evidence: result.evidence, verifiedAt: new Date() })
    res.json({ sessionToken: token, identity: result.identity, evidence: result.evidence })
  } catch (e) {
    res.json({ error: e.message })
  }
})

// Board posts
app.get('/api/boards/:id/posts', (req, res) => {
  const boardPosts = stmts.getPosts.all(req.params.id)
  const token = req.query.session
  const session = token ? verifiedSessions.get(token) : null
  const isMember = session?.boardId === req.params.id

  const visible = boardPosts.map(p => {
    if (p.members_only && !isMember) {
      return { identity: p.identity, evidence: p.evidence, membersOnly: true, redacted: true, timestamp: p.timestamp }
    }
    return { identity: p.identity, evidence: p.evidence, message: p.message, membersOnly: !!p.members_only, timestamp: p.timestamp }
  })
  res.json({ posts: visible })
})

app.post('/api/boards/:id/posts', (req, res) => {
  const { sessionToken, message } = req.body
  const session = verifiedSessions.get(sessionToken)
  if (!session || session.boardId !== req.params.id) return res.status(401).json({ error: 'Not verified for this board' })
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' })

  const { membersOnly } = req.body
  const timestamp = new Date().toISOString()
  stmts.insertPost.run(req.params.id, session.identity, session.evidence || null, message.trim(), membersOnly ? 1 : 0, timestamp)
  res.json({ post: { identity: session.identity, evidence: session.evidence, message: message.trim(), membersOnly: !!membersOnly, timestamp } })
})

// Example workflows for LLM context
const EXAMPLE_WORKFLOWS = {
  'twitter-followers': `name: Twitter Follower Proof

on:
  workflow_dispatch:
    inputs:
      profile:
        description: 'Twitter/X username to prove (without @)'
        required: true

jobs:
  prove:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Start browser container
        run: |
          cd browser-container
          docker compose up -d --build
          sleep 10
          curl -f http://localhost:3002/health
      - name: Inject session and capture proof
        env:
          SESSION_JSON: \${{ secrets.TWITTER_COM_SESSION }}
        run: |
          mkdir -p proof
          echo "$SESSION_JSON" | curl -X POST http://localhost:3002/session -H "Content-Type: application/json" -d @-
          curl -X POST http://localhost:3002/navigate -H "Content-Type: application/json" -d '{"url":"https://x.com/\${{ inputs.profile }}"}'
          sleep 5
          curl http://localhost:3002/screenshot -o proof/screenshot.png
          cat > proof/certificate.json << EOF
          {
            "type": "twitter-followers",
            "profile": "\${{ inputs.profile }}",
            "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
            "github_run_id": "\${{ github.run_id }}",
            "github_run_url": "\${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}"
          }
          EOF
      - uses: actions/upload-artifact@v4
        with:
          name: twitter-proof
          path: proof/
          retention-days: 90
      - if: always()
        run: cd browser-container && docker compose down`,

  'github-contributions': `name: GitHub Contributions Proof

on:
  workflow_dispatch:
    inputs:
      username:
        description: 'GitHub username'
        required: true

jobs:
  prove:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Start browser container
        run: |
          cd browser-container
          docker compose up -d --build
          sleep 10
          curl -f http://localhost:3002/health
      - name: Inject session and capture proof
        env:
          SESSION_JSON: \${{ secrets.GITHUB_COM_SESSION }}
        run: |
          mkdir -p proof
          echo "$SESSION_JSON" | curl -X POST http://localhost:3002/session -H "Content-Type: application/json" -d @-
          curl -X POST http://localhost:3002/navigate -H "Content-Type: application/json" -d '{"url":"https://github.com/\${{ inputs.username }}"}'
          sleep 5
          curl http://localhost:3002/screenshot -o proof/screenshot.png
          cat > proof/certificate.json << EOF
          {
            "type": "github-contributions",
            "username": "\${{ inputs.username }}",
            "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
            "github_run_id": "\${{ github.run_id }}",
            "github_run_url": "\${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}"
          }
          EOF
      - uses: actions/upload-artifact@v4
        with:
          name: github-proof
          path: proof/
          retention-days: 90
      - if: always()
        run: cd browser-container && docker compose down`
}

// Canonical workflows - used to verify "bring your own repo" proofs
const CANONICAL_WORKFLOWS = new Map()

// Load canonical workflows from .github/workflows on startup
function loadCanonicalWorkflows() {
  const workflowDirs = ['../../.github/workflows', '.github/workflows']
  for (const workflowDir of workflowDirs) {
    try {
      const files = fs.readdirSync(workflowDir).filter(f => f.endsWith('.yml'))
      for (const file of files) {
        const content = fs.readFileSync(path.join(workflowDir, file), 'utf8')
        const typeMatch = content.match(/"type":\s*"([^"]+)"/)
        if (typeMatch) CANONICAL_WORKFLOWS.set(typeMatch[1], content)
      }
      if (CANONICAL_WORKFLOWS.size > 0) {
        console.log(`Loaded ${CANONICAL_WORKFLOWS.size} canonical workflows from ${workflowDir}`)
        return
      }
    } catch {}
  }
  console.log('Could not load canonical workflows (will verify via GitHub API)')
}
loadCanonicalWorkflows()

// Recursively find file in directory
function findFile(dir, filename) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(full, filename)
      if (found) return found
    } else if (entry.name === filename) return full
  }
  return null
}

// Verify a GitHub Actions proof and create session
app.post('/api/verify', async (req, res) => {
  const { runUrl } = req.body
  const match = runUrl?.match(/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/)
  if (!match) return res.status(400).json({ error: 'Invalid run URL' })

  const [, owner, repo, runId] = match
  try {
    // Fetch run metadata
    const runData = await getWorkflowRun(owner, repo, runId)
    if (runData.conclusion !== 'success') return res.status(400).json({ error: `Run not successful: ${runData.conclusion}` })

    const { head_sha, path: workflowPath } = runData
    const run = { conclusion: runData.conclusion, name: runData.name, headSha: head_sha, createdAt: runData.created_at }

    // Fetch workflow content at exact commit SHA
    let workflowContent = null, workflowVerified = false, workflowMismatch = null
    try {
      workflowContent = await getWorkflowContent(owner, repo, workflowPath, head_sha)
    } catch (e) {
      console.log('Could not fetch workflow content:', e.message)
    }

    // Download artifacts
    const tmpDir = `/tmp/proof-${runId}`
    fs.rmSync(tmpDir, { recursive: true, force: true })
    await downloadArtifacts(owner, repo, runId, tmpDir)

    // Find and parse certificate
    const certPath = findFile(tmpDir, 'certificate.json')
    if (!certPath) return res.status(400).json({ error: 'No certificate found in artifacts' })
    const cert = JSON.parse(fs.readFileSync(certPath, 'utf8'))

    // Find screenshot if available
    let screenshot = null
    const screenshotPath = findFile(tmpDir, 'screenshot.png')
    if (screenshotPath) screenshot = fs.readFileSync(screenshotPath).toString('base64')

    // Verify workflow against canonical if we have one
    const norm = normalizeCert(cert)
    if (workflowContent && CANONICAL_WORKFLOWS.has(norm.type)) {
      const canonical = CANONICAL_WORKFLOWS.get(norm.type)
      // Normalize whitespace for comparison
      const normalizeWs = s => s.replace(/\s+/g, ' ').trim()
      if (normalizeWs(workflowContent) === normalizeWs(canonical)) {
        workflowVerified = true
      } else {
        workflowMismatch = { expected: canonical.slice(0, 200), actual: workflowContent.slice(0, 200) }
      }
    }

    // Create session
    const session = {
      runId, runUrl, run, cert, screenshot, tmpDir,
      workflowContent, workflowVerified, workflowPath, headSha: head_sha,
      messages: [], createdAt: new Date()
    }
    sessions.set(runId, session)

    res.json({
      sessionId: runId,
      proof: { type: norm.type, claim: norm.claim, timestamp: cert.timestamp },
      run: { name: run.name, commit: run.headSha.slice(0, 7) },
      hasScreenshot: !!screenshot,
      workflow: {
        verified: workflowVerified,
        path: workflowPath,
        commitSha: head_sha,
        fromTrustedRepo: owner === 'amiller' && repo === 'github-zktls',
        mismatch: workflowMismatch ? 'Workflow differs from canonical' : null
      }
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Normalize cert fields (different workflows use different names)
function normalizeCert(cert) {
  return {
    type: cert.type || cert.proof_type,
    username: cert.profile || cert.username,
    followers: cert.followers,
    items: cert.items,
    claim: cert.claim || cert.profile || cert.items?.join(', ') || 'verified',
    ...cert
  }
}

// Generate bespoke content with Claude based on proof
app.post('/api/generate', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' })
  const { sessionId, prompt } = req.body
  const session = sessions.get(sessionId)
  if (!session) return res.status(401).json({ error: 'Invalid session' })

  const cert = normalizeCert(session.cert)
  const isCart = cert.type?.includes('amazon') || cert.type?.includes('cart')

  // For cart proofs with screenshot, use vision to read items
  if (isCart && session.screenshot) {
    try {
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: `You help people with verified shopping carts. This person has cryptographically proven their Amazon cart contents via GitHub Actions attestation. Look at their cart screenshot and generate creative content based on what you see.`,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: session.screenshot } },
            { type: 'text', text: prompt || 'Look at my cart and create a fun recipe or meal plan using these ingredients!' }
          ]
        }]
      })
      return res.json({ content: msg.content[0].text, proofType: cert.type })
    } catch (e) {
      return res.status(500).json({ error: e.message })
    }
  }

  // Text-only generation for other proof types
  let systemPrompt = `You are helping someone who has proven something about themselves via a verifiable GitHub Actions attestation.`
  if (cert.type?.includes('twitter')) {
    systemPrompt += `\n\nThey have proven they are Twitter user @${cert.username}. Generate personalized content based on their verified identity.`
  } else {
    systemPrompt += `\n\nTheir verified claim: ${cert.claim}`
  }

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt || 'Generate something for me!' }]
    })
    res.json({ content: msg.content[0].text, proofType: cert.type })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Post to public wall (requires valid session)
app.post('/api/wall', async (req, res) => {
  const { sessionId, message } = req.body
  const session = sessions.get(sessionId)
  if (!session) return res.status(401).json({ error: 'Invalid session' })

  const cert = normalizeCert(session.cert)
  const post = {
    id: Date.now(),
    message,
    proofType: cert.type,
    identity: cert.username || cert.claim,
    runUrl: session.runUrl,
    timestamp: new Date()
  }
  wall.push(post)
  res.json({ post })
})

// Get wall posts
app.get('/api/wall', (req, res) => {
  res.json({ posts: wall.slice(-50).reverse() })
})

// Get session info
app.get('/api/session/:id', (req, res) => {
  const session = sessions.get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Session not found' })
  const cert = normalizeCert(session.cert)
  res.json({ proof: { type: cert.type, claim: cert.claim }, hasScreenshot: !!session.screenshot, createdAt: session.createdAt })
})

// Get session screenshot
app.get('/api/session/:id/screenshot', (req, res) => {
  const session = sessions.get(req.params.id)
  if (!session?.screenshot) return res.status(404).json({ error: 'No screenshot' })
  res.set('Content-Type', 'image/png')
  res.send(Buffer.from(session.screenshot, 'base64'))
})

// Get session workflow (for inspection/audit)
app.get('/api/session/:id/workflow', (req, res) => {
  const session = sessions.get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Session not found' })
  res.json({
    path: session.workflowPath,
    commitSha: session.headSha,
    verified: session.workflowVerified,
    content: session.workflowContent,
    canonical: CANONICAL_WORKFLOWS.get(normalizeCert(session.cert).type) || null
  })
})

// Get random proof options
app.get('/api/proofs/random', (req, res) => {
  const n = parseInt(req.query.n) || 5
  res.json({ proofs: getRandomProofs(n), total: getTotalProofCount() })
})

// Get all proof options (grouped by site)
app.get('/api/proofs/all', (req, res) => {
  res.json({ catalog: PROOF_CATALOG, total: getTotalProofCount() })
})

// Get cached proof runs
app.get('/api/proofs/cache', (req, res) => {
  res.json({ cache: Object.fromEntries(proofCache) })
})

// Cache a proof run
app.post('/api/proofs/cache', (req, res) => {
  const { proofId, runUrl } = req.body
  if (!proofId || !runUrl) return res.status(400).json({ error: 'proofId and runUrl required' })
  proofCache.set(proofId, { runUrl, cachedAt: new Date() })
  res.json({ ok: true })
})

// Generate workflow for a proof type (on-demand, cached)
app.post('/api/workflow/generate', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' })

  const { proofId } = req.body
  if (!proofId) return res.status(400).json({ error: 'proofId required' })

  // Check cache first
  if (workflowCache.has(proofId)) {
    return res.json({ workflow: workflowCache.get(proofId), cached: true })
  }

  // Find proof in catalog
  const allProofs = PROOF_CATALOG.flatMap(site =>
    site.proofs.map(p => ({ ...p, site: site.site, siteName: site.name }))
  )
  const proof = allProofs.find(p => p.id === proofId)
  if (!proof) return res.status(404).json({ error: 'Proof type not found' })

  const secretName = proof.site.replace(/\./g, '_').toUpperCase() + '_SESSION'

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: `You generate GitHub Actions workflow YAML files for capturing authenticated browser proofs.

Follow this exact pattern - output ONLY the YAML, no explanation:

1. Name format: "{Site} {ProofType} Proof"
2. workflow_dispatch with appropriate inputs (username, etc.)
3. Steps: checkout, start browser container, inject session + navigate + screenshot, upload artifacts, cleanup
4. Secret name: ${secretName}
5. Certificate type: ${proofId}

Examples:
---
${EXAMPLE_WORKFLOWS['twitter-followers']}
---
${EXAMPLE_WORKFLOWS['github-contributions']}
---`,
      messages: [{
        role: 'user',
        content: `Generate a workflow for: ${proof.siteName} - ${proof.name}
Proof ID: ${proofId}
Description: ${proof.desc}
Target URL: ${proof.url}
Secret: ${secretName}

Output ONLY the YAML.`
      }]
    })

    const workflow = msg.content[0].text.trim()
    workflowCache.set(proofId, workflow)
    res.json({ workflow, cached: false })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Get cached workflow
app.get('/api/workflow/:proofId', (req, res) => {
  const workflow = workflowCache.get(req.params.proofId)
  if (!workflow) return res.status(404).json({ error: 'Workflow not generated yet' })
  res.json({ workflow })
})

// TEE Browser verification — one-shot Claude script generation + execution
const TEE_BROWSER = process.env.TEE_BROWSER_URL || 'http://localhost:3002'

app.post('/api/verify-tee', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' })
  const { proofId, cookies, url } = req.body

  // Find proof in catalog
  const allProofs = PROOF_CATALOG.flatMap(site =>
    site.proofs.map(p => ({ ...p, site: site.site, siteName: site.name }))
  )
  const proof = allProofs.find(p => p.id === proofId)
  if (!proof && !url) return res.status(400).json({ error: 'proofId or url required' })

  const targetUrl = url || proof.url
  const proofDesc = proof ? `${proof.siteName} - ${proof.name}: ${proof.desc}` : `Custom proof at ${url}`

  try {
    // 1. Inject cookies into TEE browser
    if (cookies) {
      await fetch(`${TEE_BROWSER}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies })
      })
    }

    // 2. Navigate to target
    await fetch(`${TEE_BROWSER}/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl })
    })

    // 3. Wait for page load then capture proof (screenshot + page text)
    await new Promise(r => setTimeout(r, 5000))
    const captureRes = await fetch(`${TEE_BROWSER}/capture`, { method: 'POST' })
    const capture = await captureRes.json()

    // 4. Get screenshot
    const screenshotRes = await fetch(`${TEE_BROWSER}/screenshot`)
    const screenshot = screenshotRes.ok ? Buffer.from(await screenshotRes.arrayBuffer()).toString('base64') : null

    // 5. One-shot Claude to analyze the captured page and verify the claim
    const pageText = capture.certificate?.pageInfo?.bodyText || ''
    const pageTitle = capture.certificate?.pageInfo?.title || ''

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      system: `You analyze captured web page text to verify identity claims. Return ONLY valid JSON: { "success": boolean, "claim": "what was proven", "evidence": "key details extracted" }`,
      messages: [{
        role: 'user',
        content: `Verify: ${proofDesc}\nPage title: ${pageTitle}\nPage text (first 2000 chars):\n${pageText.slice(0, 2000)}`
      }]
    })

    const analysisText = msg.content[0].text.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim()
    let analysis
    try { analysis = JSON.parse(analysisText) } catch { analysis = { success: true, claim: proofDesc, evidence: analysisText } }

    // 6. Build certificate
    const cert = {
      type: proofId || 'custom',
      claim: analysis.claim || proofDesc,
      evidence: analysis.evidence,
      timestamp: new Date().toISOString(),
      url: capture.certificate?.url || targetUrl,
      pageTitle
    }

    const sessionId = `tee-${Date.now()}`
    sessions.set(sessionId, {
      runId: sessionId, cert, screenshot, messages: [], createdAt: new Date()
    })

    res.json({
      sessionId,
      proof: { type: cert.type, claim: cert.claim, timestamp: cert.timestamp },
      result: analysis,
      hasScreenshot: !!screenshot
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.PORT || 3003
app.listen(PORT, () => console.log(`Relying party server: http://localhost:${PORT}`))
