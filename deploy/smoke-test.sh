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
echo "[4] Inside CVM (requires SSH key)"
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
  case "$egress" in
    146.70.*|185.*|193.*) check "egress IP looks residential" true true ;;
    *) check "egress IP looks residential" true "false ($egress)" ;;
  esac
else
  echo "  SKIP: $KEY not found"
fi

echo
echo "Pass: $pass  Fail: $fail"
[[ $fail -eq 0 ]] || exit 1
