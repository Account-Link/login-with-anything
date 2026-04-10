// Content script injected on the forum page.
// Bridges the forum's web UI to the extension's cookie-grab capability
// via window.postMessage so the forum can say "get me reddit.com cookies"
// without the user having to open DevTools or the extension popup.

// Announce that the extension is installed so the forum can show
// "Login with Extension" buttons instead of cookie-paste fields.
window.postMessage({ type: 'lwa-extension-installed' }, '*')

window.addEventListener('message', async (event) => {
  if (event.source !== window) return

  if (event.data?.type === 'lwa-request-cookies') {
    const domain = event.data.domain
    try {
      const cookies = await chrome.runtime.sendMessage({ type: 'getCookies', domain })
      window.postMessage({ type: 'lwa-cookies', cookies, domain }, '*')
    } catch (e) {
      window.postMessage({ type: 'lwa-cookies-error', error: e.message, domain }, '*')
    }
  }

  if (event.data?.type === 'lwa-request-github-verify') {
    const domain = event.data.domain
    const boardId = event.data.boardId
    try {
      // 1. Dispatch GitHub Actions (opens status tab with live steps)
      const res = await chrome.runtime.sendMessage({
        type: 'verifyViaGitHub', domain, forumUrl: window.location.origin
      })
      if (res?.error) {
        window.postMessage({ type: 'lwa-github-error', error: res.error, domain }, '*')
        return
      }
      window.postMessage({ type: 'lwa-github-dispatched', result: res, domain }, '*')

      // 2. Also run TEE verification to create a forum session.
      // This way the user is logged into the forum AND gets the GitHub attestation.
      const cookies = await chrome.runtime.sendMessage({ type: 'getCookies', domain })
      if (cookies?.length) {
        const formatted = cookies.map(c => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite
        }))
        const verifyRes = await fetch(window.location.origin + '/api/verify-cookie', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ boardId, cookies: formatted, site: domain })
        })
        const data = await verifyRes.json()
        window.postMessage({ type: 'lwa-github-result', result: { ...res, session: data }, domain }, '*')
      } else {
        window.postMessage({ type: 'lwa-github-result', result: res, domain }, '*')
      }
    } catch (e) {
      window.postMessage({ type: 'lwa-github-error', error: e.message, domain }, '*')
    }
  }
})
