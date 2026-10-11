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

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: headers
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
  testUserToken: null,
  testAdminId: null,
  testAdminToken: null,
  testUsername: 'testuser_' + Date.now(),
  testPassword: 'test123456',
  adminUsername: 'testadmin_' + Date.now(),
  adminPassword: 'admin123456',
  serverAvailable: false
};

// 同步检查服务器是否可用（在 describe 之前完成，避免 skip 选项提前求值）
// ★ 用 Node 子进程探测而不是 execSync 调 powershell：
//   之前 execSync 里嵌套引号会被 PowerShell 再剥一层，URL 变成裸的 http://...
//   导致 "Invalid URI: The hostname could not be parsed"，探测永远失败 → 集成测试被跳过。
function checkServerSync() {
  try {
    const { execFileSync } = require('node:child_process');
    const script = [
      'const http=require("node:http");',
      'const u=new URL(process.argv[1]);',
      'const r=http.request({hostname:u.hostname,port:u.port,path:"/",method:"GET",timeout:3000},x=>{x.resume();process.exit(x.statusCode>=200&&x.statusCode<500?0:1);});',
      'r.on("timeout",()=>{r.destroy();process.exit(1);});',
      'r.on("error",()=>process.exit(1));',
      'r.end();'
    ].join('');
    execFileSync(process.execPath, ['-e', script, BASE_URL], { timeout: 6000, stdio: 'ignore' });
    return true;
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

    test('注册接口忽略 role 参数，只创建普通用户（防抢注 admin 提权）', async () => {
      const res = await request('POST', '/api/register', {
        username: 'fake_admin_' + Date.now(),
        password: 'password123',
        role: 'admin'
      });
      // 不再返回 403，而是照常创建账号，但角色被强制为 user
      assert.ok(res.status >= 200 && res.status < 300);
      assert.equal(res.body.role, 'user', '客户端传入的 role 必须被忽略');
    });

    test('登录成功', async () => {
      const res = await request('POST', '/api/login', {
        username: ctx.testUsername,
        password: ctx.testPassword
      });
      assert.ok(res.status >= 200 && res.status < 300);
      assert.equal(res.body.userId, ctx.testUserId);
      assert.equal(res.body.role, 'user');
      assert.ok(res.body.token, '登录应返回 JWT token');
      ctx.testUserToken = res.body.token;
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
      }, ctx.testUserToken);
      assert.equal(res.status, 400);
    });

    test('6位新密码修改成功', async () => {
      const res = await request('POST', '/api/change-password', {
        userId: ctx.testUserId,
        oldPassword: ctx.testPassword,
        newPassword: '123456'
      }, ctx.testUserToken);
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
      }, ctx.testUserToken);
      assert.ok(res.status >= 200 && res.status < 300);
    });

    test('旧密码错误返回 401', async () => {
      const res = await request('POST', '/api/change-password', {
        userId: ctx.testUserId,
        oldPassword: 'wrongold',
        newPassword: 'newpass123'
      }, ctx.testUserToken);
      assert.equal(res.status, 401);
    });

    test('缺少字段返回 400', async () => {
      const res = await request('POST', '/api/change-password', {
        userId: ctx.testUserId
      }, ctx.testUserToken);
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

      const res = await request('POST', `/api/trades/${ctx.testUserId}`, trade, ctx.testUserToken);
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

      const res = await request('POST', `/api/trades/${ctx.testUserId}`, trade, ctx.testUserToken);
      assert.ok(res.status >= 200 && res.status < 300);
    });

    test('获取所有数据', async () => {
      const res = await request('GET', `/api/sync/${ctx.testUserId}`, null, ctx.testUserToken);
      assert.ok(res.status >= 200 && res.status < 300);
      assert.ok(Array.isArray(res.body.trades));
      assert.ok(res.body.trades.length >= 2, `至少2条交易 (实际: ${res.body.trades.length})`);
    });

    test('删除交易', async () => {
      const res = await request('DELETE', `/api/trades/${ctx.testUserId}/test_trade_1`, null, ctx.testUserToken);
      assert.ok(res.status >= 200 && res.status < 300);
    });

    test('确认交易已删除', async () => {
      const res = await request('GET', `/api/sync/${ctx.testUserId}`, null, ctx.testUserToken);
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

      const res = await request('POST', `/api/trades/${ctx.testUserId}`, updatedTrade, ctx.testUserToken);
      assert.ok(res.status >= 200 && res.status < 300);

      const get = await request('GET', `/api/sync/${ctx.testUserId}`, null, ctx.testUserToken);
      const t = get.body.trades.find(t => t.id === 'test_trade_2');
      assert.equal(t.notes, '更新后的备注');
    });
  });

  describe('4. 入金/出金', () => {
    test('添加入金', async () => {
      const res = await request('POST', `/api/deposits/${ctx.testUserId}`, {
        amount: 50000,
        date: '2024-01-10'
      }, ctx.testUserToken);
      assert.ok(res.status >= 200 && res.status < 300);
      assert.ok(res.body.id);
    });

    test('添加出金', async () => {
      const res = await request('POST', `/api/withdrawals/${ctx.testUserId}`, {
        amount: 10000,
        date: '2024-01-20'
      }, ctx.testUserToken);
      assert.ok(res.status >= 200 && res.status < 300);
    });

    test('获取入金/出金数据', async () => {
      const res = await request('GET', `/api/sync/${ctx.testUserId}`, null, ctx.testUserToken);
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
      }, ctx.testUserToken);
      assert.ok(res.status >= 200 && res.status < 300);
    });

    test('验证设置字段是 snake_case', async () => {
      const res = await request('GET', `/api/sync/${ctx.testUserId}`, null, ctx.testUserToken);
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
      const res = await request('POST', `/api/diary/${ctx.testUserId}`, { diary }, ctx.testUserToken);
      assert.ok(res.status >= 200 && res.status < 300);
      assert.equal(res.body.count, 1);
    });

    test('获取日记', async () => {
      const res = await request('GET', `/api/diary/${ctx.testUserId}`, null, ctx.testUserToken);
      assert.ok(res.status >= 200 && res.status < 300);
      assert.ok(res.body.diary.length >= 1);
      const d = res.body.diary.find(d => d.id === 'diary_test_1');
      assert.equal(d.symbol, 'BTC');
      assert.equal(d.follow_system, '是');
    });

    test('无效日记数据返回 400', async () => {
      const res = await request('POST', `/api/diary/${ctx.testUserId}`, { diary: 'not_array' }, ctx.testUserToken);
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
      // 携带普通用户的 token，应被 403 拒绝
      const res = await request('GET', '/api/admin/users', null, ctx.testUserToken);
      assert.equal(res.status, 403);
    });

    test('仅凭 adminId 查询参数已无法获得管理员权限（旧兼容分支已移除）', async () => {
      const res = await request('GET', `/api/admin/users?adminId=${ctx.testAdminId}`);
      // 无 token → 401；带普通用户 token → 403。都不再放行。
      assert.ok(res.status === 401 || res.status === 403, '不应放行，实际: ' + res.status);
    });

    test('非管理员访问统计接口被拒绝', async () => {
      const res = await request('GET', '/api/admin/stats', null, ctx.testUserToken);
      assert.equal(res.status, 403);
    });

    test('非管理员访问用户详情被拒绝', async () => {
      const res = await request('GET', `/api/admin/user/${ctx.testUserId}`, null, ctx.testUserToken);
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
      db.close();

      // 角色改动只影响之后签发的 token，需重新登录拿新 token
      const login = await request('POST', '/api/login', {
        username: ctx.adminUsername,
        password: ctx.adminPassword
      });
      assert.ok(login.status >= 200 && login.status < 300, '管理员重新登录');
      assert.equal(login.body.role, 'admin');
      ctx.testAdminToken = login.body.token;

      const res = await request('GET', '/api/admin/users', null, ctx.testAdminToken);
      assert.ok(res.status >= 200 && res.status < 300);
      assert.ok(Array.isArray(res.body.users));
    });

    test('管理员获取统计', async () => {
      const res = await request('GET', '/api/admin/stats', null, ctx.testAdminToken);
      assert.ok(res.status >= 200 && res.status < 300);
      assert.equal(typeof res.body.user_count, 'number');
      assert.equal(typeof res.body.trade_count, 'number');
    });
  });

  describe('8. 清空数据', () => {
    test('清空测试用户数据', async () => {
      const res = await request('DELETE', `/api/clear/${ctx.testUserId}`, null, ctx.testUserToken);
      assert.ok(res.status >= 200 && res.status < 300);
    });

    test('验证数据已清空', async () => {
      // db.serialize 异步执行 DELETE，可能存在竞态；重试几次以容忍
      let trades = -1, deposits = -1, withdrawals = -1;
      for (let i = 0; i < 10; i++) {
        const res = await request('GET', `/api/sync/${ctx.testUserId}`, null, ctx.testUserToken);
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
    test('访问他人 userId 应被 403 拒绝（requireSelfOrAdmin 越权防护）', async () => {
      // ★ 原断言期望 200，那是无鉴权时代的语义。
      //   现在该路由挂了 requireSelfOrAdmin：访问非本人 userId 必须被拒绝，
      //   否则等于知道别人的 UUID 就能读他的全部交易数据。
      const res = await request('GET', '/api/sync/nonexistent_user_id', null, ctx.testUserToken);
      assert.ok(res.status === 403 || res.status === 404, '应拒绝越权访问，实际: ' + res.status);
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

      const res = await request('POST', `/api/trades/${ctx.testUserId}`, trade, ctx.testUserToken);
      assert.ok(res.status >= 200 && res.status < 300);

      const get = await request('GET', `/api/sync/${ctx.testUserId}`, null, ctx.testUserToken);
      const t = get.body.trades.find(t => t.id === 'special_trade_1');
      assert.ok(t);
      assert.equal(t.symbol, 'A&B"C');
      assert.equal(t.notes, '包含&<>"特殊字符');
    });
  });
});
