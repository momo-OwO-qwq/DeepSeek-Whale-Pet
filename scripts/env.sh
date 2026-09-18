#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 可选的运行环境修正（**仅特定机器需要，普通环境不要 source 它**）
#
# 背景：在 Orange Pi 5 Plus（aarch64）上实测到三个环境问题，会导致
# `npm install` 装不上 Electron 二进制、或启动时找不到可写缓存目录：
#   1. github.com 不可达   → Electron 二进制必须走 npmmirror 镜像
#   2. ~/.cache 只读挂载   → Electron 下载缓存改到项目内 .electron-cache/
#   3. ~/.npm 为 root 所有 → npm 缓存改到项目内 .npm-cache/
#
# 用法（二选一）：
#   source scripts/env.sh && electron .     # 手动
#   npm run start:env                       # 或 package.json 里的 *:env 脚本
#
# 普通桌面环境（Windows / macOS / 常规 Linux）**不需要**这个脚本，直接 `npm start`。
# ---------------------------------------------------------------------------

export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_CACHE="${ELECTRON_CACHE:-$PWD/.electron-cache}"
export npm_config_cache="${npm_config_cache:-$PWD/.npm-cache}"

# 本机是 Wayland 会话，但 main.js 为规避拖拽问题强制走 XWayland（ozone-platform=x11）。
# 若系统有 XWayland，保持默认；若窗口起不来，取消下面一行注释改用原生 Wayland：
# export ELECTRON_OZONE_PLATFORM_HINT=wayland

# ARM 单板上 GPU 驱动常不完整（MESA-LOADER 报错）；窗口渲染异常/花屏时启用软件渲染：
# export LIBGL_ALWAYS_SOFTWARE=1
