#!/bin/bash
# TradeManager 部署脚本
# 由 GitHub Actions 在 push 到 master 后自动调用，也可在服务器上手动执行
# 注意：代码同步（git reset）由 workflow 完成，本脚本只负责重启与验证

set -e
cd /var/www/trademanager/server

echo "[deploy] 停止旧服务..."
pkill -f 'node /var/www/trademanager/server/server.js' 2>/dev/null || true
sleep 1

echo "[deploy] 启动新服务..."
nohup node server.js >> out.log 2>&1 < /dev/null &
sleep 4

if curl -sf http://localhost:3000/ > /dev/null; then
  NEW_PID=$(pgrep -f 'node /var/www/trademanager/server/server.js' | head -1)
  echo "[deploy] ✅ 部署成功，服务运行中 (PID: $NEW_PID)"
else
  echo "[deploy] ❌ 服务未响应，请检查 server/out.log"
  exit 1
fi
