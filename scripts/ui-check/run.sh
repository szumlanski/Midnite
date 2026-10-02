#!/usr/bin/env bash
# Build + serve the app with a stub Supabase env, run the screenshot harness, stop the server.
#   bash scripts/ui-check/run.sh [shots.mjs args, e.g. --only fleet,live --reduced --out DIR]
# Env:
#   UI_CHECK_PORT=3100      port for `next start`
#   UI_CHECK_IN_PLACE=1     build in the repo's own .next (default: a snapshot copy in scripts/ui-check/.build,
#                           so a concurrent edit or build in the repo cannot clobber the served build)
#   UI_CHECK_SKIP_BUILD=1   reuse the previous build
# Exit code is shots.mjs's: non-zero on any console/page error or failed step.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PORT="${UI_CHECK_PORT:-3100}"
WORK="$HERE/.build"
mkdir -p "$WORK"

export NEXT_TELEMETRY_DISABLED=1
export NEXT_PUBLIC_SUPABASE_URL=https://stub.supabase.co
export NEXT_PUBLIC_SUPABASE_ANON_KEY=stub

if [ "${UI_CHECK_IN_PLACE:-0}" = "1" ]; then APP="$ROOT"; else APP="$WORK/app"; fi

if [ "${UI_CHECK_SKIP_BUILD:-0}" != "1" ]; then
  if [ "$APP" != "$ROOT" ]; then
    # Snapshot the working tree. The copy has no package-lock.json on purpose: Next then infers the
    # repo as the workspace root and resolves the repo's node_modules (Turbopack rejects a symlinked
    # node_modules that points outside the project root).
    rm -rf "$APP" && mkdir -p "$APP"
    tar -C "$ROOT" --exclude=./node_modules --exclude=./.next --exclude=./.git --exclude=./scripts \
      --exclude=./docs --exclude=./package-lock.json -cf - . | tar -C "$APP" -xf - || { echo "snapshot copy failed" >&2; exit 1; }
  fi
  echo "building $APP (log: $WORK/build.log)" >&2
  if ! (cd "$APP" && npm run build) > "$WORK/build.log" 2>&1; then
    tail -40 "$WORK/build.log" >&2
    echo "build failed; if pages/index.jsx is mid-edit, wait a minute and retry" >&2
    exit 1
  fi
fi

if curl -s -o /dev/null "http://localhost:$PORT/"; then echo "port $PORT is already in use" >&2; exit 1; fi

# New session/process group so the whole server tree can be stopped at the end.
(cd "$APP" && exec setsid npx next start -p "$PORT") > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill -- "-$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

if ! curl -s -o /dev/null --retry 60 --retry-delay 1 --retry-connrefused "http://localhost:$PORT/"; then
  cat "$WORK/server.log" >&2
  echo "server did not come up on port $PORT" >&2
  exit 1
fi

node "$HERE/shots.mjs" --base "http://localhost:$PORT" "$@"
exit $?
