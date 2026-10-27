#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Installs Hildegard @VERSION@ for you alone: no sudo, nothing outside your home folder.
#
#   curl -fsSL https://github.com/baney75/hildegard/releases/download/v@VERSION@/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --json         for agents: the last step prints JSON
#
# What it does, in order:
#   1. Downloads Node.js @NODE@ from nodejs.org and Hildegard @VERSION@ from GitHub, and checks each against the
#      SHA-256 written into this script. A file that doesn't match is refused and nothing is installed.
#   2. Puts them in ~/.local/share/hildegard (on macOS, ~/Library/Application Support/Hildegard), and a `hildegard`
#      command in ~/.local/bin.
#   3. Runs `hildegard install --yes`, which sets up ComfyUI and PyTorch for your GPU, then starts Hildegard.
#
# Set HILDEGARD_HOME to install somewhere else, or HILDEGARD_SKIP_SETUP=1 to stop after step 2.
set -eu
# ASCII only below: macOS's /bin/sh (bash 3.2) reads a UTF-8 byte after $NAME as part of the name.

VERSION=@VERSION@
NODE=@NODE@
RELEASE=${HILDEGARD_RELEASE_URL:-https://github.com/baney75/hildegard/releases/download/v$VERSION}
# Where Node.js comes from. Each file is still checked against the SHA-256 written below, wherever it comes from.
NODE_DIST=${HILDEGARD_NODE_URL:-https://nodejs.org/dist}

say() { printf '%s\n' "$*" >&2; }
# When an older Hildegard runs this to update itself, its own paths are in the environment. They name the version being
# replaced, and the new one must find its files where it is, so drop them; the hildegard command sets what it needs.
unset HILDEGARD_ENTRY HILDEGARD_RESOURCES HILDEGARD_PRESETS_DIR HILDEGARD_COMMIT
die() {
  say "hildegard: $*"
  exit 1
}

case "$(uname -s)" in
Linux) os=linux ;;
Darwin) os=darwin ;;
*) die "this installer is for Linux and macOS. On Windows, use install.ps1." ;;
esac
case "$(uname -m)" in
x86_64 | amd64) arch=x64 ;;
arm64 | aarch64) arch=arm64 ;;
*) die "there's no Hildegard build for $(uname -m) yet." ;;
esac
target=$os-$arch

app_sha() {
  case $1 in
  linux-x64) echo @APP_SHA_linux_x64@ ;;
  linux-arm64) echo @APP_SHA_linux_arm64@ ;;
  darwin-x64) echo @APP_SHA_darwin_x64@ ;;
  darwin-arm64) echo @APP_SHA_darwin_arm64@ ;;
  esac
}
node_sha() {
  case $1 in
  linux-x64) echo @NODE_SHA_linux_x64@ ;;
  linux-arm64) echo @NODE_SHA_linux_arm64@ ;;
  darwin-x64) echo @NODE_SHA_darwin_x64@ ;;
  darwin-arm64) echo @NODE_SHA_darwin_arm64@ ;;
  esac
}

if [ -n "${HILDEGARD_HOME:-}" ]; then
  home=$HILDEGARD_HOME
elif [ "$os" = darwin ]; then
  home="$HOME/Library/Application Support/Hildegard"
else
  home="${XDG_DATA_HOME:-$HOME/.local/share}/hildegard"
fi
bin="${XDG_BIN_HOME:-$HOME/.local/bin}"

# ComfyUI, PyTorch for the GPU and Python take about 8 GB, and the first model about 20 GB more. Say so before
# downloading anything, rather than failing halfway with a full disk.
need_gb=12
[ "${HILDEGARD_SKIP_SETUP:-}" = 1 ] && need_gb=1
probe=$home
while [ ! -d "$probe" ]; do probe=$(dirname "$probe"); done
free_gb=$(df -Pk "$probe" | awk 'NR==2 {print int($4 / 1048576)}')
if [ -n "$free_gb" ] && [ "$free_gb" -lt "$need_gb" ]; then
  say "Hildegard needs at least $need_gb GB free to install, plus about 20 GB for its first model, and $probe has $free_gb GB."
  say "To install somewhere with more room, run:"
  say ""
  say "  curl -fsSL $RELEASE/install.sh | HILDEGARD_HOME=/path/with/room/hildegard sh"
  say ""
  die "nothing was installed."
fi

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "needs curl or wget."
  fi
}
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}
checked() { # url file sha
  fetch "$1" "$2" || die "couldn't download $1."
  got=$(sha256 "$2")
  [ "$got" = "$3" ] || die "$(basename "$2") didn't match its checksum (expected $3, got $got). Nothing was installed."
}

# Until setup finishes, the version this replaces is kept: its app folder, and its Node.js in node.prev. If anything
# fails, restore() puts it back, so a failed update leaves the old Hildegard as it was.
prev=$(readlink "$home/app" 2>/dev/null || true)
[ "$prev" = "app-$VERSION" ] && prev=
switched=
committed=
restore() {
  [ -n "$committed" ] && return 0
  committed=1
  if [ -n "$switched" ] && [ -n "$prev" ] && [ -d "$home/$prev" ]; then
    # Whatever started from the new version stops before the link moves back under it.
    "$bin/hildegard" stop </dev/null >/dev/null 2>&1 || true
    ln -sfn "$prev" "$home/app"
  fi
  if [ -d "$home/node.prev" ]; then
    rm -rf "$home/node"
    mv "$home/node.prev" "$home/node"
  fi
}

tmp=$(mktemp -d)
rc=0
# Keep the exit status: an EXIT trap's own status would otherwise hide a failure.
trap 'rc=$?; rm -rf "$tmp"; [ "$rc" = 0 ] || restore; exit $rc' EXIT
trap 'exit 130' INT TERM
mkdir -p "$home" "$bin"

# Node.js, Hildegard's own copy, so it never depends on (or changes) one you have.
if [ "$("$home/node/bin/node" --version 2>/dev/null || true)" != "v$NODE" ]; then
  say "Getting Node.js ${NODE}..."
  f=node-v$NODE-$target.tar.gz
  checked "$NODE_DIST/v$NODE/$f" "$tmp/$f" "$(node_sha "$target")"
  rm -rf "$home/node.new" "$home/node.prev"
  mkdir -p "$home/node.new"
  tar -xmzf "$tmp/$f" -C "$home/node.new" --strip-components 1
  [ -d "$home/node" ] && mv "$home/node" "$home/node.prev"
  mv "$home/node.new" "$home/node"
fi

say "Getting Hildegard ${VERSION}..."
f=hildegard-$VERSION-$target.tar.gz
checked "$RELEASE/$f" "$tmp/$f" "$(app_sha "$target")"
rm -rf "$home/app-$VERSION.new"
mkdir -p "$home/app-$VERSION.new"
tar -xmzf "$tmp/$f" -C "$home/app-$VERSION.new" --strip-components 1
rm -rf "$home/app-$VERSION"
mv "$home/app-$VERSION.new" "$home/app-$VERSION"
# Keep this version and the one before it, for going back.
for old in "$home"/app-*; do
  [ -d "$old" ] || continue
  case $(basename "$old") in
  "app-$VERSION" | "$prev") ;;
  *) rm -rf "$old" ;;
  esac
done
switched=1
ln -sfn "app-$VERSION" "$home/app"

cat >"$bin/hildegard" <<EOF
#!/bin/sh
export HILDEGARD_HOME="$home"
# AI apps get this path, which survives upgrades (app is a link to the current version).
export HILDEGARD_ENTRY="$home/app/hildegard.mjs"
exec "$home/node/bin/node" "$home/app/hildegard.mjs" "\$@"
EOF
chmod 755 "$bin/hildegard"
say "Installed the hildegard command in $bin."
case ":$PATH:" in
*":$bin:"*) ;;
*) say "Add $bin to your PATH to run it by name, or run $bin/hildegard." ;;
esac

finish() {
  committed=1
  rm -rf "$home/node.prev"
  exit 0
}
[ "${HILDEGARD_SKIP_SETUP:-}" = 1 ] && finish
# Setup never prompts (--yes), and under `curl | sh` its stdin would be the rest of this script.
"$bin/hildegard" install --yes "$@" </dev/null && finish
status=$?
# An update that won't set up goes back to the version it replaced, and starts that one again.
if [ -n "$prev" ] && [ -d "$home/$prev" ]; then
  say "Going back to Hildegard ${prev#app-}. Hildegard $VERSION stays in $home/app-$VERSION."
  restore
  if "$bin/hildegard" start </dev/null >/dev/null 2>&1; then
    say "Hildegard ${prev#app-} is running again."
  else
    say "Hildegard ${prev#app-} didn't start either. Run: hildegard doctor"
  fi
  # The last line is the one an updating Hildegard shows: what failed, and what runs now.
  say "hildegard: setting up $VERSION failed (exit $status), so ${prev#app-} runs again. To try $VERSION again: hildegard install"
else
  say "hildegard: setting up $VERSION failed (exit $status). Run it again with: hildegard install"
fi
exit $status
