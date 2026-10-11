/**
 * 轻量级 JWT 认证模块
 *
 * 设计说明：
 * - 使用 Node 内置 crypto 模块实现 HS256 算法的 JWT，无需引入 jsonwebtoken 包
 * - 输出格式与标准 JWT (RFC 7519) 完全兼容，可被 jsonwebtoken 包校验
 * - 后续如需切换到 jsonwebtoken 包，仅需替换 sign/verify 内部实现，调用方无需改动
 *
 * 安全要点：
 * - JWT_SECRET 取值顺序：环境变量 → 本机持久化密钥文件 → 随机临时密钥（仅降级）
 * - ★ 绝不使用硬编码默认值：代码是公开的，写死的密钥等于公开签发权，
 *   任何人都能伪造任意用户（含管理员）的 token，从而绕过全部鉴权。
 * - 使用 crypto.timingSafeEqual 防止时序攻击
 * - token 默认有效期 7 天
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 本机持久化密钥文件（已 gitignore）。首次生成后固定不变，
// 保证服务重启后已签发的 token 依然有效，且每个部署环境各不相同。
const JWT_SECRET_FILE = path.join(__dirname, '.jwt-secret');

function loadOrCreateSecret() {
  var fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  // 优先复用本机已生成的密钥
  try {
    var saved = fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch (e) { /* 文件不存在或不可读，继续生成 */ }

  var generated = crypto.randomBytes(48).toString('hex');
  try {
    fs.writeFileSync(JWT_SECRET_FILE, generated, { mode: 0o600 });
    console.log('[auth] 已生成本机专用 JWT 密钥：' + JWT_SECRET_FILE);
    console.log('[auth] 如需多机共用同一密钥（如负载均衡），请通过环境变量 JWT_SECRET 注入。');
  } catch (e) {
    console.warn('[auth] 无法写入密钥文件（' + e.message + '），本次使用临时密钥；');
    console.warn('[auth] 进程重启后所有已签发的 token 都会失效，请检查目录写权限。');
  }
  return generated;
}

const JWT_SECRET = loadOrCreateSecret();

const JWT_EXPIRES_IN = 7 * 24 * 60 * 60; // 7 天，单位：秒

function base64UrlEncode(input) {
  var buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str) {
  var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

// 签发 JWT；payload 为对象，如 { userId, username, role }
function sign(payload, options) {
  var expiresIn = (options && options.expiresIn) || JWT_EXPIRES_IN;
  var now = Math.floor(Date.now() / 1000);
  var fullPayload = Object.assign({}, payload, { iat: now, exp: now + expiresIn });
  var header = { alg: 'HS256', typ: 'JWT' };
  var headerB64 = base64UrlEncode(JSON.stringify(header));
  var payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
  var data = headerB64 + '.' + payloadB64;
  var sig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest();
  var sigB64 = base64UrlEncode(sig);
  return data + '.' + sigB64;
}

// 校验 JWT；成功返回 payload，失败抛错
function verify(token) {
  if (!token || typeof token !== 'string') throw new Error('token 为空');
  var parts = token.split('.');
  if (parts.length !== 3) throw new Error('token 格式错误');
  var headerB64 = parts[0], payloadB64 = parts[1], sigB64 = parts[2];
  var data = headerB64 + '.' + payloadB64;
  var expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest();
  var actualSig = base64UrlDecode(sigB64);
  if (expectedSig.length !== actualSig.length ||
      !crypto.timingSafeEqual(expectedSig, actualSig)) {
    throw new Error('签名校验失败');
  }
  var payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  } catch (e) {
    throw new Error('payload 解析失败');
  }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error('token 已过期');
  }
  return payload;
}

// ===== Cookie 会话（供 iframe 内嵌的研报库鉴权使用）=====
// iframe 的导航请求无法携带 Authorization 头，只能用同源 Cookie 传递登录态。
// 采用 httpOnly + SameSite=Lax，降低 XSS 窃取与 CSRF 风险。
const SESSION_COOKIE = 'tm_session';

function parseCookies(header) {
  var out = {};
  var raw = String(header || '');
  if (!raw) return out;
  raw.split(';').forEach(function (part) {
    var idx = part.indexOf('=');
    if (idx < 0) return;
    var k = part.slice(0, idx).trim();
    var v = part.slice(idx + 1).trim();
    if (!k) return;
    try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; }
  });
  return out;
}

function setSessionCookie(res, token) {
  // 与 JWT 有效期一致（7 天）；生产环境走 HTTPS 时由 COOKIE_SECURE=1 打开 Secure
  var secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    SESSION_COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + JWT_EXPIRES_IN + secure);
}

function clearSessionCookie(res) {
  var secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secure);
}

// 从 Cookie 中取会话并校验；失败返回 null（不抛异常）
function userFromCookie(req) {
  var cookies = parseCookies(req.headers && req.headers.cookie);
  var token = cookies[SESSION_COOKIE];
  if (!token) return null;
  try { return verify(token); } catch (e) { return null; }
}

// 必须认证：从 Authorization: Bearer <token> 头部解析并挂载到 req.user
function authMiddleware(req, res, next) {
  var authHeader = req.headers.authorization || '';
  var token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  // 回退到 Cookie：便于 iframe 内嵌页面等无法自定义请求头的场景
  if (!token) {
    var fromCookie = userFromCookie(req);
    if (fromCookie) { req.user = fromCookie; return next(); }
    return res.status(401).json({ error: '未提供认证 token，请先登录' });
  }
  try {
    req.user = verify(token);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'token 无效或已过期：' + e.message });
  }
}

// 可选认证：有 token 就挂载 req.user，无 token 也放行（用于平滑迁移期）
function optionalAuthMiddleware(req, res, next) {
  var authHeader = req.headers.authorization || '';
  var token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (token) {
    try { req.user = verify(token); } catch (e) { /* 忽略，保持未登录 */ }
  }
  next();
}

// 资源所有权校验：用户只能访问自己的资源，管理员可访问任意资源
function requireSelfOrAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: '未认证' });
  }
  var targetUserId = req.params.userId;
  if (String(req.user.userId) !== String(targetUserId) && req.user.role !== 'admin') {
    return res.status(403).json({ error: '无权访问他人数据' });
  }
  next();
}

// 保留 setDb 以兼容 server.js 的调用。当前鉴权逻辑已完全基于 token，
// 不再需要查库（原先只有 adminId 兼容分支会用到）。
function setDb(dbInstance) { /* 目前无需使用，保留签名避免破坏调用方 */ }

// 管理员权限校验：只认 token 中的 role
// ★ 安全修复：已删除历史上「通过 ?adminId=xxx 查询参数」的兼容分支。
//   那个分支只凭一个 userId 就授予管理员身份，而管理员 UUID 本身会通过
//   GET /api/admin/users 等接口泄漏 —— 等于任何人拿到 UUID 即可无凭据查看
//   所有用户数据、删除用户、创建管理员。前端已同步改为携带 Bearer token。
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: '未认证，请先登录' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '权限不足，需要管理员权限' });
  }
  next();
}

module.exports = {
  JWT_SECRET: JWT_SECRET,
  JWT_EXPIRES_IN: JWT_EXPIRES_IN,
  sign: sign,
  verify: verify,
  authMiddleware: authMiddleware,
  optionalAuthMiddleware: optionalAuthMiddleware,
  requireSelfOrAdmin: requireSelfOrAdmin,
  requireAdmin: requireAdmin,
  setDb: setDb,
  // Cookie 会话（iframe 内嵌场景）
  SESSION_COOKIE: SESSION_COOKIE,
  setSessionCookie: setSessionCookie,
  clearSessionCookie: clearSessionCookie,
  userFromCookie: userFromCookie,
  parseCookies: parseCookies
};
