#!/bin/sh
# Fails unless the packaged macOS app, and the FFmpeg bundled inside it, are built
# only for the given architecture: arm64 or x64 (default: this Mac's). ffmpeg-static
# installs the FFmpeg for the architecture npm ran on, so building for another
# architecture without reinstalling it would bundle the wrong binary.
set -eu

case "${1:-$(uname -m)}" in
  arm64) expected=arm64 app="release/mac-arm64/Awesome Downloader.app" ;;
  x64|x86_64) expected=x86_64 app="release/mac/Awesome Downloader.app" ;;
  *) echo "Unknown architecture: $1 (use arm64 or x64)" >&2; exit 2 ;;
esac

status=0
check() {
  if [ ! -f "$2" ]; then echo "Missing: $2" >&2; status=1; return; fi
  archs=$(lipo -archs "$2")
  case "$1:$archs" in
    exact:"$expected"|contains:*"$expected"*) echo "ok   $archs  $2" ;;
    *) echo "FAIL $archs  $2 (expected $expected)" >&2; status=1 ;;
  esac
}

check exact "$app/Contents/MacOS/Awesome Downloader"
check exact "$app/Contents/Frameworks/Electron Framework.framework/Electron Framework"
check exact "$app/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg"
# The official yt-dlp_macos release is universal; it only has to include this architecture.
if [ -e "$app/Contents/Resources/tools/yt-dlp" ]; then check contains "$app/Contents/Resources/tools/yt-dlp"; fi
exit $status
