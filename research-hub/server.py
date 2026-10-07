#!/usr/bin/env python3
"""研报阅读整理工作台 · 本地服务入口。

用法：
    python3 server.py                # 默认 http://127.0.0.1:8765
    python3 server.py --port 9000    # 指定端口
    python3 server.py --no-browser   # 不自动打开浏览器
    python3 server.py --reseed       # 清空数据并重新写入示例研报
"""

from __future__ import annotations

import argparse
import sys
import threading
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

from fastapi import FastAPI  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from researchhub import __version__, autofetch, db, seed  # noqa: E402
from researchhub.api import router  # noqa: E402

WEB_DIR = BASE_DIR / "web"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    created = seed.seed_if_empty()
    print(f"  数据库：{db.DB_PATH}")
    if created:
        print(f"  已写入 {created} 篇示例研报（可在页面上删除）")
    autofetch.start()
    settings = db.get_settings()
    if settings.get("autofetch_enabled") == "1":
        subs = autofetch.list_subscriptions()
        print(f"  自动抓取：已开启（{sum(1 for s in subs if s['enabled'])} 条订阅启用）")
    else:
        print("  自动抓取：未开启（左侧栏「研报抓取」可开启订阅式自动获取）")
    yield
    autofetch.stop()


app = FastAPI(title="研报阅读整理工作台", version=__version__, lifespan=lifespan)


@app.middleware("http")
async def disable_browser_cache(request, call_next):
    """禁用浏览器缓存。

    交易台（Express）对自己的静态资源就是禁缓存的，研报库之前没做，
    导致改完样式后浏览器还在用启发式缓存里的旧 style.css —— 页面看起来"没样式"。
    这里对全部响应统一加禁用头，与主站保持一致。
    """
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, proxy-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


app.include_router(router)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "version": __version__, "db": str(db.DB_PATH)}


@app.exception_handler(404)
async def not_found(request, exc):  # noqa: ANN001, ANN201
    if request.url.path.startswith("/api"):
        return JSONResponse({"detail": getattr(exc, "detail", "未找到")}, status_code=404)
    index = WEB_DIR / "index.html"
    if index.exists():
        from fastapi.responses import FileResponse

        return FileResponse(index)
    return JSONResponse({"detail": "not found"}, status_code=404)


app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")


def main() -> None:
    parser = argparse.ArgumentParser(description="研报阅读整理工作台")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--reseed", action="store_true", help="清空研报并重新写入示例数据")
    args = parser.parse_args()

    db.init_db()
    if args.reseed:
        conn = db.connect()
        conn.execute("DELETE FROM highlights")
        conn.execute("DELETE FROM notes")
        conn.execute("DELETE FROM reports")
        conn.commit()
        seed.seed_if_empty()
        print("  已重置为示例数据")

    url = f"http://{args.host}:{args.port}"
    print("\n  研报阅读整理工作台")
    print(f"  ➜  {url}\n")
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
