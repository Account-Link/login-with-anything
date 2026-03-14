#!/bin/bash
# Test the poller locally
# Usage: ./test-local.sh <tweet_id>
#
# First, grab your Twitter cookies from browser DevTools:
#   1. Open x.com, F12 > Application > Cookies
#   2. Copy ct0 and auth_token values
#   3. Export as JSON: export TWITTER_COOKIES='{"ct0":"...","auth_token":"..."}'

set -e

if [ -z "$1" ]; then echo "Usage: $0 <tweet_id>"; exit 1; fi
if [ -z "$TWITTER_COOKIES" ]; then echo "Set TWITTER_COOKIES env var first"; exit 1; fi

mkdir -p output
TWEET_ID="$1" node poll-tweet.js
