// Inject extension's ownerToken into TEE approval page URL so it auto-authenticates
chrome.storage.local.get('ownerToken', ({ ownerToken }) => {
  if (!ownerToken) return;
  const url = new URL(location.href);
  if (url.searchParams.get('owner_token')) return;
  url.searchParams.set('owner_token', ownerToken);
  location.replace(url.toString());
});
