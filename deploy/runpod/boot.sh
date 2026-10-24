#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Hildegard on a Runpod pod, as one more GPU in its owner's fleet.
#
# `hildegard cloud runpod up` starts a pod from a plain Ubuntu image and hands it this script in the environment
# (HILDEGARD_BOOT, base64), run with: bash -c 'echo "$HILDEGARD_BOOT" | base64 -d > /hildegard-boot.sh && exec bash /hildegard-boot.sh'
# Nothing is fetched to run it except Hildegard's own signed release, which install.sh checks by SHA-256.
#
# It installs Hildegard on the pod's volume (so a stopped pod starts again in a minute), installs the model the owner
# accepted the license of, and shares the GPU with the key the owner's computer made, so that computer can join
# without anything being sent back. Then it watches: when nothing has rendered for HILDEGARD_IDLE_MINUTES, it stops
# the pod so it stops costing money.
#
# Outside the pod, Hildegard is reachable only through Runpod's HTTPS proxy, where everything except the paired-device
# API (/api/node/*, behind the key) needs a sign-in, and no account exists to sign in with.
#
# Environment: HILDEGARD_VERSION, HILDEGARD_JOIN_KEY (secret), RUNPOD_POD_ID (set by Runpod), and optionally
# HILDEGARD_MODEL, HILDEGARD_ACCEPT_LICENSE (equal to HILDEGARD_MODEL only when the owner accepted it), HF_TOKEN
# (only when the owner chose to send it), HILDEGARD_IDLE_MINUTES (default 30; 0 never stops), RUNPOD_API_KEY (the
# pod's own key, set by Runpod, used only to stop this pod).

set -euo pipefail

: "${HILDEGARD_VERSION:?}" "${HILDEGARD_JOIN_KEY:?}" "${RUNPOD_POD_ID:?}"
PORT=7341
PUBLIC_HOST="${RUNPOD_POD_ID}-${PORT}.proxy.runpod.net"
IDLE_MINUTES="${HILDEGARD_IDLE_MINUTES:-30}"
LOG=/workspace/hildegard-boot.log

export HOME=/workspace/hildegard-home
export PATH="$HOME/.local/bin:$PATH"
export HILDEGARD_HOST=0.0.0.0
export HILDEGARD_ALLOWED_HOSTS="$PUBLIC_HOST"
export HILDEGARD_SECRETS=file
mkdir -p "$HOME"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }
log "Starting Hildegard $HILDEGARD_VERSION on pod $RUNPOD_POD_ID"

if ! command -v curl > /dev/null; then
  log "Installing curl"
  apt-get update -qq > /dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends curl ca-certificates > /dev/null
fi

installed=""
if command -v hildegard > /dev/null; then installed="$(hildegard --version 2> /dev/null || true)"; fi
if [ "$installed" != "$HILDEGARD_VERSION" ]; then
  log "Installing Hildegard $HILDEGARD_VERSION (first start takes a while: ComfyUI and PyTorch)"
  curl -fsSL --retry 3 "https://github.com/baney75/hildegard/releases/download/v${HILDEGARD_VERSION}/install.sh" \
    | sh -s -- --json >> "$LOG" 2>&1
fi
hildegard start --json >> "$LOG" 2>&1 || true

if [ -n "${HILDEGARD_MODEL:-}" ]; then
  if [ "${HILDEGARD_ACCEPT_LICENSE:-}" = "$HILDEGARD_MODEL" ]; then
    log "Installing $HILDEGARD_MODEL (license accepted by the owner)"
    hildegard models install "$HILDEGARD_MODEL" --accept-license "$HILDEGARD_MODEL" --json >> "$LOG" 2>&1 || true
  else
    log "Not installing $HILDEGARD_MODEL: its license wasn't accepted"
  fi
fi

# The join code holds the key: never let it reach the log.
if printf %s "$HILDEGARD_JOIN_KEY" | hildegard choir invite --url "https://$PUBLIC_HOST" --key-stdin --json > /dev/null 2>&1; then
  log "Sharing this GPU at https://$PUBLIC_HOST"
else
  log "Couldn't turn on sharing; the owner's computer will keep trying to join"
fi

stop_pod() {
  log "Idle for $IDLE_MINUTES minutes: stopping the pod"
  if [ -n "${RUNPOD_API_KEY:-}" ]; then
    printf 'Authorization: Bearer %s' "$RUNPOD_API_KEY" \
      | curl -fsS -X POST -H @- "https://rest.runpod.io/v1/pods/$RUNPOD_POD_ID/stop" >> "$LOG" 2>&1 && return 0
  fi
  if command -v runpodctl > /dev/null; then runpodctl stop pod "$RUNPOD_POD_ID" >> "$LOG" 2>&1 && return 0; fi
  log "Couldn't stop the pod; stop it with \`hildegard cloud runpod down\`"
}

idle=0
while true; do
  sleep 60
  if ! curl -fs "http://127.0.0.1:$PORT/api/health" > /dev/null; then
    log "Hildegard wasn't answering; starting it again"
    hildegard start --json >> "$LOG" 2>&1 || true
    idle=0
    continue
  fi
  # Keys go to curl on stdin, never on its command line where other processes could read them.
  info="$(printf 'Authorization: Bearer %s' "$HILDEGARD_JOIN_KEY" | curl -fs -H @- "http://127.0.0.1:$PORT/api/node/info" || true)"
  queue="$(printf %s "$info" | grep -o '"queue":[0-9]*' | cut -d: -f2 || true)"
  # Busy while rendering, and while there is no model yet (it may be downloading).
  if [ -z "$queue" ] || [ "$queue" != "0" ] || printf %s "$info" | grep -q '"models":\[\]'; then
    idle=0
  else
    idle=$((idle + 1))
  fi
  if [ "$IDLE_MINUTES" -gt 0 ] && [ "$idle" -ge "$IDLE_MINUTES" ]; then
    stop_pod
    idle=0
  fi
done
