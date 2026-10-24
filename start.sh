#!/usr/bin/env bash
# Starts Rackpad on this Mac: checks what it needs, installs what's missing,
# and keeps the Mac awake while it runs.
#
#   ./start.sh                 start Rackpad
#   ./start.sh --no-airdrop    also pause AirDrop & Handoff while it runs, for the
#                              smoothest pointer (asks for your password)
#   ./start.sh --verbose       anything else goes to rackpad itself (./start.sh --help)

set -euo pipefail
cd "$(dirname "$0")"

fail() {
  printf 'Rackpad: %s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = Darwin ] || fail "runs on a Mac (it moves the Mac's pointer). To try the phone app anywhere: npm run dev"

command -v node >/dev/null || fail "needs Node.js 18.17 or newer: https://nodejs.org, or: brew install node"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 18 || (a === 18 && b >= 17) ? 0 : 1)' \
  || fail "needs Node.js 18.17 or newer (this Mac has $(node -v))"
command -v swiftc >/dev/null || fail "needs Apple's Command Line Tools to build its helper. Run: xcode-select --install"

# Dependencies: on the first run, and again whenever they change.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installing dependencies…"
  npm ci --no-audit --no-fund --loglevel=error
fi

args=()
pause_airdrop=0
for arg in "$@"; do
  if [ "$arg" = --no-airdrop ]; then pause_airdrop=1; else args+=("$arg"); fi
done

# AirDrop, Handoff and Universal Control hop the Wi-Fi radio off your network
# about twice a second, and each hop stalls Wi-Fi for ~90 ms: a hitch you can
# feel in the pointer. macOS switches them back on whenever it wants them, so
# a small root loop switches them off again within a second, for as long as
# this script runs, and turns them back on when Rackpad quits.
if [ "$pause_airdrop" = 1 ] && ifconfig awdl0 >/dev/null 2>&1; then
  echo "Keeping AirDrop & Handoff paused while Rackpad runs (macOS asks for your password once)…"
  sudo -v
  sudo sh -c "while kill -0 $$ 2>/dev/null; do ifconfig awdl0 down 2>/dev/null; sleep 1; done; ifconfig awdl0 up" &
fi

# caffeinate keeps the Mac from going to sleep while Rackpad is running.
caffeinate -i node bin/rackpad.js ${args[@]+"${args[@]}"}
