/**
 * 行情总览子项目代理
 *
 * 把 easy-stock 的后端（Go，默认 127.0.0.1:20081）和它的前端构建产物（frontend/dist）
 * 挂到交易台的 /overview 路径下，让两者同源同端口：
 *
 *   /overview/api/v1/*      ->  easy-stock 后端 API（含 WebSocket 升级）
 *   /overview/assets/*      ->  easy-stock 前端构建产物
 *   /overview/*             ->  SPA 回退到 index.html（React Router 用 History 模式）
 *
 * 设计要点（与 research-proxy.js 保持同一套约定，改那边时对照着看）：
 *   - 上游未启动时返回 503 + 引导页，不抛异常影响主站；
 *   - 挂载必须在 express.json() 之前，否则 POST body 会被提前消费；
 *   - 前端构建产物是相对路径（vite base './'），因此 /overview/ 之后无需改写 resource path；
 *   - 前端请求后端时用 VITE_A_STOCK_BACKEND_URL=/overview/，配合 new URL(path, base) 自动带前缀。
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

const PREFIX = '/overview';
const UPSTREAM_HOST = process.env.OVERVIEW_HOST || '127.0.0.1';
const UPSTREAM_PORT = parseInt(process.env.OVERVIEW_PORT, 10) || 20081;
const UPSTREAM_TIMEOUT = parseInt(process.env.OVERVIEW_TIMEOUT, 10) || 120000;

// easy-stock 前端构建产物目录（可以指向任意一份 vite build 的 dist）
const DIST_DIR = process.env.OVERVIEW_DIST
  || path.join(__dirname, '..', 'public', 'overview-app');

/** 请求是否来自本机（健康检查接口只对本机开放，与研报库保持一致） */
function isLocalRequest(req) {
  const raw = (req.socket && req.socket.remoteAddress) || req.ip || '';
  const ip = String(raw).replace(/^::ffff:/, '');
  const local = ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
  if (!local) return false;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().replace(/^::ffff:/, '');
  if (xff && xff !== '127.0.0.1' && xff !== '::1') return false;
  const realIp = String(req.headers['x-real-ip'] || '').trim();
  if (realIp && realIp !== '127.0.0.1' && realIp !== '::1') return false;
  return true;
}

function wantsHtml(req) {
  const accept = String(req.headers.accept || '');
  return accept.indexOf('text/html') !== -1;
}

/** 探一下 easy-stock 后端是否活着（上游健康检查挂在 /api/health，不在 /api/v1 下） */
function probe(callback) {
  const req = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: 'GET', path: '/api/health', timeout: 2000 },
    (res) => { res.resume(); callback(res.statusCode === 200); }
  );
  req.setTimeout(2000, () => req.destroy());
  req.on('error', () => callback(false));
  req.end();
}

/**
 * 计算转发给上游的路径。
 * ★ 不用 req.originalUrl：挂载点 /overview 的匹配是「前缀式」的，
 *   app.use('/overview') 同样会吃掉 /overviewXxx 这类 URL，
 *   按长度切 originalUrl 会把 'Xxx' 当成上游路径（实测会变成 /api/v1/sources 之类的怪请求）。
 *   express 已经按挂载点算好了 req.url（剩余路径），直接用它。
 */
function upstreamPath(req) {
  let rest = String(req.originalUrl || req.url || '/');
  if (rest === PREFIX) rest = '/';
  else if (rest.indexOf(PREFIX + '/') === 0) rest = rest.slice(PREFIX.length);
  return rest.charAt(0) === '/' ? rest : '/' + rest;
}

/** 只把「HTTP 状态码能表达」的头部回给浏览器；逐跳头一律丢弃 */
function responseHeaders(up) {
  const skip = {
    connection: 1, 'keep-alive': 1, 'transfer-encoding': 1, upgrade: 1,
    'proxy-authenticate': 1, 'proxy-authorization': 1, te: 1, trailer: 1,
  };
  const out = {};
  Object.keys(up.headers || {}).forEach((key) => {
    if (!skip[key]) out[key] = up.headers[key];
  });
  return out;
}

/** 上游没起来时的引导页：给出确切的启动方法，而不是一句"服务不可用" */
function offlinePage() {
  const dist = DIST_DIR.split(path.sep).join(path.sep);
  const hasDist = fs.existsSync(path.join(DIST_DIR, 'index.html'));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>行情总览 · 服务未启动</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f5f6fa;color:#2c3e50}
  .box{max-width:640px;padding:36px 40px;background:#fff;border-radius:14px;
       box-shadow:0 8px 30px rgba(0,0,0,.08)}
  h1{font-size:20px;margin:0 0 14px}
  p{line-height:1.8;font-size:14px;color:#555;margin:8px 0}
  code{background:#eef1f7;padding:2px 7px;border-radius:5px;font-size:13px;
       font-family:Consolas,Monaco,monospace;color:#334}
  pre{background:#1e2230;color:#d6deeb;padding:14px 16px;border-radius:8px;overflow:auto;font-size:12.5px;line-height:1.7}
  .status{margin-top:18px;padding:10px 14px;border-radius:8px;font-size:13px}
  .warn{background:#fff4e5;color:#a35d00;border:1px solid #ffd8a8}
  .ok{background:#eafaf1;color:#1e7d51;border:1px solid #b7e4cc}
  a.btn{display:inline-block;margin-top:16px;padding:8px 18px;background:#4361ee;color:#fff;
        text-decoration:none;border-radius:7px;font-size:13px}
</style></head>
<body><div class="box">
<h1>📈 行情总览 · 后台服务未启动</h1>
<p>这个页面由 easy-stock 提供，需要先启动它的本地后台（默认 <code>${UPSTREAM_HOST}:${UPSTREAM_PORT}</code>）。</p>
<pre>cd server
npm run overview:start</pre>
<p>或者手动启动：</p>
<pre>cd "&lt;repos&gt;\easy-stock"
backend-bin\\easy-stock-server.exe</pre>
<div class="status ${hasDist ? 'ok' : 'warn'}">
  前端构建产物：${hasDist ? '已就绪' : '缺失 —— 需要先在 easy-stock/frontend 跑一次 <code>npm run build</code>'}
</div>
<div class="status warn">产物目录：<code>${dist}</code></div>
<a class="btn" href="${PREFIX}/">重新尝试</a>
</div>
<script>
  // 打开页面即自动轮询几次，后端起来后自动刷新（只对本机有意义）
  var tries = 0;
  function poll() {
    tries += 1;
    fetch('${PREFIX}/api/health', { cache: 'no-store' })
      .then(function (r) { if (r.ok) location.reload(); else throw 0; })
      .catch(function () { if (tries < 20) setTimeout(poll, 1500); });
  }
  setTimeout(poll, 800);
</script>
</body></html>`;
}

/** 静态文件：从 DIST_DIR 取，命中就返回，否则交给 SPA 回退 */
function serveStatic(req, res, relPath) {
  // 防目录穿越
  const safe = path.normalize(relPath).replace(/^(\.\.[\\/])+/, '');
  const abs = path.join(DIST_DIR, safe);
  if (!abs.startsWith(DIST_DIR)) return false;
  let stat;
  try { stat = fs.statSync(abs); } catch (e) { return false; }
  if (!stat.isFile()) return false;

  const ext = path.extname(abs).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8'
  };
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    // 带 hash 的 assets 可以长缓存；index.html 必须每次校验，否则发版后用户还在跑旧代码
    'Cache-Control': /[\\/]assets[\\/]/.test(abs) ? 'public, max-age=31536000, immutable' : 'no-store, no-cache, must-revalidate'
  });
  fs.createReadStream(abs).pipe(res);
  return true;
}

/** SPA 回退：把 index.html 发回去，让前端路由自己处理路径 */
function serveIndex(res) {
  const indexFile = path.join(DIST_DIR, 'index.html');
  let html;
  try { html = fs.readFileSync(indexFile); } catch (e) {
    res.status(503).type('html').send(offlinePage());
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': html.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate'
  });
  res.end(html);
}

function fail(req, res, err) {
  const reason = err && err.code === 'ECONNREFUSED' ? '服务未启动' : (err && err.message) || '未知错误';
  console.warn(`[行情总览] ${req.method} ${req.originalUrl} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT} 失败：${reason}`);
  if (res.headersSent) { res.end(); return; }
  if (String(req.originalUrl).indexOf(PREFIX + '/api/') === 0) {
    res.status(503).json({ error: '行情总览服务未启动', detail: reason, upstream: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` });
    return;
  }
  res.status(503).type('html').send(offlinePage());
}

/** 把 /overview/xxx 转发到上游 /xxx（API 与 WebSocket 升级都走这里） */
function proxyToUpstream(req, res) {
  const target = upstreamPath(req);
  const headers = Object.assign({}, req.headers);
  headers.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  delete headers['accept-encoding'];   // 让上游按自身能力压缩，避免双重编码

  const upstream = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: target, headers: headers },
    (up) => {
      res.writeHead(up.statusCode || 502, responseHeaders(up));
      up.pipe(res);
    }
  );
  upstream.setTimeout(UPSTREAM_TIMEOUT, () => upstream.destroy(new Error('上游响应超时')));
  upstream.on('error', (err) => fail(req, res, err));

  const parsed = req.body !== undefined && req.body !== null
    && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && !(req.body instanceof Uint8Array);
  if (parsed) {
    const payload = Buffer.from(JSON.stringify(req.body), 'utf8');
    headers['content-type'] = headers['content-type'] || 'application/json';
    headers['content-length'] = String(payload.length);
    upstream.end(payload);
  } else if (req.method === 'GET' || req.method === 'HEAD') {
    upstream.end();
  } else {
    req.pipe(upstream);
    req.on('error', () => upstream.destroy());
  }
}

/** WebSocket 升级：easy-stock 的实时行情推送走 /api/v1/ws/stream */
function proxyUpgrade(req, socket, head) {
  const target = upstreamPath(req);
  const headers = Object.assign({}, req.headers);
  headers.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;

  const upstream = http.request({
    host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: 'GET', path: target, headers: headers
  });
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      Object.keys(upRes.headers).map((k) => `${k}: ${upRes.headers[k]}`).join('\r\n') +
      '\r\n\r\n'
    );
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
    upSocket.on('close', () => socket.destroy());
    socket.on('close', () => upSocket.destroy());
  });
  upstream.on('response', (r) => {
    // 上游不支持升级（例如返回 404），直接把状态回给客户端后断开
    r.resume();
    socket.destroy();
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
}

/**
 * 挂载到 Express app。**必须放在 express.json() 之前**（原因见文件头）。
 */
function mount(app, options) {
  const opts = options || {};
  const auth = opts.auth || null;

  // 前端静态资源目录提示（只提示，不阻止启动 —— 用户可能还没 build）
  const hasDist = fs.existsSync(path.join(DIST_DIR, 'index.html'));
  if (!hasDist) {
    console.warn(`  [行情总览] 前端产物缺失：${DIST_DIR}`);
    console.warn('             先在 easy-stock/frontend 跑 npm run build，或设置 OVERVIEW_DIST 指向 dist 目录');
  }

  // —— 健康检查（只对本机开放，供页面引导与排障）
  app.get('/api/overview/status', (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: '仅本机可访问' });
    probe((healthy) => res.json({
      healthy: healthy,
      upstream: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
      dist: DIST_DIR,
      distReady: hasDist
    }));
  });

  // —— 鉴权闸门：easy-stock 本身没有账号体系，必须在代理层挡住匿名访客。
  //    iframe / 顶层导航带不了 Authorization 头，所以用登录时下发的 httpOnly Cookie 判定；
  //    没注入 auth 模块时（单元测试）退回"仅本机可访问"。
  app.use(PREFIX, function (req, res, next) {
    if (auth) {
      const user = auth.userFromCookie(req);
      if (user) { req.user = user; return next(); }
    } else if (isLocalRequest(req)) {
      return next();
    }
    if (wantsHtml(req)) {
      return res.status(401).type('html').send(
        `<!doctype html><meta charset="utf-8"><title>需要登录</title>
         <div style="font-family:sans-serif;padding:60px;text-align:center">
           <h2>需要登录</h2><p>行情总览需要先在交易台登录。</p>
           <a href="/">前往交易台登录</a>
         </div>`
      );
    }
    return res.status(401).json({ ok: false, error: '需要登录后才能访问行情总览' });
  });

  // —— 主体路由
  app.use(PREFIX, function (req, res) {
    // /overview 没有结尾斜杠时先补上，否则相对路径资源（./assets/..）会解析到根目录
    const pathOnly = req.originalUrl.split('?')[0];
    if (pathOnly === PREFIX) {
      const query = req.originalUrl.slice(pathOnly.length);
      res.redirect(301, PREFIX + '/' + query);
      return;
    }

    // 剩余路径一律用 express 算好的 req.url，不用 originalUrl.slice(PREFIX.length)（见 upstreamPath 注释）
    const rel = upstreamPath(req);
    const relPath = rel.split('?')[0];
    if (process.env.OVERVIEW_DEBUG) {
      console.warn(`[行情总览][debug] ${req.method} ${req.originalUrl} -> rel=${rel}`);
    }

    // 1) API：全部转发给 Go 后端
    if (relPath.indexOf('/api/') === 0) return proxyToUpstream(req, res);

    // 2) 静态文件：命中 dist 里的真实文件就直接返回
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (relPath !== '/' && serveStatic(req, res, relPath.replace(/^\/+/, ''))) return;
      // 3) SPA 回退（前端是 History 路由，刷新子路径要能回到 index.html）
      return serveIndex(res);
    }

    // 4) 其它方法（POST/PUT/DELETE）若没命中 API，仍然转给上游，交由其路由决定
    return proxyToUpstream(req, res);
  });

  console.log(`  行情总览入口：http://localhost:${process.env.PORT || 3000}${PREFIX}/  ->  ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
}

module.exports = {
  mount,
  PREFIX,
  UPSTREAM_HOST,
  UPSTREAM_PORT,
  DIST_DIR,
  probe
};
