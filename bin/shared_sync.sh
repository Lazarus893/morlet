#!/bin/bash
# 把小满工作区的 shared/ 与云空间双向同步。云端用 rclone 远端 "xiaoman-cloud"（WebDAV/坚果云、腾讯云 COS、微盘挂载均可）。
# 用法：shared_sync.sh [push|pull|both]   默认 both
set -euo pipefail
PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${PHONE_SHARED_ROOT:-$PROJECT_ROOT/.runtime/workspace/shared}"
REMOTE="${XIAOMAN_CLOUD_REMOTE:-}"
if [[ -z "$REMOTE" ]]; then
  echo "云同步未启用：请先在 .env 显式设置 XIAOMAN_CLOUD_REMOTE。"
  exit 2
fi
MODE="${1:-both}"
if ! command -v rclone >/dev/null 2>&1; then
  echo "云同步未启用：没装 rclone。装法：brew install rclone；然后 rclone config 建一个叫 xiaoman-cloud 的远端（坚果云选 webdav，地址 https://dav.jianguoyun.com/dav/，账号 + 应用密码）。"
  exit 2
fi
if ! rclone listremotes 2>/dev/null | grep -q "^${REMOTE%%:*}:"; then
  echo "云同步未启用：rclone 里没有远端 ${REMOTE%%:*}。运行 rclone config 创建后再试。"
  exit 2
fi
case "$MODE" in
  push) rclone copy "$ROOT" "$REMOTE" --exclude "intent-log.jsonl" -q && echo "已上传 shared/ → $REMOTE" ;;
  pull) rclone copy "$REMOTE" "$ROOT" -q && echo "已下载 $REMOTE → shared/" ;;
  both) rclone copy "$ROOT" "$REMOTE" --exclude "intent-log.jsonl" -q; rclone copy "$REMOTE" "$ROOT" -q; echo "shared/ ⇄ $REMOTE 已同步" ;;
  *) echo "用法：shared_sync.sh [push|pull|both]"; exit 1 ;;
esac
