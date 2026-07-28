#!/usr/bin/env bash
#
# Build to a directory on the Windows filesystem.
#
# Chrome runs on the Windows host while this code lives in WSL, and Chrome's
# "Load unpacked" button opens a native Windows folder picker that does not
# reliably reach the WSL share — the Linux entry is often missing from its
# sidebar. Building straight to the Windows side avoids copying anything by
# hand after every change.
#
# Override the destination with JT_WIN_DIST if you want it somewhere else.
#
#   ./tools/build-win.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -n "${JT_WIN_DIST:-}" ]]; then
  out="$JT_WIN_DIST"
else
  # Resolve the real Windows profile rather than assuming the Linux and
  # Windows usernames match. cmd.exe is run from /mnt/c because it refuses to
  # start in a UNC path and warns noisily about it.
  profile="$(cd /mnt/c && cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')"
  if [[ -z "$profile" ]]; then
    echo "Could not find the Windows user profile. Set JT_WIN_DIST instead." >&2
    exit 1
  fi
  out="$(wslpath -u "$profile")/JourneyTracker-dist"
fi

npx vite build --outDir "$out" --emptyOutDir

echo
echo "Built to the Windows filesystem. In chrome://extensions, turn on"
echo "Developer mode, choose Load unpacked, and select:"
echo
echo "    $(wslpath -w "$out")"
echo
