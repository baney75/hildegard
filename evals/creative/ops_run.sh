#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# ops_run.sh <run dir> <seconds> <command...>: respond.sh runs the responder through this (inside its user and PID namespace).
# It runs the command under a time limit, then captures the world's end state from the same namespace, so a server the responder
# started (a restart of Hildegard, say) is still alive to be read. Leaving the namespace kills whatever is left.
RUN=$1; TMO=$2; shift 2
timeout "$TMO" "$@"
rc=$?
python3 "$(dirname "$0")/ops_world.py" capture "$RUN" final </dev/null >"$RUN/capture.log" 2>&1
exit $rc
