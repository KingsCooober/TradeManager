/**
 * 研报库（Python 服务）反向代理
 * ---------------------------------------------------------------------------
 * 把主站的 /research/* 转发到本机运行的研报库服务（默认 127.0.0.1:8765），
 * 这样研报库与交易台同源、共用 3000 端口，主页点一下就能进。
 *
 * 设计原则：
 *  - 只挂在 /research 前缀下，不碰主站任何既有路由（/api/*、静态资源都不受影响）；
 *  - 上游没启动时返回一个引导页，绝不抛异常、绝不阻塞主站；
 *  - 全部用 Node 内置 http 模块，不新增任何 npm 依赖。
 *
 * 环境变量：
 *  RESEARCH_PORT   研报库端口，默认 8765
 *  RESEARCH_HOST   研报库主机，默认 127.0.0.1
 *  RESEARCH_PATH   挂载前缀，默认 /research
 */

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const UPSTREAM_HOST = process.env.RESEARCH_HOST || '127.0.0.1';
const UPSTREAM_PORT = parseInt(process.env.RESEARCH_PORT, 10) || 8765;
const PREFIX = (process.env.RESEARCH_PATH || '/research').replace(/\/+$/, '') || '/research';
const UPSTREAM_TIMEOUT = 15000;

/** 上游不可用时的引导页 */
function offlinePage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>正在启动研报库…</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
         background:#f4f5f7; color:#1a1f2b; }
  .card { background:#fff; border-radius:14px; padding:32px 36px; max-width:640px;
          box-shadow:0 4px 24px rgba(16,24,40,.10); }
  h1 { margin:0 0 6px; font-size:20px; }
  p { margin:0 0 14px; color:#5b6472; font-size:14px; line-height:1.8; }
  code, pre { font-family:"SF Mono",Menlo,Consolas,monospace; }
  pre { background:#eceef2; padding:12px 14px; border-radius:8px; font-size:13px;
        overflow-x:auto; margin:0 0 14px; line-height:1.7; }
  .hint { font-size:12.5px; color:#8b93a1; }
  .row { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  button.btn { padding:9px 18px; border:0; border-radius:8px; background:#2f5bd7; color:#fff;
               font-size:14px; cursor:pointer; font-family:inherit; }
  button.btn[disabled] { opacity:.6; cursor:default; }
  a.btn { color:#2f5bd7; font-size:13px; }
  #status { font-size:13px; color:#5b6472; }
  .spin { display:inline-block; width:12px; height:12px; border:2px solid #d6dae2;
          border-top-color:#2f5bd7; border-radius:50%; animation:sp .7s linear infinite;
          vertical-align:-2px; margin-right:6px; }
  @keyframes sp { to { transform:rotate(360deg); } }
</style>
</head>
<body>
  <div class="card">
    <h1>📑 研报库正在启动 / 启动失败</h1>
    <p>研报库会随交易台一起自动启动，正常情况下不该看到这个页面。当前可能是首次启动正在装
       Python 依赖（约十几秒），或启动失败。下面会自动重试，也可以点按钮手动拉起。</p>
    <div class="row">
      <button class="btn" id="startBtn" onclick="startResearch()">🚀 启动研报库</button>
      <span id="status">准备中…</span>
      <a class="btn" href="${PREFIX}/">手动刷新</a>
    </div>
    <p class="hint" style="margin-top:16px">自动启动不可用时，手动执行：</p>
    <pre>cd research-hub &amp;&amp; ./run.sh</pre>
    <p class="hint">也可以在主站目录执行 <code>npm run research</code> 或 <code>npm run start:all</code>；
       改端口用 <code>RESEARCH_PORT=9000 ./run.sh</code>。</p>
  </div>
<script>
  var btn = document.getElementById('startBtn');
  var statusEl = document.getElementById('status');
  var pollTimer = null;
  var tries = 0;

  function poll() {
    fetch('/api/research/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.healthy) {
          statusEl.textContent = '已就绪，正在进入…';
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          location.reload();
        }
      })
      .catch(function () {});
  }

  function ensureStarted() {
    tries += 1;
    fetch('/api/research/start', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.healthy) { location.reload(); return; }
        if (d && d.error) {
          statusEl.textContent = d.error;
          btn.disabled = false;
          return;
        }
        statusEl.innerHTML = '<span class="spin"></span>' + ((d && d.message) || '正在启动…');
        if (!pollTimer) pollTimer = setInterval(poll, 1500);
        // 服务端有冷却，命中冷却时只是提示"稍候"；这里过几秒再试，直到起来为止
        if (tries < 10) setTimeout(ensureStarted, 6000);
      })
      .catch(function () {
        statusEl.textContent = '无法连接主站，请手动启动（见下方命令）';
        btn.disabled = false;
      });
  }

  btn.addEventListener('click', function () {
    btn.disabled = true;
    statusEl.innerHTML = '<span class="spin"></span>正在启动…';
    tries = 0;
    ensureStarted();
  });

  // 打开本页即自动尝试（只有本机访问才会被主站接受）
  setTimeout(ensureStarted, 400);
</script>
</body>
</html>`;
}

/** 请求是否来自本机（自动启动只对本机开放） */
function isLocalRequest(req) {
  const raw = (req.socket && req.socket.remoteAddress) || req.ip || '';
  const ip = String(raw).replace(/^::ffff:/, '');
  const local = ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
  if (!local) return false;
  // 反向代理场景：nginx 会把客户端 IP 放进 X-Forwarded-For，
  // 此时 req.ip 会退化成 127.0.0.1，必须靠这个头把外部请求挡掉
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().replace(/^::ffff:/, '');
  if (xff && xff !== '127.0.0.1' && xff !== '::1') return false;
  const realIp = String(req.headers['x-real-ip'] || '').trim();
  if (realIp && realIp !== '127.0.0.1' && realIp !== '::1') return false;
  return true;
}

/** 探一下上游是否活着 */
function probe(callback) {
  const req = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: 'GET', path: '/health', timeout: 2000 },
    (res) => { res.resume(); callback(res.statusCode === 200); }
  );
  req.setTimeout(2000, () => req.destroy());
  req.on('error', () => callback(false));
  req.end();
}

/* ---------------------------------------------------------------------------
 * 研报库进程托管：随交易台一起启动、退出时一起关闭、意外挂掉自动重启。
 * 默认开启；RESEARCH_AUTOSTART=0 可关闭，require.main !== module 时也不启动（例如被测试 require）。
 * ------------------------------------------------------------------------- */
let child = null;
let restarts = 0;
let shuttingDown = false;
let lastStartAt = 0;
let childStartedAt = 0;
let lastStartError = '';
const MAX_RESTARTS = 5;
const RESTART_DELAY = 5000;
const START_COOLDOWN = 8000;    // 手动触发时的冷却，防连点

function serviceRunning() {
  return !!child && child.exitCode === null && !child.killed;
}

function stopService() {
  shuttingDown = true;
  if (serviceRunning()) {
    try { child.kill('SIGTERM'); } catch (e) { /* 忽略 */ }
  }
}

/** 启动研报库子进程。非 detached —— 交易台退出时它随之一并结束，不留孤儿进程。 */
function startService(reason) {
  if (shuttingDown || serviceRunning()) return { started: false, message: '已在运行' };
  lastStartAt = Date.now();
  lastStartError = '';
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'start-research.sh');
  const logPath = path.join(__dirname, 'research.log');
  try {
    const out = fs.openSync(logPath, 'a');
    child = spawn('bash', [script, '--port', String(UPSTREAM_PORT), '--no-browser'], {
      cwd: root,
      stdio: ['ignore', out, out],
      env: Object.assign({}, process.env, { RESEARCH_PORT: String(UPSTREAM_PORT) })
    });
    child.on('error', (err) => {
      lastStartError = err.message;
      console.warn(`[研报库] 启动失败（${reason}）：${err.message}`);
    });
    childStartedAt = Date.now();
    child.on('exit', (code, signal) => {
      child = null;
      if (shuttingDown) return;
      console.warn(`[研报库] 进程退出 (code=${code}, signal=${signal || '-'})`);
      // 跑够一段时间才退出，说明不是启动失败的死循环（例如运维重启/推送数据后重启），
      // 这时把重启计数清零，避免"重启 5 次就永久放弃"
      if (Date.now() - childStartedAt > 60000) restarts = 0;
      if (restarts < MAX_RESTARTS) {
        restarts += 1;
        console.warn(`[研报库] ${RESTART_DELAY / 1000} 秒后自动重启（第 ${restarts}/${MAX_RESTARTS} 次）`);
        setTimeout(() => startService('自动重启'), RESTART_DELAY);
      } else {
        console.warn('[研报库] 重启次数过多，已停止自动重启；可访问 /research/ 手动重试');
      }
    });
    console.log(`  研报库进程已拉起（${reason}），日志：server/research.log`);
    return { started: true, message: '正在启动研报库…' };
  } catch (e) {
    lastStartError = e.message;
    console.warn(`[研报库] 启动异常：${e.message}`);
    return { started: false, message: `启动失败：${e.message}` };
  }
}

// 交易台退出时带走子进程（加了 SIGINT/SIGTERM 监听后必须自己 exit，否则默认退出行为会失效）
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => { stopService(); process.exit(0); });
});
process.on('exit', stopService);

function wantsHtml(req) {
  // 按路径判断最可靠：/research/api/* 一律回 JSON，其余（页面、静态资源）给引导页。
  // 不用 Accept 头 —— 浏览器 fetch 默认发 Accept: */*，容易把 API 误判成页面。
  const pathOnly = (req.originalUrl.split('?')[0] || '').slice(PREFIX.length) || '/';
  return !pathOnly.startsWith('/api/');
}

function fail(req, res, err) {
  const reason = err && err.code === 'ECONNREFUSED' ? '服务未启动' : (err && err.message) || '未知错误';
  console.warn(`[研报库] ${req.method} ${req.originalUrl} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT} 失败：${reason}`);
  if (res.headersSent) { res.end(); return; }
  if (!wantsHtml(req)) {
    res.status(503).json({ ok: false, error: '研报库服务未启动', detail: reason, upstream: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` });
    return;
  }
  res.status(503).type('html').send(offlinePage());
}

/**
 * 把 /research/xxx 转发到上游 /xxx
 */
function handle(req, res) {
  // /research 没有结尾斜杠时先补上，否则页面里的相对路径（style.css / app.js）会解析错
  const pathOnly = req.originalUrl.split('?')[0];
  if (pathOnly === PREFIX) {
    const query = req.originalUrl.slice(pathOnly.length);
    res.redirect(301, PREFIX + '/' + query);
    return;
  }

  const target = req.originalUrl.slice(PREFIX.length) || '/';
  const headers = Object.assign({}, req.headers);
  headers.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  // 让上游按自身能力返回内容类型
  delete headers['accept-encoding'];

  const upstream = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: target, headers: headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );

  upstream.setTimeout(UPSTREAM_TIMEOUT, () => {
    upstream.destroy(new Error('上游响应超时'));
  });
  upstream.on('error', (err) => fail(req, res, err));

  // 请求体透传。注意两种情况：
  //   1) 代理挂在 express.json() 之前 —— req 未被消费，直接 pipe；
  //   2) 万一被别的中间件解析过 —— req.body 已有值，此时 pipe 会发出空 body，
  //      必须重新序列化，否则上游会一直等 body 直到超时（写操作全废）。
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

/**
 * 挂载到 Express app 上。放在静态中间件之前：public/ 下没有 research 目录，不会冲突。
 *
 * 额外提供两个**只对本机开放**的接口，让「点入口就自动拉起研报库」成为可能：
 *   GET  /api/research/status  -> { healthy, upstream, port }
 *   POST /api/research/start   -> 拉起研报库进程（带冷却），返回启动状态
 * 它们不在 /research 前缀下，因此不会被代理逻辑吞掉；外部 IP 一律 403。
 */
function mount(app, options) {
  const opts = options || {};

  // —— 随交易台一起启动（默认开；被测试 require、或显式关闭时不启动）
  const autostart = opts.autostart !== false && process.env.RESEARCH_AUTOSTART !== '0';
  if (autostart) {
    probe((healthy) => {
      if (healthy) {
        console.log(`  研报库已在运行（${UPSTREAM_HOST}:${UPSTREAM_PORT}），直接复用`);
      } else {
        startService('随交易台启动');
      }
    });
  } else {
    console.log('  研报库自动启动已关闭（RESEARCH_AUTOSTART=0）');
  }

  // —— 自动启动/重试接口（只对本机开放）
  app.get('/api/research/status', (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: '仅本机可访问' });
    probe((healthy) => res.json({
      healthy: healthy,
      managed: serviceRunning(),
      upstream: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
      port: UPSTREAM_PORT,
      lastError: lastStartError || ''
    }));
  });

  app.post('/api/research/start', (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: '仅本机可访问，请手动启动研报库' });
    if (process.env.RESEARCH_AUTOSTART === '0') {
      return res.json({ healthy: false, error: '已通过 RESEARCH_AUTOSTART=0 关闭自动启动' });
    }
    probe((healthy) => {
      if (healthy) return res.json({ healthy: true, message: '研报库已在运行' });
      if (serviceRunning()) {
        return res.json({ healthy: false, spawned: false, message: '正在启动研报库…' });
      }
      if (Date.now() - lastStartAt < START_COOLDOWN) {
        return res.json({ healthy: false, spawned: false, message: '刚刚已经尝试启动，请稍候…' });
      }
      restarts = 0;                       // 手动重试时重置重启计数
      const r = startService('手动触发');
      if (lastStartError) return res.json({ healthy: false, error: `启动失败：${lastStartError}` });
      res.json({ healthy: false, spawned: r.started, message: r.message });
    });
  });

  app.use(PREFIX, handle);   // app.use 已同时覆盖 /research 与 /research/xxx
  console.log(`  研报库入口：http://localhost:${process.env.PORT || 3000}${PREFIX}/  ->  ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
}

module.exports = { mount, stopService, PREFIX, UPSTREAM_HOST, UPSTREAM_PORT };
