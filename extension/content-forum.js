// Content script injected on the forum page.
// Bridges the forum's web UI to the extension's cookie-grab capability
// via window.postMessage so the forum can say "get me reddit.com cookies"
// without the user having to open DevTools or the extension popup.

// Announce that the extension is installed so the forum can show
// "Login with Extension" buttons instead of cookie-paste fields.
window.postMessage({ type: 'lwa-extension-installed' }, '*')

window.addEventListener('message', async (event) => {
  if (event.source !== window) return
  if (event.data?.type !== 'lwa-request-cookies') return

  const domain = event.data.domain
  try {
    // Ask the service worker to grab cookies for the domain.
    // This reuses the existing getCookies handler in service-worker.js.
    const cookies = await chrome.runtime.sendMessage({ type: 'getCookies', domain })
    window.postMessage({ type: 'lwa-cookies', cookies, domain }, '*')
  } catch (e) {
    window.postMessage({ type: 'lwa-cookies-error', error: e.message, domain }, '*')
  }
})
