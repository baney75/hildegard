# SPDX-License-Identifier: AGPL-3.0-only
"""Run a responder's script without trusting it: sandbox.wrap(cmd, rw_dir) returns the argv to run instead of cmd.

bubblewrap when it works: the whole filesystem read-only, a tmpfs over the owner's home, /tmp and /run (so no ~/.ssh, no agent
or D-Bus sockets), only rw_dir writable, no network, a new PID, IPC and UTS namespace, no capabilities, no new privileges, killed
with its parent. Without bubblewrap it falls back to `unshare -rn` plus `setpriv --no-new-privs`, which only removes the network and
new privileges, and says so on stderr. With neither it refuses; set EVAL_SANDBOX=none to run bare anyway (a deliberate choice).
EVAL_SANDBOX=bwrap|fallback forces a mode.

wrap(cmd, rw_dir, hide=[dirs]) also puts a tmpfs over each dir, wherever it is (outside $HOME too), so a script cannot read them. Only
bubblewrap can do that: in any other mode wrap() refuses, because the script could read the dirs by their path.

sandbox.responder(run, eval_dir) is the same idea for a model's whole session (Haiku through `claude -p`), which needs the network:
bubblewrap only, never a fallback and never EVAL_SANDBOX=none. See responder() for what it can see and write.
`python3 sandbox.py responder <run> <eval dir>` prints that argv, NUL-separated, for respond.sh."""
import glob, os, pwd, shutil, subprocess, sys

_mode = None


def _works(argv):
    try:
        return subprocess.run(argv, capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def mode():
    global _mode
    if _mode:
        return _mode
    want = os.environ.get('EVAL_SANDBOX', 'auto')
    if want == 'none':
        _mode = 'none'
    elif want != 'fallback' and shutil.which('bwrap') and _works(['bwrap', '--unshare-all', '--ro-bind', '/', '/', 'true']):
        _mode = 'bwrap'
    elif shutil.which('unshare') and shutil.which('setpriv') and _works(['unshare', '-rn', 'setpriv', '--no-new-privs', 'true']):
        _mode = 'fallback'
        print('WARNING: bubblewrap is not usable here; scripts run with no network and no new privileges, but they can still read and '
              'write anything the owner can. Install bubblewrap (bwrap) for filesystem isolation.', file=sys.stderr)
    else:
        raise SystemExit('no sandbox: install bubblewrap (bwrap), or unshare and setpriv; EVAL_SANDBOX=none runs scripts unsandboxed')
    return _mode


def wrap(cmd, rw_dir, hide=()):
    # The eval folder (clean references, inputs, every arm's runs) is always hidden, so a new caller can't forget it.
    e = os.environ.get('EVAL_DIR', os.path.expanduser('~/.cache/hildegard-creative-eval'))
    hide = list(hide) + ([e] if e not in hide and os.path.exists(e) else [])
    m = mode()
    if hide and m != 'bwrap':
        raise SystemExit(f'cannot hide {", ".join(hide)} from the script without bubblewrap (mode: {m}); install bwrap')
    if m == 'none':
        return list(cmd)
    if m == 'fallback':
        return ['unshare', '-rn', 'setpriv', '--no-new-privs'] + list(cmd)
    rw = os.path.realpath(rw_dir)
    home = os.path.realpath(os.path.expanduser('~'))
    return (['bwrap', '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
             '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
             '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', home] +
            [a for h in hide if os.path.exists(h) for a in ('--tmpfs', os.path.realpath(h))] +
            ['--bind', rw, rw, '--chdir', rw, '--'] + list(cmd))


def _bwrap_ok():
    return bool(shutil.which('bwrap')) and _works(['bwrap', '--unshare-user', '--unshare-pid', '--ro-bind', '/', '/', 'true'])


def _elf(p):
    try:
        with open(p, 'rb') as f:
            return f.read(4) == b'\x7fELF'
    except OSError:
        return False


def _homes():
    return {os.path.realpath(os.path.expanduser('~')), os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir)}


def _under(p, root):
    return p == root or p.startswith(root.rstrip(os.sep) + os.sep)


def claude_bin():
    """The claude binary the session runs: $HILDEGARD_EVAL_CLAUDE as given, else `claude` on PATH when that is the native binary,
    else mise's (a launcher script that calls `mise use -g` writes outside the box and cannot run in it). Only this one file is bound
    into the box, so the override must name a file, and one in a folder of its own: a folder, or a file directly in the home folder,
    is refused."""
    o = os.environ.get('HILDEGARD_EVAL_CLAUDE')
    if o:
        p = os.path.realpath(o)
        if not os.path.isfile(p):
            raise SystemExit(f'HILDEGARD_EVAL_CLAUDE must name the claude binary itself, and {o} is not a file; refusing to run.')
        if os.path.dirname(p) in _homes():
            raise SystemExit(f'HILDEGARD_EVAL_CLAUDE resolves to {p}, directly in your home folder; move the binary into a folder of its '
                             'own and point HILDEGARD_EVAL_CLAUDE there. Refusing to run.')
        return p
    w = shutil.which('claude')
    if w and _elf(os.path.realpath(w)):
        return os.path.realpath(w)
    if shutil.which('mise'):
        try:
            m = subprocess.run(['mise', 'which', 'claude'], capture_output=True, text=True, timeout=60).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            m = ''
        if m and _elf(os.path.realpath(m)):
            return os.path.realpath(m)
    raise SystemExit(f'no native claude binary found ({w or "none on PATH"} is not one); set HILDEGARD_EVAL_CLAUDE to it')


def chromium_dir(home, ev):
    """The folder of the Chromium the prompt names ($HILDEGARD_EVAL_CHROMIUM, else the newest Playwright one), which the box binds
    read-only, or None when there is none. Chromium needs its whole folder, so the folder must hold nothing else of the owner's: one
    inside the home folder must be a browser's own folder under ~/.cache/ms-playwright, and one that is or holds the home folder, or
    is in or above the eval folder, is refused."""
    pw = os.path.join(home, '.cache', 'ms-playwright')
    o = os.environ.get('HILDEGARD_EVAL_CHROMIUM')
    if o:
        c = os.path.dirname(os.path.realpath(o))
    else:
        g = sorted(glob.glob(os.path.join(pw, 'chromium-*', 'chrome-linux*', 'chrome')))
        if not g:
            return None
        c = os.path.dirname(os.path.realpath(g[-1]))
    if not os.path.isdir(c):
        return None
    homes = _homes() | {home}
    bad = any(_under(h, c) for h in homes) or _under(c, ev) or _under(ev, c)
    if any(_under(c, h) for h in homes) and not (_under(c, os.path.realpath(pw)) and c != os.path.realpath(pw)):
        bad = True
    if bad:
        raise SystemExit(f'Chromium\'s folder {c} holds more than Chromium (it is in or above your home or the eval folder); point '
                         'HILDEGARD_EVAL_CHROMIUM at a Chromium in a folder of its own. Refusing to run.')
    return c


def responder(run, eval_dir):
    """argv that runs a claude session for one run, confined: the whole filesystem read-only; a tmpfs over the owner's home ($HOME and
    the passwd entry's), /tmp, /run (DNS's /run/systemd/resolve is bound back read-only) and the eval folder, so no ~/.ssh, no tokens
    in ~/.config, no agent or D-Bus sockets and no other run; this run's folder bound back read-only and its work/ read-write. Claude's
    state goes to a fresh CLAUDE_CONFIG_DIR on the tmpfs, with the owner's credentials file bound into it read-only, so nothing in the
    box can change or replace it (a refresh would strand the owner's other sessions, so respond.sh stops the batch on a sign-in failure).
    With CLAUDE_CODE_OAUTH_TOKEN set, no credentials file is bound and the token goes in through `--args 7`, a pipe respond.sh opens. The claude binary is bound back as that
    one file, and Chromium's own folder read-only; nothing else under the home folder is. The network stays (the model needs it); the
    environment is cleared to a few variables. New user, PID, IPC and UTS namespaces, no capabilities, killed with its parent. Refuses
    without a working bubblewrap: a session is never run unconfined."""
    if not _bwrap_ok():
        raise SystemExit('bubblewrap (bwrap) is not usable here, so a Haiku session cannot be confined; refusing to run it. Install bubblewrap.')
    home = os.path.realpath(os.path.expanduser('~'))
    run, ev = os.path.realpath(run), os.path.realpath(eval_dir)
    work = os.path.join(run, 'work')
    exe = claude_bin()
    state = '/tmp/hg-claude'
    cfg = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.join(home, '.claude')
    creds = os.path.join(os.path.realpath(cfg), '.credentials.json')
    a = ['bwrap', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
         '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
         '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/run']
    if os.path.isdir('/run/systemd/resolve'):
        a += ['--ro-bind', '/run/systemd/resolve', '/run/systemd/resolve']
    for h in sorted(_homes()):
        a += ['--tmpfs', h]
    a += ['--tmpfs', ev]
    a += ['--ro-bind', exe, exe]
    chrome = chromium_dir(home, ev)
    if chrome:
        a += ['--ro-bind', chrome, chrome]
    a += ['--ro-bind', run, run, '--bind', work, work, '--dir', state]
    tok = bool(os.environ.get('CLAUDE_CODE_OAUTH_TOKEN'))
    if os.path.isfile(creds) and not tok:
        a += ['--ro-bind', creds, os.path.join(state, '.credentials.json')]
    a += ['--clearenv', '--setenv', 'HOME', home, '--setenv', 'USER', os.environ.get('USER', 'eval'), '--setenv', 'TMPDIR', '/tmp',
          '--setenv', 'PATH', os.path.dirname(exe) + ':/usr/local/bin:/usr/bin:/bin', '--setenv', 'LANG', os.environ.get('LANG', 'C.UTF-8'),
          '--setenv', 'CLAUDE_CONFIG_DIR', state, '--setenv', 'DISABLE_AUTOUPDATER', '1']
    a += (['--args', '7'] if tok else []) + ['--chdir', work, '--', exe]
    return a


if __name__ == '__main__':
    if len(sys.argv) != 4 or sys.argv[1] != 'responder':
        raise SystemExit('usage: sandbox.py responder <run folder> <eval folder>')
    sys.stdout.write('\0'.join(responder(sys.argv[2], sys.argv[3])) + '\0')
