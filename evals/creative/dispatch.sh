#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# dispatch.sh <jobs>: reads "arm model task" lines on stdin and runs respond.sh (or $RESPOND) for each, <jobs> at a time.
# A response that exits 99 (a quota or billing message) makes this exit 255 for that job, which is what stops xargs from
# starting any later one. Other failures are left for the run to report.
HERE=$(cd "$(dirname "$0")" && pwd)
export RESPOND=${RESPOND:-$HERE/respond.sh}
xargs -P "${1:-4}" -L 1 sh -c '"$RESPOND" "$0" "$1" "$2"; c=$?; if [ $c -eq 99 ]; then echo STOP >&2; exit 255; fi; [ $c -eq 0 ] || echo "respond failed ($c): $0 $1 $2" >&2; exit 0'
