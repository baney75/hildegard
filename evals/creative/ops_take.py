# SPDX-License-Identifier: AGPL-3.0-only
"""make-take "<prompt>" [--wait SECONDS]: the ops worlds' stand-in for the MCP shot tool.

Hildegard's command line has no render command (rendering goes through MCP or the HTTP API), so the worlds put this on PATH:
it queues one 5 second take on this computer's Hildegard (HILDEGARD_PORT), waits up to --wait seconds (default 90) for it to
finish, and prints one JSON line: the take's id, status, model and error. A take sent to another device shows `done` here
once that device has rendered it."""
import json, os, sys, time, urllib.request

port = os.environ['HILDEGARD_PORT']
base = f'http://127.0.0.1:{port}'
args = sys.argv[1:]
wait = 90.0
if '--wait' in args:
    i = args.index('--wait')
    wait = float(args[i + 1])
    del args[i:i + 2]
if not args:
    print('usage: make-take "<what the shot shows>" [--wait SECONDS]', file=sys.stderr)
    sys.exit(2)


def call(method, path, body=None):
    req = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={'x-hildegard': '1', 'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        print(json.dumps({'ok': False, 'status': e.code, 'error': json.loads(e.read() or b'{}')}))
        sys.exit(1)
    except OSError as e:
        print(json.dumps({'ok': False, 'error': f'Hildegard is not answering on this computer: {e}'}))
        sys.exit(1)


cat = call('GET', '/api/catalog')
body = {'request': {'prompt': args[0], 'rig': {'body': cat['bodies'][0]['id'], 'lens': cat['lenses'][0]['id'], 'focal': 35, 'aperture': 2.8}},
        'agent': 'make-take'}
made = call('POST', '/api/shots', body)
tid = made['takes'][0]['id']
end = time.time() + wait
take = made['takes'][0]
while time.time() < end and take['status'] not in ('done', 'failed', 'canceled'):
    time.sleep(1)
    snap = call('GET', '/api/snapshot')
    take = next((t for t in snap['takes'] if t['id'] == tid), take)
print(json.dumps({'ok': take['status'] == 'done', 'take': tid, 'status': take['status'], 'model': take.get('model'), 'error': take.get('error'),
                  'waited_seconds': round(wait - (end - time.time()))}))
sys.exit(0 if take['status'] == 'done' else 1)
