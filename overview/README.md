# overview/ — easy-stock 子项目（行情总览）

本目录是从 [jundizhou/easy-stock](https://github.com/jundizhou/easy-stock) 拷贝进来的
完整源码（backend Go 源码 + frontend React 源码），作为 TradeManager 的
「行情总览」子项目维护。

- 线上访问：`/overview/`（由 `server/overview-proxy.js` 反向代理）
- 前端构建产物：`public/overview-app/`（构建命令见下）
- 后端运行：监听 127.0.0.1:20081（`backend/cmd/server/main.go`）

## 前端重新构建

```powershell
cd overview/frontend
$env:VITE_A_STOCK_BACKEND_URL = '/'
$env:TMP = '<仓库根>\.esbuild-tmp'; $env:TEMP = $env:TMP
npm install   # 首次
npm run build # 产物 dist/ → 拷贝到 public/overview-app/
```

## 后端编译

需要 Go ≥ 1.26（源码在 `overview/backend`，入口 `cmd/server/main.go`）：

```
cd overview/backend
$env:GOOS='linux'; $env:GOARCH='amd64'; go build -o ../../scripts/easy-stock-server ./cmd/server
```

## 与上游的关系

源仓库 jundizhou/easy-stock 无推送权限，源码以快照方式维护在本目录；
本地修改（子路径挂载修复等）以本目录为准。