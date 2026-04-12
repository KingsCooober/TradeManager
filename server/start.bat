@echo off
cd /d "%~dp0"
echo 正在启动仓位管理服务器...
echo 访问地址: http://localhost:3000
echo 按 Ctrl+C 停止服务器
echo.
node server.js
pause