#!/usr/bin/env bash
# webm (Playwright recording) → H.264 MP4 that plays on any phone, without installing ffmpeg.
# Decoding: the ffmpeg Playwright bundles (VP8 decode + PNG encode only). Encoding: AVFoundation
# through frames2mp4.swift. Frames stream through a pipe — nothing is written to disk.
# Usage: to-mp4.sh <in.webm> [out.mp4] [fps=25] [bitrate=6000000]
set -euo pipefail
IN="$1"; OUT="${2:-${1%.webm}.mp4}"; FPS="${3:-25}"; RATE="${4:-6000000}"
HERE="$(cd "$(dirname "$0")" && pwd)"

FFMPEG="${FFMPEG:-}"
if [ -z "$FFMPEG" ]; then
  if command -v ffmpeg >/dev/null 2>&1 && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx264; then
    ffmpeg -hide_banner -loglevel error -y -i "$IN" -r "$FPS" -c:v libx264 -pix_fmt yuv420p -profile:v high \
      -crf 20 -preset slow -movflags +faststart "$OUT"
    echo "mp4 $OUT (system ffmpeg, libx264)"; exit 0
  fi
  FFMPEG="$(ls -d "$HOME"/Library/Caches/ms-playwright/ffmpeg-*/ffmpeg-mac 2>/dev/null | tail -1)"
fi
[ -x "$FFMPEG" ] || { echo "no ffmpeg: neither system ffmpeg with libx264 nor Playwright's ffmpeg-mac" >&2; exit 69; }

BIN="${TMPDIR:-/tmp}/frames2mp4-$(shasum "$HERE/frames2mp4.swift" | cut -c1-12)"
[ -x "$BIN" ] || swiftc -O -o "$BIN" "$HERE/frames2mp4.swift"

# This build has no image2pipe muxer: image2 with -update rewrites one "file", which on a pipe
# streams the frames one after another.
"$FFMPEG" -hide_banner -loglevel error -y -i "$IN" -r "$FPS" -c:v png -f image2 -update 1 /dev/stdout | "$BIN" "$OUT" "$FPS" "$RATE"

rm -f "$OUT".sb-*   # AVAssetWriter leaves its sandbox copy next to the output

SRC=$("$FFMPEG" -hide_banner -i "$IN" 2>&1 | sed -n 's/.*Duration: \([0-9:.]*\).*/\1/p' | head -1)
echo "source webm duration $SRC"
