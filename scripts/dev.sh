#!/bin/sh
# Isolated dev environment: mock LLM + isolated hc core + isolated `dsh web` (Desktop stand-in)
# with this plugin linked in. Never touches the user's hc core or DSH Desktop profile.
#   scripts/dev.sh up      start everything (idempotent)
#   scripts/dev.sh down    stop everything this script started
#   eval "$(scripts/dev.sh env)"   point hc/dsh in this shell at the isolated world
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ISO=${DSH_BRIDGE_ISO:-/tmp/dsh-iso}
PORT=${MOCK_LLM_PORT:-18765}

env_lines() {
  cat <<EOF
export DSH_HOME=$ISO/home
export DEEPSEEK_BASE_URL=http://127.0.0.1:$PORT/v1
export DEEPSEEK_API_KEY=mock-key
export HC_SESSION=dshbridge
export XDG_STATE_HOME=$ISO/xdg/state
export XDG_CONFIG_HOME=$ISO/xdg/config
export PATH="$ISO/home/herdr-bridge/bin:\$PATH"
# No XDG_RUNTIME_DIR, so hc keeps its socket under the isolated state home.
unset HC_TERMINAL_ID XDG_RUNTIME_DIR
EOF
}

case "${1:-}" in
env) env_lines ;;
up)
  eval "$(env_lines)"
  mkdir -p "$ISO/xdg/state"
  if [ ! -f "$ISO/mock.pid" ] || ! kill -0 "$(cat "$ISO/mock.pid")" 2>/dev/null; then
    python3 -I "$ROOT/scripts/mock-llm.py" "$PORT" "$ISO/mock.log" >/dev/null 2>&1 & echo $! > "$ISO/mock.pid"
  fi
  if [ ! -f "$ISO/web.pid" ] || ! kill -0 "$(cat "$ISO/web.pid")" 2>/dev/null; then
    grep -q dsh-herdr-bridge "$DSH_HOME/profiles/web/package.json" 2>/dev/null \
      || dsh plugin --profile web add "$ROOT" >/dev/null
    : > "$ISO/web.log"
    dsh web --no-open --port 0 > "$ISO/web.log" 2>&1 & echo $! > "$ISO/web.pid"
    i=0; until grep -q "^dsh web: http" "$ISO/web.log" || [ $i -ge 60 ]; do sleep 1; i=$((i+1)); done
  fi
  hc server status >/dev/null 2>&1 || hc server start >/dev/null
  # The plugin writes the dsh-hc launcher and the hc template itself when it loads.
  i=0; until [ -x "$DSH_HOME/herdr-bridge/bin/dsh-hc" ] || [ $i -ge 30 ]; do sleep 1; i=$((i+1)); done
  grep "^dsh web:" "$ISO/web.log" | sed 's/?token=.*//'
  echo "isolated hc session: $HC_SESSION"
  ;;
reload)
  # HMR: a config change recomposes the profile and reloads the linked plugin's changed files.
  # Merged, not overwritten: the web UI writes its own settings into the same file.
  eval "$(env_lines)"
  DSH_PROFILE_NAME=web "$ROOT/scripts/desktop.sh" reload
  ;;
down)
  eval "$(env_lines)"
  for f in web mock; do
    [ -f "$ISO/$f.pid" ] && kill "$(cat "$ISO/$f.pid")" 2>/dev/null || true
    rm -f "$ISO/$f.pid"
  done
  hc server stop >/dev/null 2>&1 || true
  ;;
*) echo "usage: $0 up|down|reload|env" >&2; exit 2 ;;
esac
