import os, base64, requests

API_KEY = os.environ["GEMINI_API_KEY"]
MODEL = "gemini-2.0-flash-exp-image-generation"
URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"

PROMPT = """Create a clean, minimal technical illustration for an academic paper figure.
The image shows a forum-style web application called "Login with Everything".

The layout is a list of discussion boards, each with a different entry requirement:

- "Anthropic Customers" — requires a valid Anthropic API key
- "High Karma Redditors" — requires Reddit karma > 1000, verified via cookie
- "GitHub Developers" — requires a valid GitHub PAT
- "Today's Wordle" — requires NYT Wordle stats, verified via cookie
- "AAdvantage Platinum" — requires airline loyalty status
- "Pre-2022 Accounts" — requires account creation date before 2022

Each board entry shows a small colored badge indicating the verification method (API Key, Cookie, or Browser Session), the credential requirement in small text, and a post count.

Style: clean UI mockup, dark background similar to GitHub's dark theme (#0d1117), with subtle colored badges (green for API Key, orange for Cookie, purple for Browser). Modern sans-serif font. No gradients or 3D effects. Flat design. Should look like a real web application screenshot, not a diagram. Include a header with "Login with Everything" in a clean font and a "+ New Board" button."""

payload = {
    "contents": [{"parts": [{"text": PROMPT}]}],
    "generationConfig": {"responseModalities": ["IMAGE", "TEXT"]}
}

res = requests.post(URL, params={"key": API_KEY}, json=payload)
res.raise_for_status()
data = res.json()

for part in data["candidates"][0]["content"]["parts"]:
    if "inlineData" in part:
        img = base64.b64decode(part["inlineData"]["data"])
        with open("forum_mockup.png", "wb") as f:
            f.write(img)
        print("Saved forum_mockup.png")
        break
else:
    print("No image in response")
    print(data)
