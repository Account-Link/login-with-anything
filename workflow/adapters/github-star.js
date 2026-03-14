// Log in with GitHub Star
// Polls whether the authenticated user has starred a specific repo
// No special cookies needed — just a GitHub token

import { createObserver } from '../observer.js';

const repo = process.env.REPO; // e.g. "amiller/login-with-anything"
const ghToken = process.env.GH_TOKEN;

if (!repo) { console.error('REPO required (e.g. owner/name)'); process.exit(1); }
if (!ghToken) { console.error('GH_TOKEN required'); process.exit(1); }

async function poll() {
  const res = await fetch(`https://api.github.com/user/starred/${repo}`, {
    headers: {
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });
  // 204 = starred, 404 = not starred
  return res.status === 204;
}

const obs = createObserver({
  name: 'github-star',
  poll,
  description: `Watching ${repo}`,
});

obs.run();
