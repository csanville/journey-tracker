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
# Override the destination with JT_WIN_DIST, as a *Linux* path:
#
#   JT_WIN_DIST=/mnt/c/Users/you/somewhere ./tools/build-win.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -n "${JT_WIN_DIST:-}" ]]; then
  out="${JT_WIN_DIST%/}"

  # A Windows-style path is the natural thing to paste here, and nothing
  # downstream would object: Vite would create a directory literally named
  # `C:\Users\you\dist` inside this repo, and `wslpath -w` would echo a
  # mangled path back with a zero exit status.
  if [[ "$out" == *'\'* || "$out" =~ ^[A-Za-z]: ]]; then
    echo "JT_WIN_DIST must be a Linux path, not a Windows one." >&2
    echo "Use /mnt/c/Users/you/... rather than C:\\Users\\you\\..." >&2
    exit 1
  fi
else
  # Resolve the real Windows profile rather than assuming the Linux and
  # Windows usernames match. cmd.exe is run from /mnt/c because it refuses to
  # start in a UNC path and warns noisily about it.
  #
  # `|| true` matters: under `set -e` a failing command substitution aborts the
  # script at the assignment, so without it the guard below is unreachable and
  # a missing /mnt/c surfaces as a bare `cd` error.
  profile="$( (cd /mnt/c && cmd.exe /c 'echo %USERPROFILE%') 2>/dev/null | tr -d '\r' || true )"
  if [[ -z "$profile" ]]; then
    echo "Could not read the Windows user profile — is /mnt/c mounted and cmd.exe reachable?" >&2
    echo "Set JT_WIN_DIST to a Linux path under /mnt/... instead." >&2
    exit 1
  fi

  home="$(wslpath -u "$profile" 2>/dev/null || true)"
  if [[ -z "$home" ]]; then
    echo "Could not translate '$profile' to a Linux path. Set JT_WIN_DIST instead." >&2
    exit 1
  fi

  out="$home/JourneyTracker-dist"
fi

# --emptyOutDir below deletes everything in $out. Refuse anything that is not
# either new or a previous build of this extension, so a stray JT_WIN_DIST
# cannot wipe a home directory.
if [[ -e "$out" && ! -f "$out/manifest.json" ]]; then
  echo "Refusing to empty '$out': it exists and does not look like a previous build" >&2
  echo "(no manifest.json inside). Point JT_WIN_DIST at a new or already-built directory." >&2
  exit 1
fi

npx tsc --noEmit
npx vite build --outDir "$out" --emptyOutDir

# The injected capture bundle, which is a second build for the reasons set out
# in vite.inject.config.ts. It has to run here too, and not only in `npm run
# build`: this script is the documented way to load the extension on WSL, so
# skipping it shipped a build where the right-click capture failed on every
# page with "Could not load file: 'injected.js'" — in a worker console, which
# is not where anyone would think to look.
#
# No --emptyOutDir: this adds to the build above rather than replacing it.
npx vite build --config vite.inject.config.ts --outDir "$out"

echo
echo "Built to the Windows filesystem. In chrome://extensions, turn on"
echo "Developer mode, choose Load unpacked, and select:"
echo
echo "    $(wslpath -w "$out")"
echo
