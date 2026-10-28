#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  source "$ROOT/.env"
  set +a
fi
export XIAOMAN_PROJECT_ROOT="$ROOT"
export DSH_HOME="$ROOT/.runtime/dsh"
export XIAOMAN_STATUS_SCRIPT="$ROOT/bin/status_report.py"
export DSH_LOG_FILE="$ROOT/.runtime/logs/cordis.log"
export PHONE_LOG_ROOT="$ROOT/.runtime/workspace/phone-logs"
export PHONE_SHARED_ROOT="$ROOT/.runtime/workspace/shared"
export PHONE_EXPERIENCES_DIR="$ROOT/.runtime/workspace/phone-refs/experiences"
export XIAOMAN_PORT="${XIAOMAN_PORT:-3082}"
export PYTHONUNBUFFERED=1
umask 077
export PATH="$ROOT/.venv/bin:$ROOT/node_modules/.bin:$PATH"
ACTION="${1:-help}"
if [[ $# -gt 0 ]]; then shift; fi
case "$ACTION" in
  init|doctor|capabilities|device-status|pending-users) exec python3 "$ROOT/scripts/onboard.py" "$ACTION" "$@" ;;
  setup)
    python3 -c 'import sys; sys.exit("Python 3.12+ is required for Octop Memory") if sys.version_info < (3, 12) else None'
    python3 -m venv "$ROOT/.venv"
    "$ROOT/.venv/bin/python" -m pip install -r "$ROOT/requirements.txt"
    (cd "$ROOT" && OPENUI_TELEMETRY_DISABLED=1 npm ci --no-audit --no-fund)
    exec "$ROOT/.venv/bin/python" "$ROOT/scripts/configure.py"
    ;;
  configure) exec python3 "$ROOT/scripts/configure.py" ;;
  connect) exec python3 "$ROOT/scripts/connect.py" "$@" ;;
  start|login|dump-config)
    if [[ ! -x "$ROOT/node_modules/.bin/dsh" ]]; then
      printf '%s\n' 'Dependencies missing. Run ./scripts/pa.sh setup first.' >&2; exit 2
    fi
    python3 "$ROOT/scripts/configure.py"
    cd "$ROOT/.runtime/workspace"
    if [[ "$ACTION" == start ]]; then
      exec "$ROOT/node_modules/.bin/dsh" --profile wx-life --no-open --port "$XIAOMAN_PORT" "$@"
    elif [[ "$ACTION" == login ]]; then
      CONTROL_SOCKET="$(python3 "$ROOT/bin/runtime_paths.py")"
      exec node "$ROOT/vendor/deepseek-harness-weixin/dist/cli.js" login --wait --socket "$CONTROL_SOCKET" "$@"
    else
      exec "$ROOT/node_modules/.bin/dsh" --profile wx-life --dump-config "$@"
    fi
    ;;
  intent) exec python3 "$ROOT/bin/intent_route.py" "$@" ;;
  status) exec python3 "$ROOT/bin/status_report.py" "$@" ;;
  owner) exec node "$ROOT/scripts/owner.mjs" "$@" ;;
  web) exec node "$ROOT/scripts/webui.mjs" "$@" ;;
  bridge) exec node "$ROOT/scripts/connection-companion.mjs" "$@" ;;
  proactive) exec node "$ROOT/scripts/proactive.mjs" "$@" ;;
  phone) exec python3 "$ROOT/bin/phone_task.py" "$@" ;;
  review) exec python3 "$ROOT/bin/phone_review.py" "$@" ;;
  sync) exec bash "$ROOT/bin/shared_sync.sh" "$@" ;;
  check) exec python3 "$ROOT/scripts/check.py" "$@" ;;
  pack) exec python3 "$ROOT/scripts/package.py" "$@" ;;
  import-skills) exec python3 "$ROOT/scripts/import_skills.py" "$@" ;;
  *) printf '%s\n' 'Usage: ./scripts/pa.sh init|doctor|capabilities|setup|configure|connect|start|web|bridge|login|status|proactive|device-status|phone|review|sync|dump-config|check|pack|import-skills' ;;
esac
