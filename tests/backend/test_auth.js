/**
 * P0-1 鉴权中间件单元测试
 * 不依赖 sqlite3 / Express，使用 mock 的 req/res 对象验证 auth 模块逻辑
 */
const { test } = require('node:test');
const assert = require('node:assert');
const auth = require('../../server/auth');

// 构造 mock 请求对象
function mockReq(opts) {
  opts = opts || {};
  return {
    headers: opts.headers || {},
    params: opts.params || {},
    query: opts.query || {},
    body: opts.body || {}
  };
}

// 构造 mock 响应对象，记录 status 与 json 返回
function mockRes() {
  var status = null;
  var body = null;
  return {
    status: function(code) { status = code; return this; },
    json: function(data) { body = data; return this; },
    _getStatus: function() { return status; },
    _getBody: function() { return body; }
  };
}

test('authMiddleware: 缺少 Authorization 头应返回 401', async () => {
  await new Promise(function(resolve) {
    var req = mockReq({ headers: {} });
    var res = mockRes();
    auth.authMiddleware(req, res, function() {
      assert.fail('next 不应被调用');
      resolve();
    });
    assert.strictEqual(res._getStatus(), 401);
    assert.match(res._getBody().error, /未提供认证 token/);
    resolve();
  });
});

test('authMiddleware: 有效 Bearer token 应放行并挂载 req.user', async () => {
  await new Promise(function(resolve) {
    var token = auth.sign({ userId: 'u1', username: 'alice', role: 'user' });
    var req = mockReq({ headers: { authorization: 'Bearer ' + token } });
    var res = mockRes();
    auth.authMiddleware(req, res, function() {
      assert.strictEqual(req.user.userId, 'u1');
      assert.strictEqual(req.user.role, 'user');
      resolve();
    });
  });
});

test('authMiddleware: 篡改的 token 应返回 401', async () => {
  await new Promise(function(resolve) {
    var token = auth.sign({ userId: 'u1', username: 'alice', role: 'user' });
    var tampered = token.slice(0, -5) + 'XXXXX';
    var req = mockReq({ headers: { authorization: 'Bearer ' + tampered } });
    var res = mockRes();
    auth.authMiddleware(req, res, function() {
      assert.fail('next 不应被调用');
      resolve();
    });
    assert.strictEqual(res._getStatus(), 401);
    resolve();
  });
});

test('requireSelfOrAdmin: 用户访问自己资源应放行', async () => {
  await new Promise(function(resolve) {
    var req = mockReq({
      params: { userId: 'u1' },
      // 模拟 authMiddleware 已挂载 req.user
    });
    req.user = { userId: 'u1', role: 'user' };
    var res = mockRes();
    auth.requireSelfOrAdmin(req, res, function() {
      resolve();
    });
  });
});

test('requireSelfOrAdmin: 普通用户访问他人资源应返回 403', async () => {
  await new Promise(function(resolve) {
    var req = mockReq({ params: { userId: 'u2' } });
    req.user = { userId: 'u1', role: 'user' };
    var res = mockRes();
    auth.requireSelfOrAdmin(req, res, function() {
      assert.fail('next 不应被调用');
      resolve();
    });
    assert.strictEqual(res._getStatus(), 403);
    assert.match(res._getBody().error, /无权访问/);
    resolve();
  });
});

test('requireSelfOrAdmin: 管理员可访问任意用户资源', async () => {
  await new Promise(function(resolve) {
    var req = mockReq({ params: { userId: 'u_other' } });
    req.user = { userId: 'admin1', role: 'admin' };
    var res = mockRes();
    auth.requireSelfOrAdmin(req, res, function() {
      resolve();
    });
  });
});

test('requireSelfOrAdmin: 未认证应返回 401', async () => {
  await new Promise(function(resolve) {
    var req = mockReq({ params: { userId: 'u1' } });
    req.user = null;
    var res = mockRes();
    auth.requireSelfOrAdmin(req, res, function() {
      assert.fail('next 不应被调用');
      resolve();
    });
    assert.strictEqual(res._getStatus(), 401);
    resolve();
  });
});

test('requireAdmin: token 中的 role=admin 应直接放行', async () => {
  await new Promise(function(resolve) {
    var req = mockReq({ query: {} });
    req.user = { userId: 'admin1', role: 'admin' };
    var res = mockRes();
    auth.requireAdmin(req, res, function() {
      resolve();
    });
  });
});

test('requireAdmin: 无 token 且无 adminId 应返回 403', async () => {
  await new Promise(function(resolve) {
    var req = mockReq({ query: {} });
    req.user = null;  // 无 token
    var res = mockRes();
    auth.requireAdmin(req, res, function() {
      assert.fail('next 不应被调用');
      resolve();
    });
    assert.strictEqual(res._getStatus(), 403);
    assert.match(res._getBody().error, /权限不足/);
    resolve();
  });
});

test('JWT: 含 userId/role/iat/exp 标准字段', () => {
  var token = auth.sign({ userId: 'u1', role: 'user' });
  var payload = auth.verify(token);
  assert.strictEqual(payload.userId, 'u1');
  assert.strictEqual(payload.role, 'user');
  assert.ok(payload.iat > 0, '应包含 iat');
  assert.ok(payload.exp > payload.iat, 'exp 应大于 iat');
  assert.ok(payload.exp - payload.iat === 7 * 24 * 60 * 60, '有效期应为 7 天');
});

test('JWT: 过期 token 应被拒绝', () => {
  // 签发一个立即过期的 token
  var token = auth.sign({ userId: 'u1', role: 'user' }, { expiresIn: -10 });
  assert.throws(function() {
    auth.verify(token);
  }, /已过期/);
});
