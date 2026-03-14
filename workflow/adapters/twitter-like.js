// Log in with Twitter Like
// Polls whether the authenticated user has liked a specific tweet

import { createObserver } from '../observer.js';

const BEARER = process.env.TWITTER_BEARER || 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const tweetId = process.env.TWEET_ID;
const cookies = JSON.parse(process.env.TWITTER_COOKIES);

if (!tweetId) { console.error('TWEET_ID required'); process.exit(1); }

async function poll() {
  const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const vars = JSON.stringify({
    tweetId: tweetId,
    withCommunity: false,
    includePromotedContent: false,
    withVoice: false,
    withBirdwatchNotes: false,
    withV2Timeline: true,
  });
  const queryId = process.env.TWITTER_QUERY_ID || '-pZk1GFMnSjUsrsS2vyXNA';
  const res = await fetch(`https://x.com/i/api/graphql/${queryId}/TweetResultByRestId?variables=${encodeURIComponent(vars)}`, {
    headers: {
      'Authorization': `Bearer ${BEARER}`,
      'x-csrf-token': cookies.ct0,
      'Cookie': cookieStr,
    },
  });
  if (res.status === 429) {
    console.error('Rate limited, waiting 5s...');
    await new Promise(r => setTimeout(r, 5000));
    return poll();
  }
  if (!res.ok) throw new Error(`Twitter API ${res.status}`);
  const data = await res.json();
  // TweetResultByRestId response shape
  const legacy = data?.data?.tweetResult?.result?.legacy;
  if (legacy && 'favorited' in legacy) return legacy.favorited;
  // TweetDetail fallback
  for (const inst of data?.data?.threaded_conversation_with_injections_v2?.instructions || []) {
    for (const entry of inst.entries || []) {
      const l = entry.content?.itemContent?.tweet_results?.result?.legacy;
      if (l && 'favorited' in l) return l.favorited;
    }
  }
  throw new Error('Could not find favorited field: ' + JSON.stringify(data).slice(0, 200));
}

const obs = createObserver({
  name: 'twitter-like',
  poll,
  description: `Watching tweet ${tweetId}`,
});

obs.run();
