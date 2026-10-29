#!/bin/sh
# Launch smoke test for a packaged macOS app, run in CI after each build.
# Usage: sh scripts/smoke-mac-app.sh "<path to Awesome Downloader.app>" [arm64|x64]
#
# Like any launch of the app, this uses ~/.awesome-downloader and registers the
# native host for the browsers installed; Electron ignores $HOME, so it cannot be
# redirected. Run it on a CI runner or a test account. Checks that:
#  - the app's runtime still runs as Node with ELECTRON_RUN_AS_NODE=1 (the RunAsNode
#    fuse; the native-host launcher and yt-dlp depend on it), on the expected arch;
#  - the bundled FFmpeg starts;
#  - the app starts, stays running and writes its native-host launcher;
#  - that launcher answers a native message through the app's runtime.
set -eu

app=${1:?usage: smoke-mac-app.sh <app> [arm64|x64]}
case "${2:-$(uname -m)}" in
  arm64) expected=arm64 ;;
  x64|x86_64) expected=x64 ;;
  *) echo "Unknown architecture: $2" >&2; exit 2 ;;
esac
exe="$app/Contents/MacOS/Awesome Downloader"
home=$(cd ~ && pwd)
log=$(mktemp)
pid=
cleanup() { if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi; rm -f "$log"; }
trap cleanup EXIT

arch=$(ELECTRON_RUN_AS_NODE=1 "$exe" -e 'process.stdout.write(process.arch)')
[ "$arch" = "$expected" ] || { echo "RunAsNode reported arch '$arch', expected $expected" >&2; exit 1; }
echo "ok   ELECTRON_RUN_AS_NODE runs Node ($arch)"

"$app/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg" -hide_banner -version | head -n 1

launcher="$home/.awesome-downloader/BrowserIntegration/integration/native-host"
rm -f "$launcher"
"$exe" >"$log" 2>&1 &
pid=$!
i=0
until [ -x "$launcher" ] && [ -f "$home/.awesome-downloader/bridge.json" ]; do
  kill -0 "$pid" 2>/dev/null || { echo "The app exited during startup:" >&2; cat "$log" >&2; exit 1; }
  i=$((i + 1)); [ $i -le 60 ] || { echo "The app did not write its native-host launcher within 60s" >&2; cat "$log" >&2; exit 1; }
  sleep 1
done
sleep 5
kill -0 "$pid" 2>/dev/null || { echo "The app exited after startup:" >&2; cat "$log" >&2; exit 1; }
echo "ok   app is running and wrote $launcher"

# An unsupported action gets a framed error reply; it proves the launcher ran
# native-host.cjs in the app's runtime without starting a download.
reply=$(printf '\021\000\000\000{"action":"ping"}' | "$launcher" | tail -c +5)
case "$reply" in
  *'Unsupported native action'*) echo "ok   native host replied: $reply" ;;
  *) echo "Unexpected native host reply: '$reply'" >&2; exit 1 ;;
esac
