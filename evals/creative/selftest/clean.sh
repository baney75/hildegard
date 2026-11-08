#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# A competent reference for the cleaning tasks: notch the hum, denoise, even the levels, tame pops, two-pass loudnorm.
# Usage: clean.sh <lufs> <tp> <hum hz> [rumble]
set -e
LUFS=${1:--16}; TP=${2:--1}; F=${3:-60}
N=""; for k in 1 2 3 4 5; do N="$N,equalizer=f=$((F*k)):t=q:w=40:g=-40"; done
HP="highpass=f=75"; [ -n "$4" ] && HP="highpass=f=110,highpass=f=110"
PRE="$HP$N,afftdn=nr=35:nf=-40:tn=1:om=o,afftdn=nr=25:nf=-45:tn=1,adeclip,alimiter=limit=0.35:attack=1:release=30,dynaudnorm=f=300:g=21:p=0.5:m=25:s=5:t=0.02,acompressor=threshold=-24dB:ratio=3:attack=5:release=120,agate=threshold=0.03:ratio=3:attack=10:release=200:range=0.06"
ffmpeg -v error -y -i voice_raw.wav -af "$PRE" -ar 44100 pre.wav
J=$(ffmpeg -hide_banner -i pre.wav -af loudnorm=I=$LUFS:TP=$TP:LRA=11:print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p')
g() { echo "$J" | grep "\"$1\"" | sed -E 's/.*: "([^"]+)".*/\1/'; }
ffmpeg -v error -y -i pre.wav -af "loudnorm=I=$LUFS:TP=$TP:LRA=11:measured_I=$(g input_i):measured_TP=$(g input_tp):measured_LRA=$(g input_lra):measured_thresh=$(g input_thresh):offset=$(g target_offset):linear=true" -ar 44100 out.wav
