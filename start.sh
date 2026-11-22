#!/usr/bin/env bash
# YoYo画布本地版 · Linux/macOS 验证用启动脚本（Windows 用 start.bat）。
# 首次运行会构建前端；之后直接起服务。数据都在 ./data/。
set -euo pipefail
cd "$(dirname "$0")"

BUN_BIN="${BUN_BIN:-bun}"
command -v "$BUN_BIN" >/dev/null 2>&1 || { echo "找不到 bun：请先安装 Bun，或把 runtime/bun 加入 PATH。"; exit 1; }

# ffmpeg/ffprobe：随包目录优先（runtime/ffmpeg），否则用系统 PATH。
if [ -d "$PWD/runtime/ffmpeg" ]; then
  export PATH="$PWD/runtime/ffmpeg:$PATH"
fi
command -v ffmpeg >/dev/null 2>&1 || echo "警告：未找到 ffmpeg，视频工具节点（抽帧/提取音频/配乐/海报）不可用。"
command -v ffprobe >/dev/null 2>&1 || echo "警告：未找到 ffprobe，媒体尺寸实测不可用。"

if [ ! -d node_modules ]; then
  echo "首次运行：安装依赖…"
  "$BUN_BIN" install
fi

if [ ! -f client/dist/index.html ]; then
  echo "首次运行：构建前端…"
  "$BUN_BIN" run build:client
fi

echo "启动 YoYo画布本地版：http://127.0.0.1:${YOYO_LOCAL_PORT:-3737}"
exec "$BUN_BIN" ./local/server.ts
