#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# A competent reference for a3-radio-spot: three lines in order, ducked bed, a sting at 13.5 s, two-pass-free loudnorm.
set -e
d1=$(ffprobe -v error -show_entries format=duration -of csv=p=0 line1.wav)
d2=$(ffprobe -v error -show_entries format=duration -of csv=p=0 line2.wav)
s1=500; s2=$(awk "BEGIN{printf \"%d\", 500 + $d1*1000 + 500}"); s3=$(awk "BEGIN{printf \"%d\", 500 + $d1*1000 + 500 + $d2*1000 + 500}")
ffmpeg -v error -y -i line1.wav -i line2.wav -i line3.wav -i music.wav -i sting.wav -filter_complex "
[0:a]adelay=${s1}|${s1}[a];[1:a]adelay=${s2}|${s2}[b];[2:a]adelay=${s3}|${s3}[c];
[a][b][c]amix=inputs=3:normalize=0,apad=whole_dur=15,asplit=2[v][sc];
[3:a]atrim=0:15,afade=t=out:st=13.8:d=1.2,volume=-10dB[m];
[m][sc]sidechaincompress=threshold=0.01:ratio=10:attack=30:release=300[md];
[4:a]adelay=13400|13400,volume=-3dB[s];
[v]aformat=channel_layouts=stereo[vs];[vs][md][s]amix=inputs=3:normalize=0,atrim=0:15,afade=t=out:st=14.7:d=0.3[o]" -map "[o]" -ar 44100 pre.wav
ffmpeg -v error -y -i pre.wav -af loudnorm=I=-16:TP=-1.5:LRA=11 -ar 44100 -t 15 out.wav
