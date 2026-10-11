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
# JWT 密钥：优先用环境变量（多机部署/需要共用时在服务器上导出 JWT_SECRET）。
# 未设置时 server/auth.js 会在 server/.jwt-secret 生成并持久化一份本机专用密钥，
# 该文件已 gitignore，不会被部署覆盖，因此重启后登录态依然有效。
# 若站点走 HTTPS，建议同时导出 COOKIE_SECURE=1，让会话 Cookie 带上 Secure 标记。
nohup node server.js >> out.log 2>&1 < /dev/null &
sleep 4

if curl -sf http://localhost:3000/ > /dev/null; then
  NEW_PID=$(pgrep -f 'node /var/www/trademanager/server/server.js' | head -1)
  echo "[deploy] ✅ 部署成功，服务运行中 (PID: $NEW_PID)"
else
  echo "[deploy] ❌ 服务未响应，请检查 server/out.log"
  exit 1
fi
