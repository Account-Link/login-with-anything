#!/usr/bin/env python3
"""Write tunnel URL to gist. Reads all config from env vars."""
import json, urllib.request, os

tunnel = os.environ['TUNNEL_URL']
gist_id = os.environ['GIST_ID']
token = os.environ['GH_TOKEN']

payload = json.dumps({
    'files': {'status.json': {'content': json.dumps({'status': 'ready', 'tunnel': tunnel})}}
}).encode()

req = urllib.request.Request(f'https://api.github.com/gists/{gist_id}', data=payload, method='PATCH')
req.add_header('Authorization', f'Bearer {token}')
req.add_header('Content-Type', 'application/json')
resp = urllib.request.urlopen(req)
print(f'Gist updated: {resp.status}')
