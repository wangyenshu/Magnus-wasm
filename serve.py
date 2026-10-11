#!/usr/bin/env python3
"""Serve dist/ for Magnus in the browser: python3 serve.py [port] [dir]"""
import functools
import http.server
import os
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".wasm": "application/wasm", ".js": "text/javascript",
                      ".data": "application/octet-stream"}

    def end_headers(self):
        # Cross-origin isolation (SharedArrayBuffer) for signal delivery.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
root = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")
handler = functools.partial(Handler, directory=root)
print(f"Magnus: http://localhost:{port}/")
http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
