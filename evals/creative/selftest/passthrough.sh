#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Control: does nothing useful. Copies the first input to out.wav.
f=$(ls *.wav | head -1); ffmpeg -v error -y -i "$f" out.wav
