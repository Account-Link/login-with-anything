// Twitter/X like/unlike via tab script injection
// Clicks the actual like button on the real twitter page

let _xTabId = null;

async function ensureXTab() {
  if (_xTabId) {
    try { await chrome.tabs.get(_xTabId); return _xTabId; } catch { _xTabId = null; }
  }
  const [existing] = await chrome.tabs.query({url: 'https://x.com/*'});
  if (existing) { _xTabId = existing.id; return _xTabId; }
  const tab = await chrome.tabs.create({url: 'https://x.com', active: false});
  _xTabId = tab.id;
  await new Promise(r => setTimeout(r, 3000));
  return _xTabId;
}

async function clickLikeButton(tweetId) {
  const tabId = await ensureXTab();

  // Navigate to the tweet if not already there
  const tab = await chrome.tabs.get(tabId);
  const tweetUrl = `https://x.com/i/status/${tweetId}`;
  if (!tab.url.includes(tweetId)) {
    await chrome.tabs.update(tabId, {url: tweetUrl});
    await new Promise(r => setTimeout(r, 2000));
  }

  const [result] = await chrome.scripting.executeScript({
    target: {tabId},
    func: () => {
      const btn = document.querySelector('[data-testid="like"]') || document.querySelector('[data-testid="unlike"]');
      if (!btn) return {error: 'Like button not found'};
      const wasLiked = btn.getAttribute('data-testid') === 'unlike';
      btn.click();
      return {clicked: true, wasLiked, nowLiked: !wasLiked};
    },
  });

  if (result.error) throw new Error(result.error.message || 'Script failed');
  if (result.result.error) throw new Error(result.result.error);
  return result.result;
}
