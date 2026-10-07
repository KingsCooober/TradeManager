#!/bin/bash
# 启动研报库（独立 Python 服务，默认 127.0.0.1:8765）
# 主站通过 /research/ 反向代理访问它，并把它作为子进程托管（挂掉自动重启）。
# 本脚本也可以单独前台运行，方便调试看日志。
set -e
cd "$(dirname "$0")/../research-hub"

PY="${PYTHON:-python3}"
DEPS="fastapi uvicorn httpx pypdf beautifulsoup4"

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "❌ 没找到 python3。研报库需要 Python 3.9+，请先安装后重试。"
  exit 1
fi

have_deps() { "$1" -c "import fastapi, uvicorn, httpx, pypdf, bs4" >/dev/null 2>&1; }

if ! have_deps "$PY"; then
  echo "📦 首次运行，正在安装依赖（${DEPS}）..."
  ok=0

  # 1) 常规安装
  if "$PY" -m pip install --quiet $DEPS 2>/dev/null; then ok=1; fi

  # 2) 新版 Debian/Ubuntu 的 PEP 668（externally-managed-environment）会拒绝上面的装法
  if [ "$ok" = "0" ]; then
    echo "   系统 pip 受限（PEP 668），改用 --break-system-packages 重试..."
    if "$PY" -m pip install --quiet --break-system-packages $DEPS 2>/dev/null; then ok=1; fi
  fi

  # 3) 还不行就建独立虚拟环境，不污染系统 Python
  if [ "$ok" = "0" ]; then
    echo "   改用独立虚拟环境 .venv ..."
    if "$PY" -m venv .venv 2>/dev/null; then
      ./.venv/bin/python -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
      ./.venv/bin/python -m pip install --quiet $DEPS 2>/dev/null || true
      if have_deps ./.venv/bin/python; then PY=./.venv/bin/python; ok=1; fi
    fi
  fi

  if [ "$ok" = "0" ]; then
    echo "❌ 依赖安装失败。请在服务器上手动执行其一："
    echo "   python3 -m pip install --break-system-packages $DEPS"
    echo "   python3 -m venv .venv && ./.venv/bin/pip install $DEPS"
    exit 1
  fi
  echo "✅ 依赖就绪"
fi

exec "$PY" server.py "$@"
