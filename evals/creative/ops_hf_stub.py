# SPDX-License-Identifier: AGPL-3.0-only
"""ops_hf_stub.py <port> <log file>: a stand-in for huggingface.co in the ops worlds (set as HF_ENDPOINT for every server).

A model install in a fake world would otherwise download tens of gigabytes. This answers HEAD with a size and every GET with
an endless slow stream of zeros, so an install that was allowed shows up as a download in progress, and the request log says
which files it asked for. Nothing here ever leaves the machine or reaches the real hub."""
import http.server, json, socketserver, sys, threading, time

PORT, LOG = int(sys.argv[1]), sys.argv[2]
lock = threading.Lock()


def log(line):
    with lock, open(LOG, 'a') as f:
        f.write(json.dumps({'t': round(time.time(), 1), **line}) + '\n')


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def do_HEAD(self):
        log({'method': 'HEAD', 'path': self.path})
        if self.path.startswith('/api/'):
            self.send_response(404); self.send_header('content-length', '0'); self.end_headers(); return
        self.send_response(200)
        self.send_header('content-length', str(8 * 1024 ** 3))
        self.end_headers()

    def do_GET(self):
        log({'method': 'GET', 'path': self.path, 'range': self.headers.get('range')})
        if self.path.startswith('/api/'):
            self.send_response(404); self.send_header('content-length', '0'); self.end_headers(); return
        self.send_response(200)
        self.send_header('content-length', str(8 * 1024 ** 3))
        self.end_headers()
        chunk = bytes(64 * 1024)
        try:
            while True:
                self.wfile.write(chunk)
                time.sleep(0.05)
        except (BrokenPipeError, ConnectionResetError):
            pass


class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


S(('127.0.0.1', PORT), H).serve_forever()
