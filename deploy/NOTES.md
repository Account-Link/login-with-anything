# Phala CVM Deploy Notes

The live demo runs as a Phala dstack CVM. This file captures everything you
need to operate it. Verified 2026-04-08.

## Identity

| | |
|---|---|
| CVM name | `login-with-everything` |
| Cluster | `dstack-pha-prod7` |
| Current app-id | `d36facf2a9d92be3c1e554240861a27fcf5fcf31` (changes per deploy — always re-check) |
| Live URL | `https://<app-id>-3003.dstack-pha-prod7.phala.network/` |
| Compose | `deploy/docker-compose.phala.yml` |
| SSH key | `deploy_key` (repo root, gitignored) — public is `deploy/deploy_key.pub` |
| Created with | `--dev-os --ssh-pubkey deploy/deploy_key.pub` |

Look up the current app-id any time with:
```bash
phala cvms list | grep login-with-everything
```

## Containers (4)

```
dstack-app-1      ghcr.io/amiller/login-with-anything-app:latest
dstack-browser-1  ghcr.io/amiller/login-with-anything-browser:latest  (Neko + bridge, port 3000)
dstack-vpn-1      ghcr.io/amiller/openvpn-socks5@sha256:287ca89c...   (SOCKS5 1080, ProtonVPN out)
dstack-ssh-1      built inline (sshd on host net)
```

Private subnet `17.100.0.0/16` — vpn=.2, browser=.3, app=.4. All browser
egress routes through the VPN container (`PROXY_URL=socks5://17.100.0.2:1080`).

## Required CVM secrets

Set via `phala envs update` (sealed, only readable inside the TEE):

| Var | Source | Notes |
|---|---|---|
| `OPENVPN_USER` | ProtonVPN dashboard | OpenVPN/IKEv2 username, not account email |
| `OPENVPN_PASS` | ProtonVPN dashboard | |
| `OVPN_CONFIG_BASE64` | `base64 -w0 your.ovpn` | full config file, base64-encoded |
| `ANTHROPIC_API_KEY` | console.anthropic.com | required for `/api/verify-tee`, `/api/analyze-proof`, `/api/chat-with-evidence` |
| `GITHUB_TOKEN` | github.com/settings/tokens | optional, for the GH Actions board path |

## Common Commands

```bash
# list CVMs
phala cvms list

# deploy / update compose (does not restart containers!)
phala deploy --cvm-id login-with-everything \
  -c deploy/docker-compose.phala.yml \
  --dev-os --ssh-pubkey deploy/deploy_key.pub --wait

# update sealed env vars
phala envs update --cvm-id login-with-everything -e secrets.env
phala cvms restart <uuid>   # required to pick up new envs

# logs
phala logs --cvm-id login-with-everything | tail -50

# SSH (NOTE the -- and the -i goes AFTER --)
phala ssh login-with-everything -- -i deploy_key \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  "docker ps"

# direct SSH fallback when phala ssh acts up
ssh -i deploy_key -p 443 \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  root@<app-id>-22.dstack-pha-prod7.phala.network "docker ps"
```

## Health checks

```bash
APP=d36facf2a9d92be3c1e554240861a27fcf5fcf31  # update from `phala cvms list`
BASE=https://${APP}-3003.dstack-pha-prod7.phala.network

curl -sk $BASE/api/boards | jq .
curl -sk $BASE/api/boards/board-3/posts | jq .

# verify Claude path is alive (returns 503 if ANTHROPIC_API_KEY missing)
curl -sk -X POST -H 'Content-Type: application/json' \
  -d '{"proofId":"test","cookies":{},"url":"https://example.com"}' \
  $BASE/api/verify-tee

# inside the CVM
phala ssh login-with-everything -- -i deploy_key -o StrictHostKeyChecking=no \
  "docker exec dstack-vpn-1 curl -s --max-time 8 https://api.ipify.org"
# expect: residential/Mullvad IP (e.g. 146.70.x.x), NOT a Phala datacenter range

phala ssh login-with-everything -- -i deploy_key -o StrictHostKeyChecking=no \
  "docker exec dstack-browser-1 curl -s http://localhost:3000/health"
```

## Live state as of 2026-04-08 (post-rebuild)

- CVM running with digest-pinned images (see "Image digests" below)
- All four containers up. Browser healthy.
- VPN tunnel up. Egress IP in 146.70.x.x range (Mullvad).
- 4 boards seeded (Anthropic, GitHub, Reddit Karma, Wordle).
- `ANTHROPIC_API_KEY` set (length 108).
- `/data/forum.db` + `forum.db-shm` + `forum.db-wal` present on the persistent
  ZFS volume. SQLite WAL mode active. Posts now persist across restarts.
- `/api/verify-tee` end-to-end test returns 200 with sessionId, screenshot,
  and Claude analysis of fetched Reddit page.
- `deploy/smoke-test.sh` passes 8/8.

### Image digests (digest-pinned in `deploy/docker-compose.phala.yml`)

```
app     ghcr.io/amiller/login-with-anything-app@sha256:5ce5e1e5d6d17db43c1ee12c4147c70d93ed72ec4f837f99033b8697ba259e32
browser ghcr.io/amiller/login-with-anything-browser@sha256:9a228ac477eeb50a316291c464934a9d4426872b09eb061e43543ff6755be93e
vpn     ghcr.io/amiller/openvpn-socks5@sha256:287ca89cb223f70a607ea24f5bf7fc99d6484c5630ff43585a316a8342c3a620
```

The local app image was built+pushed as `ghcr.io/amiller/login-with-anything-app:v0.2.0-sqlite`
on 2026-04-08; the digest above is what the CVM actually pulls. Re-tag any
future builds with a new version, never reuse `:latest`.

## Smoke test

Run before any demo:
```bash
./deploy/smoke-test.sh
```

Checks: gateway reachable, boards API populated, verify-tee returns 200 with
screenshot + sessionId, ANTHROPIC_API_KEY present in container, forum.db on
disk, VPN egress in residential range. Exit code reflects pass/fail.

## GitHub Actions verify mode (extension mode 4)

The extension's `Verify via GitHub Actions` button uploads cookies to a
private gist and dispatches `.github/workflows/verify.yml` with `domain`
and `gist_id` inputs. The workflow:

1. Pulls the gist via `gh api gists/<id>` (auth: `secrets.GH_PAT`, gist scope)
2. Runs the same TEE browser image we pin on the CVM
   (`ghcr.io/amiller/login-with-anything-browser@sha256:9a228ac4...`)
3. Injects cookies → navigates → screenshots → uploads as
   `actions/upload-artifact` and signs with `actions/attest-build-provenance`

**Where it lives:** `Account-Link/login-with-anything` (the upstream org repo).
The workflow file is in `.github/workflows/verify.yml`. The `amiller/login-with-anything`
fork does NOT have this workflow — push there too if your extension's
`settings.ghRepo` targets the fork instead.

**Required repo secrets** (all on `Account-Link/login-with-anything`):
- `GH_PAT` — PAT with `gist` scope, also used by `twitter-like.yml`. The
  workflow strips trailing whitespace before exporting; the existing
  secret had a `\r\n` that broke Go's HTTP client until that fix.
- `OPENVPN_USER`, `OPENVPN_PASS`, `OVPN_CONFIG_BASE64` — same Mullvad
  credentials we use on the Phala CVM. Set 2026-04-08 from the values in
  `deploy/secrets.env`. The workflow degrades gracefully (warning, no
  proxy) if any are missing.

**VPN sidecar architecture.** verify.yml mirrors the Phala CVM compose:
brings up `ghcr.io/amiller/openvpn-socks5@sha256:287ca89c...` (same
digest), puts both containers on a `lwa-net` docker network, points the
browser's `PROXY_URL` env at `socks5://lwa-vpn:1080`. Chromium's
`--proxy-server=$PROXY_URL` flag picks it up via `chromium.conf`.
Verified end-to-end 2026-04-08 (run 24152130997): VPN egress
`135.119.239.131` (Mullvad), reddit.com loaded as the real homepage
with real subreddit content — no more block page.

DNS leak note: Chromium's SOCKS5 mode does local DNS by default. The
HTTP traffic itself goes through the proxy, so reddit sees the Mullvad
IP, but the runner does a DNS lookup for `reddit.com` against its own
resolver. Functional anti-bot bypass works; full DNS-over-SOCKS would
need `--host-resolver-rules` in `chromium.conf` (not done).

**To dispatch manually for testing:**
```bash
# Create a test gist (file MUST be named session.json)
cat > /tmp/session.json <<'EOF'
[{"name":"test","value":"x","domain":".reddit.com","path":"/","secure":true,"httpOnly":true}]
EOF
GIST_ID=$(gh gist create /tmp/session.json --desc 'lwa-test' 2>&1 | grep -oE '[a-f0-9]{20,}')
gh workflow run verify.yml -R Account-Link/login-with-anything \
  -f domain=reddit.com -f gist_id=$GIST_ID
gh run list -R Account-Link/login-with-anything -w verify.yml -L 1
gh gist delete $GIST_ID  # cleanup
```

## Footguns (real ones encountered during this deploy)

### `phala ssh` syntax
`-i` goes AFTER `--`, not before:
```bash
phala ssh login-with-everything -- -i deploy_key <cmd>   # works
phala ssh login-with-everything -i deploy_key -- <cmd>   # ERROR: unknown option
```

### `allowed_envs` vs `phala envs update`
`phala envs update` alone is NOT enough to make a new env var visible to
docker-compose interpolation in the CVM. The var must also be on the
sealed-app `allowed_envs` list, which is set during `phala deploy`. So:

- To add a new var that's referenced as `${MY_VAR}` in compose:
  `phala deploy --cvm-id <name> -c <compose> -e secrets.env`
  (this refreshes both the sealed envs AND allowed_envs)
- `phala envs update` alone only refreshes the encrypted blob — if the var
  isn't in allowed_envs, compose substitutes empty string.

Symptom we hit: `ANTHROPIC_API_KEY` was uploaded via `phala envs update` and
visible in the encrypted blob, but `${ANTHROPIC_API_KEY:-}` in compose
interpolated to empty inside the container. Fixed by running `phala deploy
-e secrets.env` (which re-derives allowed_envs from the env file).

### Sealed env update is REPLACE, not MERGE
`phala envs update -e file.env` replaces the entire sealed env. `secrets.env`
must contain ALL vars the CVM needs (`OPENVPN_USER`, `OPENVPN_PASS`,
`OVPN_CONFIG_BASE64`, `ANTHROPIC_API_KEY`, plus any others). Forgetting one
will break a service silently on the next restart.

### App image tag mutability bit us
The original deploy referenced `:latest` for both the app and browser images.
The app image at that tag was built before commit 950e769 (which added SQLite
persistence), so the deployed CVM was running a stale in-memory-only build
even though the repo had moved on. **Always pin by digest.** Compose now does.

### Anthropic key from `self-attesting-tee/.env` was 401-dead
That .env had a real-format key that returned 401. Recovery is to validate
keys against `https://api.anthropic.com/v1/models` BEFORE uploading them as a
sealed env (the smoke test catches this in step [3]).

## Restoring the demo from scratch

If the CVM dies completely or you need to redeploy on a fresh CVM:

```bash
cd /home/amiller/projects/teleport/login-with-anything

# 1. confirm secrets.env has all four required vars
awk -F= '{print $1}' deploy/secrets.env

# 2. push the app image (re-tag if you have new code)
cd app && docker build -t ghcr.io/amiller/login-with-anything-app:v0.2.x-tag .
docker push ghcr.io/amiller/login-with-anything-app:v0.2.x-tag
docker inspect ghcr.io/amiller/login-with-anything-app:v0.2.x-tag --format '{{index .RepoDigests 0}}'
# update the app: line in deploy/docker-compose.phala.yml with that digest

# 3. deploy
phala deploy --cvm-id login-with-everything \
  -c deploy/docker-compose.phala.yml -e deploy/secrets.env

# 4. wait ~90s for restart, then smoke test
./deploy/smoke-test.sh
```
