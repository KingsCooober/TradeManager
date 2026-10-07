#!/usr/bin/env bash
# 研报阅读整理工作台 · 一键启动
set -euo pipefail

cd "$(dirname "$0")"

PY="${PYTHON:-python3}"

if ! "$PY" -c "import fastapi, uvicorn, httpx, pypdf, bs4" >/dev/null 2>&1; then
  echo "缺少依赖，正在安装 fastapi / uvicorn / httpx / pypdf / beautifulsoup4 …"
  "$PY" -m pip install --quiet fastapi uvicorn httpx pypdf beautifulsoup4
fi

exec "$PY" server.py "$@"
