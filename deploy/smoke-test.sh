#!/usr/bin/env bash
# Smoke test for the deployed CVM. Run before any demo to confirm the
# whole pipeline (gateway → app → browser → VPN → Claude) is alive.
#
# Usage: ./deploy/smoke-test.sh
#        ./deploy/smoke-test.sh <app-id>
#
# Looks up the current app-id via `phala cvms list` if you don't pass one.

set -euo pipefail

CVM_NAME=${CVM_NAME:-login-with-everything}
CLUSTER=${CLUSTER:-dstack-pha-prod7}
KEY=${KEY:-deploy_key}

if [[ $# -ge 1 ]]; then
  APP_ID=$1
else
  APP_ID=$(phala cvms list 2>/dev/null | awk -v n="$CVM_NAME" '$2==n {print $1; exit}')
fi

if [[ -z "${APP_ID:-}" ]]; then
  echo "FAIL: could not find app-id for CVM $CVM_NAME" >&2
  exit 1
fi

BASE=https://${APP_ID}-3003.${CLUSTER}.phala.network
fail=0
pass=0

check() {
  local name=$1
  local expect=$2
  local got=$3
  if [[ "$got" == "$expect" ]]; then
    printf "  \033[32mPASS\033[0m %s (got %s)\n" "$name" "$got"
    pass=$((pass+1))
  else
    printf "  \033[31mFAIL\033[0m %s (expected %s, got %s)\n" "$name" "$expect" "$got"
    fail=$((fail+1))
  fi
}

echo "CVM: $CVM_NAME app-id=$APP_ID"
echo

echo "[1] Gateway reachable"
code=$(curl -sk -o /dev/null -w '%{http_code}' --connect-timeout 8 "$BASE/")
check "GET /" 200 "$code"

echo
echo "[2] Boards API"
boards_count=$(curl -sk "$BASE/api/boards" | grep -o '"id":"board' | wc -l)
[[ "$boards_count" -ge 4 ]] && check "boards.length>=4" "true" "true" || check "boards.length>=4" "true" "false ($boards_count)"

echo
echo "[3] Claude path (verify-tee with empty cookies)"
resp=$(curl -sk -X POST -H 'Content-Type: application/json' \
  -d '{"proofId":"reddit-karma","cookies":{},"url":"https://reddit.com"}' \
  "$BASE/api/verify-tee" -w "\n%{http_code}")
code=$(echo "$resp" | tail -1)
body=$(echo "$resp" | head -n -1)
check "verify-tee HTTP" 200 "$code"
echo "$body" | grep -q '"hasScreenshot":true' \
  && check "hasScreenshot" true true \
  || check "hasScreenshot" true false
echo "$body" | grep -q '"sessionId"' \
  && check "sessionId" present present \
  || check "sessionId" present missing

echo
echo "[4] CORS preflight (extension uses MV3 service worker fetch)"
preflight=$(curl -sk -X OPTIONS -H 'Origin: chrome-extension://abc' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' \
  -D - "$BASE/api/verify-cookie" -o /dev/null)
echo "$preflight" | grep -qi 'Access-Control-Allow-Origin: \*' \
  && check "Access-Control-Allow-Origin: *" present present \
  || check "Access-Control-Allow-Origin: *" present missing
preflight_code=$(echo "$preflight" | head -1 | awk '{print $2}')
[[ "$preflight_code" == "204" || "$preflight_code" == "200" ]] \
  && check "preflight 2xx" true true \
  || check "preflight 2xx" true "false ($preflight_code)"

echo
echo "[5] /api/verify-cookie reachable WITHOUT boardId (extension's exact payload)"
# popup.js does NOT send boardId — server must look up board by site instead.
vc_code=$(curl -sk -X POST -H 'Origin: chrome-extension://abc' -H 'Content-Type: application/json' \
  -d '{"cookieName":"_all","cookieValue":"_all","cookies":[],"site":"reddit.com"}' \
  -o /dev/null -w '%{http_code}' "$BASE/api/verify-cookie")
# Empty-cookie call expected to fail at the verification step (200 with error body)
# — what matters is it reached the handler, not 404 "Board not found" / 503.
case "$vc_code" in
  200) check "verify-cookie no-boardId reachable" true true ;;
  *) check "verify-cookie no-boardId reachable" true "false ($vc_code)" ;;
esac

echo
echo "[6] Bridge URL exposed on public gateway (port 3000)"
BRIDGE=https://${APP_ID}-3000.${CLUSTER}.phala.network
b_code=$(curl -sk -o /dev/null -w '%{http_code}' --connect-timeout 8 "$BRIDGE/health")
[[ "$b_code" == "200" ]] && check "bridge /health" 200 200 || check "bridge /health" 200 "$b_code"

echo
echo "[7] GitHub Actions verify.yml workflow registered (extension mode 4)"
GH_REPO=${GH_REPO:-Account-Link/login-with-anything}
if command -v gh >/dev/null 2>&1; then
  vy_status=$(gh api "repos/${GH_REPO}/actions/workflows/verify.yml" --jq '.state' 2>/dev/null || echo missing)
  case "$vy_status" in
    active) check "verify.yml registered on $GH_REPO" active "$vy_status" ;;
    *)      check "verify.yml registered on $GH_REPO" active "$vy_status" ;;
  esac
else
  echo "  SKIP: gh CLI not installed"
fi

echo
echo "[8] Inside CVM (requires SSH key)"
if [[ -f "$KEY" ]]; then
  ssh_out=$(phala ssh "$CVM_NAME" -- -i "$KEY" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    'docker exec dstack-app-1 sh -c "echo K=\${#ANTHROPIC_API_KEY}; ls /data/forum.db >/dev/null 2>&1 && echo DB=ok || echo DB=missing" && docker exec dstack-vpn-1 curl -s --max-time 8 https://api.ipify.org' 2>/dev/null | grep -E '^K=|^DB=|^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')
  key_len=$(echo "$ssh_out" | grep '^K=' | cut -d= -f2)
  db_state=$(echo "$ssh_out" | grep '^DB=' | cut -d= -f2)
  egress=$(echo "$ssh_out" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')
  [[ "$key_len" -gt 50 ]] && check "ANTHROPIC_API_KEY length>50" true true \
    || check "ANTHROPIC_API_KEY length>50" true "false (len=$key_len)"
  check "forum.db on disk" ok "$db_state"
  # Verify VPN is actually up: egress must be a real IP and not in any
  # known Phala/cloud datacenter range we've seen for these CVMs.
  if [[ -z "$egress" ]]; then
    check "VPN egress IP present" true "false (empty)"
  elif [[ "$egress" =~ ^(34\.|35\.|13\.|52\.) ]]; then
    check "egress not GCP/AWS" true "false ($egress)"
  else
    check "VPN egress IP present" "$egress" "$egress"
  fi
else
  echo "  SKIP: $KEY not found"
fi

echo
echo "Pass: $pass  Fail: $fail"
[[ $fail -eq 0 ]] || exit 1
