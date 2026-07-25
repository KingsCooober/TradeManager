/**
 * 轻量级 JWT 认证模块
 *
 * 设计说明：
 * - 使用 Node 内置 crypto 模块实现 HS256 算法的 JWT，无需引入 jsonwebtoken 包
 * - 输出格式与标准 JWT (RFC 7519) 完全兼容，可被 jsonwebtoken 包校验
 * - 后续如需切换到 jsonwebtoken 包，仅需替换 sign/verify 内部实现，调用方无需改动
 *
 * 安全要点：
 * - JWT_SECRET 从环境变量读取；未设置时基于机器信息生成稳定密钥（便于本地开发，生产环境务必通过环境变量注入）
 * - 使用 crypto.timingSafeEqual 防止时序攻击
 * - token 默认有效期 7 天
 */
const crypto = require('crypto');
const os = require('os');

// ★ 修复：用固定字符串作为默认 secret，去掉 hostname 依赖
// （之前用 os.hostname() 会导致本地与服务器 secret 不同，本地签的 token 在服务器 401）
// 生产环境强烈建议通过环境变量 JWT_SECRET 注入自己的密钥
const JWT_SECRET = process.env.JWT_SECRET || 'trademanager-fixed-jwt-secret-v1';

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

// 必须认证：从 Authorization: Bearer <token> 头部解析并挂载到 req.user
function authMiddleware(req, res, next) {
  var authHeader = req.headers.authorization || '';
  var token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) {
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

// 内部持有的 db 引用（由 server.js 通过 setDb 注入，避免循环依赖）
var _db = null;
function setDb(dbInstance) { _db = dbInstance; }

// 管理员权限校验：优先用 token 中的 role；兼容旧前端通过 adminId 查询参数
function requireAdmin(req, res, next) {
  // 优先用 token 鉴权
  if (req.user && req.user.role === 'admin') {
    return next();
  }
  // 兼容期：旧前端通过 ?adminId=xxx 传递；需查库校验
  var adminId = req.query.adminId || (req.body && req.body.adminId);
  if (!adminId) {
    return res.status(403).json({ error: '权限不足，需要管理员权限' });
  }
  if (!_db) {
    return res.status(500).json({ error: '数据库未初始化' });
  }
  _db.get('SELECT role FROM users WHERE id = ?', [adminId], function (err, row) {
    if (err) return res.status(500).json({ error: err.message });
    if (!row || row.role !== 'admin') {
      return res.status(403).json({ error: '权限不足，需要管理员权限' });
    }
    // 把管理员身份挂到 req.user，便于后续逻辑
    req.user = { userId: adminId, role: 'admin' };
    next();
  });
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
  setDb: setDb
};
