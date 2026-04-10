#!/usr/bin/env bash
# End-to-end test of the extension's "Login with Extension" flow.
#
# Usage:
#   ./test/run-extension-test.sh                     # test reddit (board index 2)
#   ./test/run-extension-test.sh reddit.com 2        # explicit domain + board index
#   ./test/run-extension-test.sh amazon.com 4        # test amazon board
#   FORUM_URL=http://localhost:3003 ./test/run-extension-test.sh  # local stack
#
# Prerequisites:
#   - test/docker-compose.yml running: cd test && docker compose up -d --build
#   - browser_cookie3 installed: pip3 install browser_cookie3
#   - Chrome not running or cookies unlocked (browser_cookie3 reads the DB)

set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN=${1:-reddit.com}
BOARD_INDEX=${2:-2}
CONTAINER=test-chrome

echo "=== Extract ${DOMAIN} cookies from local Chrome ==="
python3 -c "
import browser_cookie3, json
cj = browser_cookie3.chrome(domain_name='.${DOMAIN}')
cookies = [{'name':c.name,'value':c.value,'domain':c.domain,
            'path':c.path or '/','secure':bool(c.secure),
            'httpOnly':bool(c.has_nonstandard_attr('HttpOnly'))} for c in cj]
print(f'{len(cookies)} cookies for ${DOMAIN}')
if not cookies: print('ERROR: no cookies found'); exit(1)
json.dump(cookies, open('/tmp/test-cookies.json','w'))
"

echo "=== Prepare test container ==="
# Install ws if needed
docker exec $CONTAINER sh -c 'test -d /tmp/node_modules/ws || npm install --prefix /tmp ws' 2>&1 | tail -1

# Switch manifest to host_permissions for auto-grant (test-only)
docker exec $CONTAINER python3 -c "
import json
m = json.load(open('/usr/share/chromium/extensions/lwa/manifest.json'))
if 'optional_host_permissions' in m:
    m['host_permissions'] = m.pop('optional_host_permissions')
    json.dump(m, open('/usr/share/chromium/extensions/lwa/manifest.json','w'), indent=2)
    print('Switched to host_permissions, restarting chromium...')
else:
    print('Already using host_permissions')
"
docker exec $CONTAINER supervisorctl restart chromium 2>&1 | tail -1
sleep 5

# Copy files into container
docker cp /tmp/test-cookies.json $CONTAINER:/tmp/cookies.json
docker cp test/test-extension.mjs $CONTAINER:/tmp/test-extension.mjs

echo "=== Run end-to-end test ==="
RESULT=0
docker exec \
  -e FORUM_URL="${FORUM_URL:-}" \
  -e BOARD_INDEX="$BOARD_INDEX" \
  -e NODE_PATH=/tmp/node_modules \
  $CONTAINER node --experimental-modules /tmp/test-extension.mjs || RESULT=$?

echo "=== Restore manifest ==="
git checkout extension/manifest.json 2>/dev/null || true

if [ $RESULT -eq 0 ]; then
  echo "=== PASS ==="
  # Copy screenshot to host
  docker cp $CONTAINER:/tmp/test-result.png /tmp/test-extension-result.png 2>/dev/null && \
    echo "Screenshot: /tmp/test-extension-result.png"
else
  echo "=== FAIL (exit $RESULT) ==="
fi
exit $RESULT
