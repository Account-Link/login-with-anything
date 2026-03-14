// Log in with Gmail Absence (inspired by Burnt's "Redacted File")
// Proves you do NOT have emails from a specific sender
// Poll returns true = no emails found (clean), false = emails found
//
// Requires: GMAIL_TOKEN (OAuth access token), SENDER_EMAIL

import { createObserver } from '../observer.js';

const senderEmail = process.env.SENDER_EMAIL;
const token = process.env.GMAIL_TOKEN;

if (!senderEmail) { console.error('SENDER_EMAIL required'); process.exit(1); }
if (!token) { console.error('GMAIL_TOKEN required'); process.exit(1); }

async function poll() {
  const query = encodeURIComponent(`from:${senderEmail}`);
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=1`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}`);
  const data = await res.json();
  // true = no messages from sender (clean)
  return !data.messages || data.messages.length === 0;
}

const obs = createObserver({
  name: 'gmail-absence',
  poll,
  description: `Checking for emails from ${senderEmail}`,
});

obs.run();
