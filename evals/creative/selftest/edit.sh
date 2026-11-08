#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# A competent reference for e1-canoe-cut: six hard cuts over all four clips, a title, a closing card, a music bed.
set -e
F=/usr/share/fonts/liberation/LiberationSans-Bold.ttf
seg() { echo "[$1:v]trim=$2:$3,setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,format=yuv420p[v$4]"; }
ffmpeg -v error -y -i clip_a.mp4 -i clip_b.mp4 -i clip_c.mp4 -i clip_d.mp4 -i music.wav -filter_complex "
$(seg 0 0 4 1); $(seg 1 2 6 2); $(seg 2 0 4 3); $(seg 3 1 5 4); $(seg 0 6 10 5); $(seg 1 6 9 6);
[v1][v2][v3][v4][v5][v6]concat=n=6:v=1:a=0[cat];
[cat]drawtext=fontfile=$F:text='Hollis Creek Canoe Rental':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.5:boxborderw=20:enable='between(t,0.5,3.5)',
drawtext=fontfile=$F:text='Open May to October - Rt 122, Hollis NH':fontcolor=white:fontsize=44:x=(w-text_w)/2:y=h-120:box=1:boxcolor=black@0.5:boxborderw=14:enable='gte(t,21)'[v];
[4:a]atrim=0:23,afade=t=in:d=1.5,afade=t=out:st=20.5:d=2.5,loudnorm=I=-16:TP=-1.5:LRA=11[a]" -map "[v]" -map "[a]" -c:v libx264 -preset veryfast -c:a aac -b:a 160k -ar 44100 -t 23 out.mp4
