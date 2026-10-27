#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if ! "$ROOT/scripts/pa.sh" connect install; then
  printf '%s\n' '连接尚未完成，请查看上面的下一步。'
fi
read -r -p '按回车关闭。' _answer
