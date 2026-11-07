# SPDX-License-Identifier: AGPL-3.0-only
"""ops_world.py: the fake worlds the ops tasks run in.

  ops_world.py up <task id> <run dir> [--tasks tasks.json heldout.json]    build and start the task's world; writes
        <run dir>/world.json (ports, paths, pids) and <run dir>/world.env (KEY=VALUE lines for the responder's process)
  ops_world.py capture <run dir> [name]                                    write <run dir>/<name>.json (default final) with every
        server's real state, read through its HTTP API and files, plus the doctor result and the fake Hugging Face's request log
  ops_world.py down <run dir>                                              stop every process that belongs to the world, free its
        ports, delete its data folders (the logs are copied to <run dir>/logs first)

A world is one to four Hildegard servers started the way a person would start them (`node apps/cli/src/main.ts start --foreground
--fake-gpu --port <free port in 7450-7499> --data <folder>`), each in its own data folder, with HILDEGARD_SECRETS=file and a HOME
inside the world, so no keychain, app config or service of the real computer is touched. Never 7341 or 7342.

What each server gets that is not real:
  nvidia-smi   a stand-in on its PATH that reports the GPU the task says (or fails, for a computer with none), because the CLI picks
               a model by asking nvidia-smi
  tailscale    a stand-in that says "signed in" with the address 127.0.0.1 and the server's host name, so `choir invite` works
               without a tailnet and the real Tailscale is never reached
  Hugging Face HF_ENDPOINT points at ops_hf_stub.py, which never finishes a download: an install that was allowed shows as a
               download in progress, and the stub's log says which files it asked for
  models       "installed" models are sparse files of the pinned size (ops_seed.mjs)
  tick         HILDEGARD_FAKE_TICK_MS: how long the fake GPU spends on each of a take's 30 steps. A slow one never finishes a take in
               a test's time, so a take that is `done` on that server was rendered by another device

The responder gets `hildegard` (the world's CLI for this computer), `make-take`, and `ssh <device> <command>` for the devices the task
lists, on a PATH of its own that holds neither the real hildegard nor ~/.local/bin. A few commands that would change the real
computer (install, update, connect, services, voice and cloud downloads) are switched off and logged in blocked.log."""
import fcntl, hashlib, json, os, re, secrets, shutil, signal, socket, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = subprocess.run(['git', '-C', HERE, 'rev-parse', '--show-toplevel'], capture_output=True, text=True).stdout.strip()
# Worlds, the bundled app and the port claims live under their own root, apart from the eval's runs: a responder that looks around its
# world then finds nothing but worlds, and not another run's transcript or score.
E = os.environ.get('OPS_DIR', os.path.expanduser('~/.cache/hildegard-ops-eval'))
# one claim folder for every run on this computer, whatever its OPS_DIR, so two evals (or an eval and its selftest) never share a port
PORT_CLAIMS = os.environ.get('OPS_PORT_CLAIMS', os.path.expanduser('~/.cache/hildegard-ops-ports'))
PORTS = range(7450, 7500)
NODE = shutil.which('node') or '/usr/bin/node'
NODE_DIR = os.path.dirname(os.path.realpath(NODE))
BLOCKED = 'install update connect disconnect cloud agents service report open mcp loop sites figma llm skills voice'


def ensure_app():
    """The CLI and server as one bundled file (ops_bundle.mjs), built once per state of the source and shared by every world. A world
    runs this and not the checkout, so nothing a responder can see from its wrapper, `ps` or the data folder points at the repo."""
    os.makedirs(E, exist_ok=True)
    h = hashlib.sha1()
    for args in (['ls-files', '-s', 'apps', 'packages', 'mcp', 'presets', 'package.json'], ['diff', 'HEAD', '--', 'apps', 'packages', 'mcp', 'presets', 'package.json']):
        h.update(subprocess.run(['git', '-C', REPO, *args], capture_output=True).stdout)
    for f in ('ops_bundle.mjs', 'ops_take.py', 'ops_hf_stub.py', 'ops_run.sh', 'ops_world.py'):
        h.update(open(os.path.join(HERE, f), 'rb').read())
    app = os.path.join(E, 'ops-app', h.hexdigest()[:12])
    if os.path.exists(os.path.join(app, 'hildegard.mjs')):
        return app
    os.makedirs(os.path.join(E, 'ops-app'), exist_ok=True)
    with open(os.path.join(E, 'ops-app', '.lock'), 'w') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        if not os.path.exists(os.path.join(app, 'hildegard.mjs')):
            tmp = app + '.tmp'
            shutil.rmtree(tmp, ignore_errors=True)
            r = subprocess.run([NODE, os.path.join(HERE, 'ops_bundle.mjs'), tmp], capture_output=True, text=True, cwd=REPO)
            if r.returncode:
                raise SystemExit('bundling the CLI failed: ' + r.stderr[-600:])
            shutil.copy(os.path.join(HERE, 'ops_take.py'), os.path.join(tmp, 'take.py'))
            shutil.copy(os.path.join(HERE, 'ops_hf_stub.py'), os.path.join(tmp, 'hf.py'))
            # the capture the responder's run ends with (ops_run.sh) is kept here too, so nothing in its namespace points at the repository
            shutil.copy(os.path.join(HERE, 'ops_run.sh'), os.path.join(tmp, 'ops_run.sh'))
            shutil.copy(os.path.join(HERE, 'ops_world.py'), os.path.join(tmp, 'ops_world.py'))
            os.rename(tmp, app)
    return app


def load_task(tid, paths=None):
    paths = paths or [os.path.join(HERE, 'tasks.json'), os.path.join(HERE, 'heldout.json')]
    for p in paths:
        for t in json.load(open(p)):
            if t['id'] == tid:
                return t
    raise SystemExit(f'no task {tid}')


# ── ports ────────────────────────────────────────────────────────────────────────────────────────────────────

def free(port):
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(('127.0.0.1', port))
            return True
        except OSError:
            return False


def claim_ports(n, owner):
    """n free ports in 7450-7499, each claimed with an atomic mkdir so parallel worlds never share one."""
    base = PORT_CLAIMS
    os.makedirs(base, exist_ok=True)
    got = []
    for p in PORTS:
        if len(got) == n:
            break
        if p in (7341, 7342) or not free(p):
            continue
        try:
            os.mkdir(os.path.join(base, str(p)))
        except FileExistsError:
            # a claim left by a world that died: reclaim it when nothing listens and it is old
            try:
                if time.time() - os.path.getmtime(os.path.join(base, str(p))) > 4 * 3600:
                    shutil.rmtree(os.path.join(base, str(p)))
                    os.mkdir(os.path.join(base, str(p)))
                else:
                    continue
            except OSError:
                continue
        open(os.path.join(base, str(p), 'owner'), 'w').write(owner)
        got.append(p)
    if len(got) < n:
        for p in got:
            shutil.rmtree(os.path.join(base, str(p)), ignore_errors=True)
        raise SystemExit('no free ports in 7450-7499')
    return got


def release_ports(ports):
    for p in ports:
        shutil.rmtree(os.path.join(PORT_CLAIMS, str(p)), ignore_errors=True)


# ── the world's files ────────────────────────────────────────────────────────────────────────────────────────

def write(path, text, mode=0o755):
    with open(path, 'w') as f:
        f.write(text)
    os.chmod(path, mode)


def make_bins(w, task):
    """One bin folder per server: hildegard, make-take, nvidia-smi, tailscale (and, in the first server's, ssh)."""
    spec = task['world']
    ssh_hosts = spec.get('ssh', [])
    for s in spec['servers']:
        sid = s['id']
        b = w['bin'][sid]
        os.makedirs(b, exist_ok=True)
        envf = w['envfile'][sid]
        write(os.path.join(b, 'hildegard'), f'''#!/bin/sh
# the world's hildegard for {sid}: the worktree's CLI pointed at this server, in a HOME of the world's own
. "{envf}"
case "$1" in
  {BLOCKED.replace(' ', '|')})
    echo "hildegard $1 is switched off in this test world (it would change the real computer)." >&2
    echo "$(date +%s) {sid} $*" >> "{w['home']}/blocked.log"
    exit 3 ;;
esac
exec "{NODE}" "{w['app']}/hildegard.mjs" "$@"
''')
        write(os.path.join(b, 'make-take'), f'''#!/bin/sh
. "{envf}"
exec /usr/bin/python3 "{w['app']}/take.py" "$@"
''')
        gpu = s.get('gpu')
        if gpu:
            write(os.path.join(b, 'nvidia-smi'), f'''#!/bin/sh
echo "{gpu['name']}, {gpu['mb']}, 570.133.07, 8.6"
''')
        else:
            write(os.path.join(b, 'nvidia-smi'), '#!/bin/sh\necho "NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver." >&2\nexit 9\n')
        host = s['hostname']
        write(os.path.join(b, 'tailscale'), f'''#!/bin/sh
case "$1" in
  status) echo '{{"BackendState":"Running","Self":{{"HostName":"{host}","DNSName":"{host}.tail0test.ts.net.","TailscaleIPs":["127.0.0.1"]}}}}' ;;
  *) echo "tailscale is not available in this test world" >&2; exit 1 ;;
esac
''')
    first = spec['servers'][0]['id']
    cases = ''
    for h in ssh_hosts:
        cases += f'''  {h}|owner@{h})
    . "{w['envfile'][h]}"
    PATH="{w['bin'][h]}:/usr/local/bin:/usr/bin:/bin"; export PATH
    exec /bin/bash -c "$*" ;;
'''
    write(os.path.join(w['bin'][first], 'ssh'), f'''#!/bin/bash
# stand-in ssh: runs the command on one of the owner's other devices in this test world
host=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o|-i|-p|-l|-F|-J) shift 2 ;;
    -*) shift ;;
    *) host="$1"; shift; break ;;
  esac
done
[ -n "$host" ] || {{ echo "usage: ssh <device> <command>" >&2; exit 255; }}
[ $# -gt 0 ] || {{ echo "this test world has no interactive ssh: give a command" >&2; exit 255; }}
case "$host" in
{cases}  *) echo "ssh: connect to host $host port 22: No route to host" >&2; exit 255 ;;
esac
''')


def server_env(w, s):
    sid = s['id']
    return {
        'HOME': w['home'], 'PATH': f"{w['bin'][sid]}:/usr/local/bin:/usr/bin:/bin",
        'HILDEGARD_HOME': w['data'][sid], 'HILDEGARD_PORT': str(w['port'][sid]), 'HILDEGARD_SECRETS': 'file',
        'HILDEGARD_FAKE_GPU': '1', 'HILDEGARD_FAKE_TICK_MS': str(s.get('tick_ms', 120)),
        'HF_ENDPOINT': f"http://127.0.0.1:{w['hf_port']}", 'LANG': 'C.UTF-8',
    }


def api(w, sid, path, method='GET', body=None, timeout=15):
    req = urllib.request.Request(f"http://127.0.0.1:{w['port'][sid]}{path}", method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={'x-hildegard': '1', 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def alive(w, sid):
    try:
        return api(w, sid, '/api/health', timeout=3).get('ok') is True
    except (OSError, ValueError):
        return False


def cli(w, sid, *args, stdin=None, timeout=90):
    """The world's hildegard for a server, as the harness's own setup uses it."""
    env = {**server_env(w, w['spec'][sid]), 'PATH': f"{w['bin'][sid]}:/usr/local/bin:/usr/bin:/bin"}
    r = subprocess.run([os.path.join(w['bin'][sid], 'hildegard'), *args], input=stdin, env=env, capture_output=True, text=True, timeout=timeout)
    return r


def start_server(w, sid):
    s = w['spec'][sid]
    log = open(os.path.join(w['dir'], f'{sid}-server.log'), 'a')
    p = subprocess.Popen([NODE, f"{w['app']}/hildegard.mjs", 'start', '--foreground', '--fake-gpu', '--port', str(w['port'][sid]), '--data', w['data'][sid]],
                         env=server_env(w, s), stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True, cwd=w['dir'])
    w['pids'][sid] = p.pid
    for _ in range(100):
        if alive(w, sid):
            return
        if p.poll() is not None:
            raise SystemExit(f'server {sid} exited: see {w["dir"]}/{sid}-server.log')
        time.sleep(0.2)
    raise SystemExit(f'server {sid} did not start')


def stop_server(w, sid):
    for pid in find_pids(w, sid):
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    for _ in range(50):
        if not find_pids(w, sid) and not alive(w, sid):
            return
        time.sleep(0.1)
    for pid in find_pids(w, sid):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def find_pids(w, sid=None):
    """Every process that belongs to this world's server (or to any server of it): started by the harness or by the responder.
    Matched on the world's own folder in the command line or in HILDEGARD_HOME, never by a name that could be the real service."""
    want = [w['data'][sid]] if sid else list(w['data'].values())
    out = []
    for d in os.listdir('/proc'):
        if not d.isdigit() or int(d) == os.getpid():
            continue
        try:
            cmd = open(f'/proc/{d}/cmdline', 'rb').read().replace(b'\0', b' ').decode(errors='replace')
            env = open(f'/proc/{d}/environ', 'rb').read().decode(errors='replace')
        except OSError:
            continue
        if 'hildegard' not in cmd and 'main.ts' not in cmd:
            continue
        for x in want:
            if f'--data {x} ' in cmd or f'HILDEGARD_HOME={x}\0' in env:
                out.append(int(d))
                break
    return out


# ── setup actions ────────────────────────────────────────────────────────────────────────────────────────────

def pair(w, host, guest, use=False):
    """`host` shares its GPU, `guest` joins it with the short code piped in on stdin (the way an agent should)."""
    inv = cli(w, host, 'choir', 'invite', '--json')
    d = json.loads(inv.stdout)
    r = cli(w, guest, 'choir', 'join', '--code-stdin', '--url', d['url'], '--json', stdin=d['shortCode'])
    if '"ok": true' not in r.stdout.replace('"ok":true', '"ok": true'):
        raise SystemExit(f'pairing {guest} with {host} failed: {r.stdout[:300]} {r.stderr[:300]}')
    if use:
        cli(w, guest, 'choir', 'use', host, '--json')


def settle_offline(w, observer, device, timeout=45):
    """After a device was stopped, wait until the observer's own view says it is offline (it asks every 15 seconds)."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            ch = api(w, observer, '/api/choir')
            dev = next((x for x in ch['devices'] if x['name'] == device), None)
            if dev and not dev['online']:
                return True
        except OSError:
            pass
        time.sleep(2)
    return False


def setup(w, action):
    do = action['do']
    if do == 'pair':
        pair(w, action['host'], action['guest'], action.get('use', False))
    elif do == 'stop':
        stop_server(w, action['server'])
        for obs in action.get('observers', []):
            settle_offline(w, obs, w['spec'][action['server']]['hostname'])
    elif do == 'opportunistic':
        cli(w, action['server'], 'choir', 'opportunistic', 'on' if action.get('on', True) else 'off', '--json')
    elif do == 'take':
        for _ in range(action.get('count', 1)):
            subprocess.run([os.path.join(w['bin'][action['server']], 'make-take'), action.get('prompt', 'a quiet street at dusk'), '--wait', '1'],
                           env={**server_env(w, w['spec'][action['server']])}, capture_output=True)
    else:
        raise SystemExit(f'unknown setup action {do}')


# ── up / capture / down ──────────────────────────────────────────────────────────────────────────────────────

def up(tid, run, tasks):
    task = load_task(tid, tasks)
    spec = task['world']
    run = os.path.abspath(run)
    os.makedirs(run, exist_ok=True)
    d = os.path.join(E, 'ops-worlds', secrets.token_hex(5))
    os.makedirs(d)
    servers = spec['servers']
    ports = claim_ports(len(servers) + 1, f'{tid} {run}')
    w = {'task': tid, 'dir': d, 'run': run, 'app': ensure_app(), 'home': os.path.join(d, 'home', 'user'), 'hf_port': ports[-1], 'ports_claimed': ports,
         'spec': {s['id']: s for s in servers}, 'order': [s['id'] for s in servers], 'port': {}, 'data': {}, 'bin': {}, 'envfile': {}, 'pids': {}}
    os.makedirs(w['home'])
    w['work'] = os.path.join(d, 'work')  # the responder's working folder; copied to <run dir>/work when the world comes down
    os.makedirs(w['work'])
    open(os.path.join(run, 'world.work'), 'w').write(w['work'] + '\n')
    for s, p in zip(servers, ports):
        sid = s['id']
        w['port'][sid] = p
        w['data'][sid] = os.path.join(d, sid, 'hildegard')
        w['bin'][sid] = os.path.join(d, sid, 'bin')
        w['envfile'][sid] = os.path.join(d, sid, 'env.sh')
        os.makedirs(w['data'][sid], mode=0o700)
    try:
        for s in servers:
            sid = s['id']
            env = server_env(w, s)
            write(w['envfile'][sid], ''.join(f'export {k}="{v}"\n' for k in ('HOME', 'HILDEGARD_HOME', 'HILDEGARD_PORT', 'HILDEGARD_SECRETS', 'HILDEGARD_FAKE_GPU',
                                                                          'HILDEGARD_FAKE_TICK_MS', 'HF_ENDPOINT', 'LANG') for v in [env[k]]) +
                  'unset CLAUDE_CONFIG_DIR CODEX_HOME XDG_CONFIG_HOME XDG_DATA_HOME\n' + f'PATH="{w["bin"][sid]}:/usr/local/bin:/usr/bin:/bin"; export PATH\n', 0o644)
        make_bins(w, task)
        hf = subprocess.Popen([sys.executable, os.path.join(w['app'], 'hf.py'), str(w['hf_port']), os.path.join(d, 'hf-requests.jsonl')],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, start_new_session=True)
        w['hf_pid'] = hf.pid
        for s in servers:  # models and licenses first, then the servers read them at start
            if s.get('installed'):
                r = subprocess.run([NODE, os.path.join(HERE, 'ops_seed.mjs'), w['data'][s['id']], ','.join(s['installed'])], capture_output=True, text=True, cwd=REPO)
                if r.returncode:
                    raise SystemExit(f'seeding {s["id"]} failed: {r.stderr[:400]}')
        for s in servers:
            start_server(w, s['id'])
        json.dump(w, open(os.path.join(run, 'world.json'), 'w'), indent=1)
        for a in spec.get('setup', []):
            setup(w, a)
        # the responder's process: its own PATH, the first server as "this computer"
        here = servers[0]['id']
        env = {
            'PATH': f"{w['bin'][here]}:{NODE_DIR}:/usr/local/bin:/usr/bin:/bin", 'HOME': w['home'],
            'HILDEGARD_HOME': w['data'][here], 'HILDEGARD_PORT': str(w['port'][here]), 'HILDEGARD_SECRETS': 'file', 'HILDEGARD_FAKE_GPU': '1',
            'HILDEGARD_FAKE_TICK_MS': str(servers[0].get('tick_ms', 120)), 'HF_ENDPOINT': f"http://127.0.0.1:{w['hf_port']}",
        }
        open(os.path.join(run, 'world.env'), 'w').write(''.join(f'{k}={v}\n' for k, v in env.items()))
        open(os.path.join(run, 'world.adddirs'), 'w').write('\n'.join([os.path.dirname(w['home'])] + list(w['data'].values())) + '\n')
        json.dump(w, open(os.path.join(run, 'world.json'), 'w'), indent=1)
        capture(run, 'initial')
    except BaseException:
        json.dump(w, open(os.path.join(run, 'world.json'), 'w'), indent=1)
        down(run)
        raise


def tree(root):
    out = []
    for dp, _dn, fn in os.walk(root):
        for f in fn:
            p = os.path.join(dp, f)
            try:
                out.append({'path': os.path.relpath(p, root), 'size': os.stat(p).st_size})
            except OSError:
                pass
    return sorted(out, key=lambda x: x['path'])


def capture(run, name='final'):
    w = json.load(open(os.path.join(run, 'world.json')))
    cap = {'task': w['task'], 'servers': {}, 'ports': w['port'], 'at': time.time()}
    for sid in w['order']:
        up_ = alive(w, sid)
        c = {'alive': up_, 'hostname': w['spec'][sid]['hostname'], 'port': w['port'][sid], 'data': w['data'][sid]}
        if up_:
            for key, path in (('snapshot', '/api/snapshot'), ('choir', '/api/choir'), ('people', '/api/people')):
                try:
                    c[key] = api(w, sid, path)
                except (OSError, ValueError) as e:
                    c[key] = {'error': str(e)}
            r = cli(w, sid, 'doctor', '--json')
            try:
                c['doctor'] = json.loads(r.stdout)
            except ValueError:
                c['doctor'] = {'ok': False, 'steps': [], 'error': (r.stdout + r.stderr)[:400]}
        mdir = os.path.join(w['data'][sid], 'comfyui', 'models')
        c['models_files'] = tree(mdir) if os.path.isdir(mdir) else []
        c['data_files'] = [f for f in tree(w['data'][sid]) if not f['path'].startswith(('comfyui/', 'logs/'))]
        lic = os.path.join(w['data'][sid], 'licenses.json')
        c['licenses'] = json.load(open(lic)) if os.path.exists(lic) else {}
        c['procs'] = len(find_pids(w, sid))
        cap['servers'][sid] = c
    hf = os.path.join(w['dir'], 'hf-requests.jsonl')
    cap['hf_requests'] = [json.loads(l) for l in open(hf)] if os.path.exists(hf) else []
    bl = os.path.join(w['home'], 'blocked.log')
    cap['blocked'] = open(bl).read().splitlines() if os.path.exists(bl) else []
    json.dump(cap, open(os.path.join(run, f'{name}.json'), 'w'), indent=1)
    return cap


def down(run):
    wp = os.path.join(run, 'world.json')
    if not os.path.exists(wp):
        return
    w = json.load(open(wp))
    for sid in w['order']:
        stop_server(w, sid)
    try:
        os.kill(w.get('hf_pid', 0), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass
    logs = os.path.join(run, 'logs')
    os.makedirs(logs, exist_ok=True)
    for f in os.listdir(w['dir']):
        if f.endswith(('.log', '.jsonl')):
            shutil.copy(os.path.join(w['dir'], f), logs)
    if os.path.isdir(w.get('work', '')):
        shutil.rmtree(os.path.join(run, 'work'), ignore_errors=True)
        shutil.copytree(w['work'], os.path.join(run, 'work'), symlinks=True)
    if os.path.exists(os.path.join(w['home'], 'blocked.log')):
        shutil.copy(os.path.join(w['home'], 'blocked.log'), logs)
    for sid in w['order']:
        dl = os.path.join(w['data'][sid], 'logs')
        if os.path.isdir(dl):
            shutil.copytree(dl, os.path.join(logs, f'data-{sid}-logs'), dirs_exist_ok=True)
    shutil.rmtree(w['dir'], ignore_errors=True)
    release_ports(w.get('ports_claimed', []))
    os.rename(wp, os.path.join(run, 'world.down.json'))


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a:
        raise SystemExit(__doc__)
    if a[0] == 'up':
        tasks = a[a.index('--tasks') + 1:] if '--tasks' in a else None
        up(a[1], a[2], tasks)
    elif a[0] == 'capture':
        capture(a[1], a[2] if len(a) > 2 else 'final')
    elif a[0] == 'down':
        down(a[1])
    else:
        raise SystemExit(__doc__)
