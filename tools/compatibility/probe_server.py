#!/usr/bin/env python3
"""Loopback-only synthetic page for cookies, storage and browser MCP checks."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
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

# Long, stable English text exercises the real native language detector and
# model, including the user's common case where English is a preferred language.
# No account data, remote dependencies or scripted translation simulation.
TRANSLATION_TEXT = """This is a translation playground.
The browser should translate this entire page into Russian when the reader chooses the page translation command from the context menu. The original document must return when the reader asks to see the original again.
Today we are testing a small local browser improvement. A family is visiting a quiet town near the sea. They walk through a garden, look at the flowers, and stop at a little restaurant for lunch. The weather is warm and the sky is clear. In the afternoon they plan to visit the library and read about the history of the town.
The library has a collection of books about science, art, and travel. A friendly librarian explains how to find the right shelf. The children choose a story about a mountain expedition, while their parents find a guide to the nearby islands. Everyone enjoys the peaceful room and the view of the harbor through the large windows.
After leaving the library, they buy some fruit at the market. The seller tells them which apples are sweet and which are best for baking. They put the fruit in a bag and return to their hotel before sunset. They talk about the places they visited and decide to take a boat trip the next morning.
This page contains only synthetic text. There are no passwords, personal cookies, or account details. The test observes the translated document and then checks that the original English text is restored exactly, including the heading and all paragraphs.
"""
TRANSLATION_PAGE = (
    '<!doctype html><html lang="en"><meta charset="utf-8">'
    '<title>Zen page translation probe</title>'
    '<style>body{font:20px system-ui;padding:3rem;max-width:50rem;line-height:1.5}</style>'
    '<main id="translation-probe"><h1>' + TRANSLATION_TEXT.splitlines()[0] + '</h1>'
    + ''.join('<p>' + paragraph + '</p>' for paragraph in TRANSLATION_TEXT.splitlines()[1:])
    + '</main></html>'
).encode('utf-8')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/health':
            data, content_type = b'{"fixture":"zen-probe","loopback":true}', 'application/json'
        elif path in ('/', '/seed'):
            data, content_type = PAGE, 'text/html; charset=utf-8'
        elif path == '/translation':
            data, content_type = TRANSLATION_PAGE, 'text/html; charset=utf-8'
        elif path == '/pip':
            data = Path(__file__).with_name('pip.html').read_bytes()
            content_type = 'text/html; charset=utf-8'
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
