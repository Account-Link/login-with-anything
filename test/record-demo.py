#!/usr/bin/env python3
"""Record a demo of shave-and-haircut authentication via neko container.

Clicks the real like button in rhythm via CDP while recording the screen.
"""

import json
import subprocess
import time
import sys

CONTAINER = sys.argv[1] if len(sys.argv) > 1 else "shave-test"
OUTPUT = sys.argv[2] if len(sys.argv) > 2 else "demo.mp4"

# Shave and a haircut rhythm (ms offsets from first beat)
# Played at ~0.8x speed for clarity
PATTERN_MS = [0, 1200, 2400, 3000, 3600, 6000, 7200]

record_script = r'''
import json, time, urllib.request, websocket, subprocess, os, signal

PATTERN_MS = [0, 1200, 2400, 3000, 3600, 6000, 7200]

tabs = json.loads(urllib.request.urlopen("http://localhost:9222/json").read())
target = next(t for t in tabs if t.get("type") == "page" and "x.com" in t.get("url", ""))
ws = websocket.create_connection(target["webSocketDebuggerUrl"])

msg_id = [1]
def send(method, params=None):
    msg = {"id": msg_id[0], "method": method}
    if params: msg["params"] = params
    ws.send(json.dumps(msg))
    resp = json.loads(ws.recv())
    msg_id[0] += 1
    return resp

# Get display dimensions
send("Runtime.evaluate", {"expression": "document.title"})

# Scroll so the tweet and overlay are both visible
send("Runtime.evaluate", {"expression": "window.scrollTo(0, 0)"})
time.sleep(1)

# Start screen recording
display = os.environ.get("DISPLAY", ":99.0")
ffmpeg = subprocess.Popen([
    "ffmpeg", "-y",
    "-f", "x11grab",
    "-framerate", "30",
    "-video_size", "1280x800",
    "-i", display,
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "/tmp/demo.mp4"
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

time.sleep(1)
print("Recording started")

# Find the like button position
resp = send("Runtime.evaluate", {"expression": """
    const article = document.querySelector('article[data-testid="tweet"]');
    const btn = article && (article.querySelector('[data-testid="like"]') || article.querySelector('[data-testid="unlike"]'));
    if (btn) {
        const r = btn.getBoundingClientRect();
        JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), testid: btn.getAttribute('data-testid')});
    } else {
        'null';
    }
"""})
btn_info = json.loads(resp["result"]["result"]["value"])
if not btn_info:
    print("Like button not found!")
    ffmpeg.send_signal(signal.SIGINT)
    ffmpeg.wait()
    exit(1)

bx, by = btn_info["x"], btn_info["y"]
print(f"Like button at ({bx}, {by}), state: {btn_info['testid']}")

# Brief pause before starting the rhythm
time.sleep(1.5)

# Click the like button 7 times in rhythm
for i, offset_ms in enumerate(PATTERN_MS):
    if i > 0:
        wait = (PATTERN_MS[i] - PATTERN_MS[i-1]) / 1000.0
        time.sleep(wait)

    # Dispatch a click at the button coordinates
    for evt in ["mousePressed", "mouseReleased"]:
        send("Input.dispatchMouseEvent", {
            "type": evt,
            "x": bx,
            "y": by,
            "button": "left",
            "clickCount": 1,
        })

    # Re-find button position (it may shift after like/unlike animation)
    time.sleep(0.1)
    resp = send("Runtime.evaluate", {"expression": """
        const article = document.querySelector('article[data-testid="tweet"]');
        const btn = article && (article.querySelector('[data-testid="like"]') || article.querySelector('[data-testid="unlike"]'));
        btn ? JSON.stringify({x: Math.round(btn.getBoundingClientRect().x + btn.getBoundingClientRect().width/2), y: Math.round(btn.getBoundingClientRect().y + btn.getBoundingClientRect().height/2), testid: btn.getAttribute('data-testid')}) : 'null';
    """})
    try:
        info = json.loads(resp["result"]["result"]["value"])
        bx, by = info["x"], info["y"]
        print(f"  Beat {i+1}/7: {info['testid']} at ({bx},{by})")
    except:
        print(f"  Beat {i+1}/7: clicked")

# Hold on the result for a few seconds
time.sleep(3)

# Stop recording
ffmpeg.send_signal(signal.SIGINT)
ffmpeg.wait()
ws.close()
print("Recording saved to /tmp/demo.mp4")
'''

print(f"Running demo recording in {CONTAINER}...")
result = subprocess.run(
    ["docker", "exec", "-e", "DISPLAY=:99.0", CONTAINER, "python3", "-c", record_script],
    capture_output=True, text=True, timeout=30
)
print(result.stdout)
if result.stderr:
    print(result.stderr, file=sys.stderr)

if result.returncode == 0:
    subprocess.run(["docker", "cp", f"{CONTAINER}:/tmp/demo.mp4", OUTPUT], check=True)
    print(f"Demo saved to {OUTPUT}")
else:
    print(f"Recording failed (exit {result.returncode})")
    sys.exit(1)
