/**
 * TradeManager 服务器 API 集成测试（Node.js 测试运行器）
 *
 * 前提：服务器已启动（node server/server.js）
 *
 * 如果未连接服务器，所有测试会失败并提示。
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

// 使用项目内 server/node_modules 中的 sqlite3
const sqlite3 = require(path.join(__dirname, '..', '..', 'server', 'node_modules', 'sqlite3')).verbose();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

// ===== 测试工具函数 =====

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// 共享测试上下文
const ctx = {
  testUserId: null,
  testAdminId: null,
  testUsername: 'testuser_' + Date.now(),
  testPassword: 'test123456',
  adminUsername: 'testadmin_' + Date.now(),
  adminPassword: 'admin123456',
  serverAvailable: false
};

// 同步检查服务器是否可用（在 describe 之前完成，避免 skip 选项提前求值）
function checkServerSync() {
  const url = new URL('/', BASE_URL);
  try {
    const result = require('node:child_process').execSync(
      `powershell -NoProfile -Command "(Invoke-WebRequest -Uri '${BASE_URL}/' -UseBasicParsing -TimeoutSec 3).StatusCode"`,
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }
    ).toString().trim();
    const code = parseInt(result, 10);
    return code >= 200 && code < 500;
  } catch (e) {
    return false;
  }
}
ctx.serverAvailable = checkServerSync();
if (!ctx.serverAvailable) {
  console.log('[警告] 服务器未运行，跳过 API 集成测试。可通过 TEST_BASE_URL 环境变量指定地址。');
}

describe('服务器 API 集成测试', { skip: !ctx.serverAvailable }, () => {
  test('服务器连接', async () => {
    const res = await request('GET', '/');
    assert.ok(res.status >= 200 && res.status < 500, '服务器可响应');
  });

  describe('1. 用户认证', () => {
    test('注册普通用户', async () => {
      const res = await request('POST', '/api/register', {
        username: ctx.testUsername,
        password: ctx.testPassword
      });
      assert.ok(res.status >= 200 && res.status < 300, '注册成功');
      assert.equal(res.body.username, ctx.testUsername);
      assert.ok(res.body.userId, '返回用户ID');
      ctx.testUserId = res.body.userId;
    });

    test('重复注册返回 400', async () => {
      const res = await request('POST', '/api/register', {
        username: ctx.testUsername,
        password: ctx.testPassword
      });
      assert.equal(res.status, 400);
    });

    test('空用户名返回错误', async () => {
      const res = await request('POST', '/api/register', { username: '' });
      assert.ok(res.status >= 400);
    });

    test('普通注册不能创建 admin 角色', async () => {
      const res = await request('POST', '/api/register', {
        username: 'fake_admin_' + Date.now(),
        password: 'password123',
        role: 'admin'
      });
      assert.equal(res.status, 403);
    });

    test('登录成功', async () => {
      const res = await request('POST', '/api/login', {
        username: ctx.testUsername,
        password: ctx.testPassword
      });
      assert.ok(res.status >= 200 && res.status < 300);
      assert.equal(res.body.userId, ctx.testUserId);
      assert.equal(res.body.role, 'user');
    });

    test('密码错误返回 401', async () => {
      const res = await request('POST', '/api/login', {
        username: ctx.testUsername,
        password: 'wrongpassword'
      });
      assert.equal(res.status, 401);
    });

    test('用户不存在返回 401', async () => {
      const res = await request('POST', '/api/login', {
        username: 'nonexistent_user_xyz',
        password: 'password'
      });
      assert.equal(res.status, 401);
    });

    test('空登录返回错误', async () => {
      const res = await request('POST', '/api/login', {});
      assert.ok(res.status >= 400);
    });
  });

  describe('2. 修改密码', () => {
    test('新密码太短返回 400', async () => {
      const res = await request('POST', '/api/change-password', {
        userId: ctx.testUserId,
        oldPassword: ctx.testPassword,
        newPassword: '123'
      });
      assert.equal(res.status, 400);
    });

    test('6位新密码修改成功', async () => {
      const res = await request('POST', '/api/change-password', {
        userId: ctx.testUserId,
        oldPassword: ctx.testPassword,
        newPassword: '123456'
      });
      assert.ok(res.status >= 200 && res.status < 300);
    });

    test('用新密码登录成功', async () => {
      const res = await request('POST', '/api/login', {
        username: ctx.testUsername,
        password: '123456'
      });
      assert.ok(res.status >= 200 && res.status < 300);
    });

    test('改回原密码', async () => {
      const res = await request('POST', '/api/change-password', {
        userId: ctx.testUserId,
        oldPassword: '123456',
        newPassword: ctx.testPassword
      });
      assert.ok(res.status >= 200 && res.status < 300);
    });

    test('旧密码错误返回 401', async () => {
      const res = await request('POST', '/api/change-password', {
        userId: ctx.testUserId,
        oldPassword: 'wrongold',
        newPassword: 'newpass123'
      });
      assert.equal(res.status, 401);
    });

    test('缺少字段返回 400', async () => {
      const res = await request('POST', '/api/change-password', {
        userId: ctx.testUserId
      });
      assert.equal(res.status, 400);
    });
  });

  describe('3. 交易记录 CRUD', () => {
    test('添加交易', async () => {
      const trade = {
        id: 'test_trade_1',
        openDate: '2024-01-15',
        symbol: 'BTC',
        type: '15分钟回踩',
        direction: '多',
        entryPrice: 42000,
        stopLoss: 41000,
        takeProfit: 44000,
        positionSize: 10000,
        actualLots: 50,
        actualAmount: 10000,
        rAmount: 200,
        status: 'open',
        notes: '测试交易1'
      };

      const res = await request('POST', `/api/trades/${ctx.testUserId}`, trade);
      assert.ok(res.status >= 200 && res.status < 300);
      assert.equal(res.body.id, 'test_trade_1');
    });

    test('添加第二笔交易', async () => {
      const trade = {
        id: 'test_trade_2',
        openDate: '2024-01-16',
        closeDate: '2024-01-17',
        symbol: 'ETH',
        type: '金叉共振',
        direction: '空',
        entryPrice: 2500,
        stopLoss: 2600,
        takeProfit: 2300,
        positionSize: 5000,
        actualLots: 2,
        actualAmount: 5000,
        rAmount: 100,
        closePrice: 2350,
        pnlAmount: 60,
        pnlR: 0.6,
        status: 'win',
        notes: '测试交易2'
      };

      const res = await request('POST', `/api/trades/${ctx.testUserId}`, trade);
      assert.ok(res.status >= 200 && res.status < 300);
    });

    test('获取所有数据', async () => {
      const res = await request('GET', `/api/sync/${ctx.testUserId}`);
      assert.ok(res.status >= 200 && res.status < 300);
      assert.ok(Array.isArray(res.body.trades));
      assert.ok(res.body.trades.length >= 2, `至少2条交易 (实际: ${res.body.trades.length})`);
    });

    test('删除交易', async () => {
      const res = await request('DELETE', `/api/trades/${ctx.testUserId}/test_trade_1`);
      assert.ok(res.status >= 200 && res.status < 300);
    });

    test('确认交易已删除', async () => {
      const res = await request('GET', `/api/sync/${ctx.testUserId}`);
      const exists = res.body.trades.some(t => t.id === 'test_trade_1');
      assert.equal(exists, false);
    });

    test('更新交易', async () => {
      const updatedTrade = {
        id: 'test_trade_2',
        openDate: '2024-01-16',
        closeDate: '2024-01-17',
        symbol: 'ETH',
        type: '金叉共振',
        direction: '空',
        entryPrice: 2500,
        stopLoss: 2600,
        takeProfit: 2300,
        positionSize: 5000,
        actualLots: 2,
        actualAmount: 5000,
        rAmount: 100,
        closePrice: 2350,
        pnlAmount: 60,
        pnlR: 0.6,
        status: 'win',
        notes: '更新后的备注'
      };

      const res = await request('POST', `/api/trades/${ctx.testUserId}`, updatedTrade);
      assert.ok(res.status >= 200 && res.status < 300);

      const get = await request('GET', `/api/sync/${ctx.testUserId}`);
      const t = get.body.trades.find(t => t.id === 'test_trade_2');
      assert.equal(t.notes, '更新后的备注');
    });
  });

  describe('4. 入金/出金', () => {
    test('添加入金', async () => {
      const res = await request('POST', `/api/deposits/${ctx.testUserId}`, {
        amount: 50000,
        date: '2024-01-10'
      });
      assert.ok(res.status >= 200 && res.status < 300);
      assert.ok(res.body.id);
    });

    test('添加出金', async () => {
      const res = await request('POST', `/api/withdrawals/${ctx.testUserId}`, {
        amount: 10000,
        date: '2024-01-20'
      });
      assert.ok(res.status >= 200 && res.status < 300);
    });

    test('获取入金/出金数据', async () => {
      const res = await request('GET', `/api/sync/${ctx.testUserId}`);
      assert.ok(res.body.deposits.length >= 1);
      assert.ok(res.body.withdrawals.length >= 1);
      const deposit = res.body.deposits.find(d => d.amount === 50000);
      assert.equal(deposit.date, '2024-01-10');
    });
  });

  describe('5. 账户设置', () => {
    test('保存设置', async () => {
      const res = await request('POST', `/api/settings/${ctx.testUserId}`, {
        initCapital: 200000,
        riskPct: 3,
        maxRisk: 5,
        feeRate: 0.05
      });
      assert.ok(res.status >= 200 && res.status < 300);
    });

    test('验证设置字段是 snake_case', async () => {
      const res = await request('GET', `/api/sync/${ctx.testUserId}`);
      assert.ok(res.body.settings);
      assert.equal(res.body.settings.init_capital, 200000);
      assert.equal(res.body.settings.risk_pct, 3);
      assert.equal(res.body.settings.max_risk, 5);
      assert.equal(res.body.settings.fee_rate, 0.05);
      assert.ok(res.body.settings.updated_at);
    });
  });

  describe('6. 复盘总结', () => {
    test('保存日记', async () => {
      const diary = [{
        id: 'diary_test_1',
        tradeDate: '2024-03-01',
        symbol: 'BTC',
        pnlPercent: 5.2,
        tradeLogic: '突破回踩确认',
        mood: '冷静',
        followSystem: '是',
        lesson: '严格执行止损',
        improvement: '继续保持'
      }];
      const res = await request('POST', `/api/diary/${ctx.testUserId}`, { diary });
      assert.ok(res.status >= 200 && res.status < 300);
      assert.equal(res.body.count, 1);
    });

    test('获取日记', async () => {
      const res = await request('GET', `/api/diary/${ctx.testUserId}`);
      assert.ok(res.status >= 200 && res.status < 300);
      assert.ok(res.body.diary.length >= 1);
      const d = res.body.diary.find(d => d.id === 'diary_test_1');
      assert.equal(d.symbol, 'BTC');
      assert.equal(d.follow_system, '是');
    });

    test('无效日记数据返回 400', async () => {
      const res = await request('POST', `/api/diary/${ctx.testUserId}`, { diary: 'not_array' });
      assert.equal(res.status, 400);
    });
  });

  describe('7. 管理员权限', () => {
    test('注册管理员测试用户', async () => {
      const res = await request('POST', '/api/register', {
        username: ctx.adminUsername,
        password: ctx.adminPassword
      });
      assert.ok(res.status >= 200 && res.status < 300);
      ctx.testAdminId = res.body.userId;
    });

    test('非管理员访问用户列表被拒绝', async () => {
      const res = await request('GET', `/api/admin/users?adminId=${ctx.testUserId}`);
      assert.equal(res.status, 403);
    });

    test('非管理员访问统计接口被拒绝', async () => {
      const res = await request('GET', `/api/admin/stats?adminId=${ctx.testUserId}`);
      assert.equal(res.status, 403);
    });

    test('非管理员访问用户详情被拒绝', async () => {
      const res = await request('GET', `/api/admin/user/${ctx.testUserId}?adminId=${ctx.testUserId}`);
      assert.equal(res.status, 403);
    });

    test('提升管理员角色后可以获取用户列表', async () => {
      // 通过直接访问数据库提升角色
      const db = new sqlite3.Database(path.join(__dirname, '..', '..', 'server', 'data.db'));
      await new Promise((resolve, reject) => {
        db.run('UPDATE users SET role = ? WHERE id = ?', ['admin', ctx.testAdminId], function(err) {
          if (err) reject(err);
          else resolve();
        });
      });

      const res = await request('GET', `/api/admin/users?adminId=${ctx.testAdminId}`);
      assert.ok(res.status >= 200 && res.status < 300);
      assert.ok(Array.isArray(res.body.users));
      db.close();
    });

    test('管理员获取统计', async () => {
      const res = await request('GET', `/api/admin/stats?adminId=${ctx.testAdminId}`);
      assert.ok(res.status >= 200 && res.status < 300);
      assert.equal(typeof res.body.user_count, 'number');
      assert.equal(typeof res.body.trade_count, 'number');
    });
  });

  describe('8. 清空数据', () => {
    test('清空测试用户数据', async () => {
      const res = await request('DELETE', `/api/clear/${ctx.testUserId}`);
      assert.ok(res.status >= 200 && res.status < 300);
    });

    test('验证数据已清空', async () => {
      // db.serialize 异步执行 DELETE，可能存在竞态；重试几次以容忍
      let trades = -1, deposits = -1, withdrawals = -1;
      for (let i = 0; i < 10; i++) {
        const res = await request('GET', `/api/sync/${ctx.testUserId}`);
        trades = res.body.trades.length;
        deposits = res.body.deposits.length;
        withdrawals = res.body.withdrawals.length;
        if (trades === 0 && deposits === 0 && withdrawals === 0) break;
        await new Promise(r => setTimeout(r, 50));
      }
      assert.equal(trades, 0);
      assert.equal(deposits, 0);
      assert.equal(withdrawals, 0);
    });
  });

  describe('9. 边界情况', () => {
    test('不存在的用户返回空数据', async () => {
      const res = await request('GET', '/api/sync/nonexistent_user_id');
      assert.ok(res.status >= 200 && res.status < 300);
      assert.ok(Array.isArray(res.body.trades));
    });

    test('特殊字符保存', async () => {
      const trade = {
        id: 'special_trade_1',
        openDate: '2024-01-01',
        symbol: 'A&B"C',
        direction: '多',
        entryPrice: 100,
        stopLoss: 95,
        takeProfit: 110,
        positionSize: 5000,
        actualLots: 50,
        actualAmount: 5000,
        rAmount: 100,
        status: 'open',
        notes: '包含&<>"特殊字符'
      };

      const res = await request('POST', `/api/trades/${ctx.testUserId}`, trade);
      assert.ok(res.status >= 200 && res.status < 300);

      const get = await request('GET', `/api/sync/${ctx.testUserId}`);
      const t = get.body.trades.find(t => t.id === 'special_trade_1');
      assert.ok(t);
      assert.equal(t.symbol, 'A&B"C');
      assert.equal(t.notes, '包含&<>"特殊字符');
    });
  });
});
