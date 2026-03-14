#!/usr/bin/env python3
"""Extract x.com cookies from local browser, inject into neko container via CDP."""

import browser_cookie3
import json
import subprocess
import sys
import tempfile
import os

CONTAINER = sys.argv[1] if len(sys.argv) > 1 else "shave-test"

print("Extracting x.com cookies from local browser...")
cj = browser_cookie3.chrome(domain_name=".x.com")
cookies = []
for c in cj:
    cookie = {
        "name": c.name,
        "value": c.value,
        "domain": c.domain,
        "path": c.path,
        "secure": c.secure,
        "httpOnly": c.has_nonstandard_attr("HttpOnly"),
    }
    if c.expires:
        cookie["expires"] = c.expires
    cookies.append(cookie)

print(f"Found {len(cookies)} cookies for x.com")
key_cookies = [c["name"] for c in cookies if c["name"] in ("ct0", "auth_token")]
print(f"Key cookies present: {key_cookies}")
if not key_cookies:
    print("Missing auth cookies — are you logged into x.com in Chrome?")
    sys.exit(1)

cookies_json = json.dumps(cookies)
with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
    f.write(cookies_json)
    tmp = f.name

subprocess.run(["docker", "cp", tmp, f"{CONTAINER}:/tmp/cookies.json"], check=True)
os.unlink(tmp)

# The CDP injection script runs inside the container
inject_script = r"""
import json, time, urllib.request, websocket

cookies = json.load(open("/tmp/cookies.json"))

tabs = json.loads(urllib.request.urlopen("http://localhost:9222/json").read())
target = next(t for t in tabs if t.get("type") == "page")
ws = websocket.create_connection(target["webSocketDebuggerUrl"])

msg_id = [1]
def send(method, params=None):
    msg = {"id": msg_id[0], "method": method}
    if params: msg["params"] = params
    ws.send(json.dumps(msg))
    resp = json.loads(ws.recv())
    msg_id[0] += 1
    if "error" in resp:
        print(f"  CDP error: {resp['error']}")
    return resp

# Clear existing cookies for x.com first
send("Network.enable")
send("Network.clearBrowserCookies")
time.sleep(1)

# Set each cookie explicitly with URL to ensure domain binding
for c in cookies:
    domain = c["domain"]
    url = f"https://{domain.lstrip('.')}"
    params = {
        "name": c["name"],
        "value": c["value"],
        "url": url,
        "domain": domain,
        "path": c["path"],
        "secure": True,
        "httpOnly": c["httpOnly"],
        "sameSite": "None",
    }
    if "expires" in c:
        params["expires"] = c["expires"]
    resp = send("Network.setCookie", params)
    ok = resp.get("result", {}).get("success", False)
    if not ok:
        print(f"  FAILED: {c['name']} on {domain}")

# Verify
resp = send("Network.getCookies", {"urls": ["https://x.com"]})
names = [c["name"] for c in resp.get("result", {}).get("cookies", [])]
print(f"Cookies now on x.com: {names}")
auth = [n for n in names if n in ("ct0", "auth_token")]
print(f"Auth cookies present: {auth}")

# Navigate to x.com/home (requires login)
send("Page.navigate", {"url": "https://x.com/home"})
time.sleep(5)

# Check final URL
resp = send("Runtime.evaluate", {"expression": "document.title + ' | ' + window.location.href"})
print(f"Page: {resp.get('result', {}).get('result', {}).get('value', '?')}")

ws.close()
"""

result = subprocess.run(
    ["docker", "exec", CONTAINER, "python3", "-c", inject_script],
    capture_output=True, text=True
)
print(result.stdout)
if result.stderr:
    print(result.stderr, file=sys.stderr)

subprocess.run(["docker", "exec", CONTAINER, "rm", "-f", "/tmp/cookies.json"])
print("Cookies cleaned up from container")
sys.exit(result.returncode)
