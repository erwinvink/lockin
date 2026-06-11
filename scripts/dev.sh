#!/usr/bin/env bash
# Starts the full local backend for lockin development: the Garmin sidecar AND
# the coach proxy, always together. Debug builds of the iOS app talk to
# http://127.0.0.1:8787 by default, which is what this script serves.
#
# Usage: ./scripts/dev.sh   (Ctrl-C stops both)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GARMIN_DIR="$ROOT/GarminService"
PROXY_DIR="$ROOT/Proxy"

if [ ! -x "$GARMIN_DIR/.venv/bin/python" ]; then
  echo "GarminService venv missing — creating it once..."
  python3 -m venv "$GARMIN_DIR/.venv"
  "$GARMIN_DIR/.venv/bin/pip" install -q -r "$GARMIN_DIR/requirements.txt"
fi

if [ ! -d "$PROXY_DIR/node_modules" ]; then
  echo "Proxy node_modules missing — installing once..."
  (cd "$PROXY_DIR" && npm install)
fi

# The proxy reaches the sidecar on this URL (its default, set explicitly here).
export GARMIN_SERVICE_URL="http://127.0.0.1:8788"

echo "Starting Garmin sidecar on :8788..."
(cd "$GARMIN_DIR" && exec .venv/bin/python -m uvicorn main:app --port 8788) &
GARMIN_PID=$!
trap 'kill "$GARMIN_PID" 2>/dev/null || true' EXIT INT TERM

# Give it a beat, then report whether the Garmin account is connected.
sleep 2
STATUS=$(curl -s http://127.0.0.1:8788/status || echo '{}')
case "$STATUS" in
  *'"loggedIn": true'*|*'"loggedIn":true'*)
    echo "Garmin: connected (tokens found)." ;;
  *)
    echo "Garmin: NOT logged in. One-time fix:"
    echo "  cd GarminService && .venv/bin/python main.py login"
    echo "  (asks email/password/MFA once; tokens persist in GarminService/tokens/)"
    ;;
esac

echo "Starting coach proxy on :8787 (Ctrl-C stops both)..."
cd "$PROXY_DIR" && exec npm run dev
