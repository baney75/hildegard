# SPDX-License-Identifier: AGPL-3.0-only
"""Run a responder's script without trusting it: sandbox.wrap(cmd, rw_dir) returns the argv to run instead of cmd.

bubblewrap when it works: the whole filesystem read-only, a tmpfs over the owner's home, /tmp and /run (so no ~/.ssh, no agent
or D-Bus sockets), only rw_dir writable, no network, a new PID, IPC and UTS namespace, no capabilities, no new privileges, killed
with its parent. Without bubblewrap it falls back to `unshare -rn` plus `setpriv --no-new-privs`, which only removes the network and
new privileges, and says so on stderr. With neither it refuses; set EVAL_SANDBOX=none to run bare anyway (a deliberate choice).
EVAL_SANDBOX=bwrap|fallback forces a mode."""
import os, shutil, subprocess, sys

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


def wrap(cmd, rw_dir):
    m = mode()
    if m == 'none':
        return list(cmd)
    if m == 'fallback':
        return ['unshare', '-rn', 'setpriv', '--no-new-privs'] + list(cmd)
    rw = os.path.realpath(rw_dir)
    home = os.path.realpath(os.path.expanduser('~'))
    return (['bwrap', '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
             '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
             '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', home,
             '--bind', rw, rw, '--chdir', rw, '--'] + list(cmd))
