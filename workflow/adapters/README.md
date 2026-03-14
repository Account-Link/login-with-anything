# Login With Anything — Adapters

Each adapter is a self-contained script that checks one fact about an authenticated account.

## How to add a new integration

Write a script that:
1. Reads credentials from environment variables
2. Polls an API endpoint
3. Returns a boolean result

```javascript
import { createObserver } from '../observer.js';

async function poll() {
  // Your API call here — return true or false
  const res = await fetch('https://api.example.com/check', {
    headers: { 'Authorization': `Bearer ${process.env.API_TOKEN}` },
  });
  const data = await res.json();
  return data.some_condition;
}

createObserver({
  name: 'example-check',
  poll,
  description: 'Checking something on example.com',
}).run();
```

Then create a workflow in `.github/workflows/` that runs your adapter with the right secrets.

## Existing adapters

| Adapter | What it checks | Secrets needed |
|---------|---------------|----------------|
| `twitter-like.js` | Has user liked a tweet? | `TWITTER_COOKIES` (json: ct0 + auth_token) |
| `github-star.js` | Has user starred a repo? | `GH_TOKEN` |
| `gmail-absence.js` | Are there 0 emails from a sender? | `GMAIL_TOKEN` |
