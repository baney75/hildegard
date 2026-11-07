#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# A competent reference for a2-church-duck: sidechain ducking, fades, two-pass loudnorm.
set -e
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 voice.wav); T=$(awk "BEGIN{print $D + 8}")
ffmpeg -v error -y -i voice.wav -i music.wav -filter_complex "
[0:a]adelay=4000|4000,apad=whole_dur=$T,asplit=2[v][sc];
[1:a]atrim=0:$T,afade=t=in:d=3,afade=t=out:st=$(awk "BEGIN{print $T-4}"):d=4,volume=-12dB[m];
[m][sc]sidechaincompress=threshold=0.01:ratio=12:attack=40:release=500:makeup=1[md];
[v]aformat=channel_layouts=stereo[vs];[vs][md]amix=inputs=2:normalize=0[o]" -map "[o]" -t $T -ar 44100 pre.wav
ffmpeg -v error -y -i pre.wav -af loudnorm=I=-16:TP=-1.5:LRA=11 -ar 44100 out.wav
