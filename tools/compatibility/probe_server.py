#!/usr/bin/env python3
"""Loopback-only synthetic page for cookies, storage and browser MCP checks."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from urllib.parse import urlsplit

PAGE = b'''<!doctype html><html lang="en"><meta charset="utf-8">
<title>Zen compatibility probe</title>
<style>body{font:20px system-ui;padding:3rem;max-width:50rem;color:#213047}
button,input{font:inherit;margin:.4rem;padding:.5rem}output{display:block}</style>
<h1>Zen compatibility probe</h1><p>Only synthetic test data is used here.</p>
<button id="increment">Increment test counter</button><output id="counter">0</output>
<form id="probe-login" autocomplete="off"><label>Test username
<input name="username" autocomplete="username"></label><label>Test password
<input name="password" type="password" autocomplete="current-password"></label>
<button type="submit">Test form</button></form><output id="form-result"></output>
<script>
// Restore this tab at a URL that never sets the cookie again.
if(location.pathname==='/seed')history.replaceState(null,'','/');
document.querySelector('#increment').onclick=()=>{
  const n=Number(localStorage.getItem('zen-probe-counter')||0)+1;
  localStorage.setItem('zen-probe-counter',String(n));
  document.querySelector('#counter').textContent=String(n);
};
document.querySelector('#counter').textContent=localStorage.getItem('zen-probe-counter')||'0';
document.querySelector('#probe-login').onsubmit=e=>{
  e.preventDefault();document.querySelector('#form-result').textContent='Synthetic form submitted';
};
</script></html>'''


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/health':
            data, content_type = b'{"fixture":"zen-probe","loopback":true}', 'application/json'
        elif path in ('/', '/seed'):
            data, content_type = PAGE, 'text/html; charset=utf-8'
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        if path == '/seed':
            self.send_header('Set-Cookie', 'zen_probe=synthetic-v1; Max-Age=2592000; Path=/; SameSite=Lax')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('Choose an unprivileged loopback port')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(json.dumps({'url': 'http://127.0.0.1:%s/' % args.port, 'synthetic_only': True}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
