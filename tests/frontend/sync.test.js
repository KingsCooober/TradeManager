'use strict';

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupBrowserMock, teardownBrowserMock, loadFrontendScripts } = require('../helpers/browser-mock');

describe('sync.js 测试', () => {
  before(() => {
    setupBrowserMock();
  });

  beforeEach(() => {
    if (globalThis.localStorage) {
      globalThis.localStorage.clear();
    }
    loadFrontendScripts(['utils.js', 'sync.js']);
  });

  after(() => {
    teardownBrowserMock();
  });

  describe('setServerUrl() / getServerUrl()', () => {
    test('设置服务器 URL', () => {
      setServerUrl('http://example.com:3000');
      assert.equal(getServerUrl(), 'http://example.com:3000');
    });

    test('自动去除末尾斜杠', () => {
      setServerUrl('http://example.com:3000/');
      assert.equal(getServerUrl(), 'http://example.com:3000');
    });

    test('多个末尾斜杠只去除一个', () => {
      // setServerUrl 使用 url.replace(/\/$/, '') 只去除单个末尾斜杠
      // 'http://example.com:3000//' → 'http://example.com:3000/'
      setServerUrl('http://example.com:3000//');
      assert.equal(getServerUrl(), 'http://example.com:3000/');
    });

    test('URL 被持久化到 localStorage', () => {
      setServerUrl('http://test.local:5000');
      assert.equal(globalThis.localStorage.getItem('sync_server_url'), 'http://test.local:5000');
    });
  });

  describe('isLoggedIn()', () => {
    test('未登录时返回 false', () => {
      assert.equal(isLoggedIn(), false);
    });

    test('已登录时返回 true', () => {
      globalThis.localStorage.setItem('sync_user', JSON.stringify({
        id: 'user-1',
        username: 'testuser',
        role: 'user'
      }));
      // 重新加载 sync.js 让 currentUser 从 localStorage 恢复
      loadFrontendScripts(['sync.js']);
      assert.equal(isLoggedIn(), true);
    });
  });

  describe('tradeToServerFormat() 前端→服务器字段映射', () => {
    test('完整交易记录字段映射', () => {
      const frontendTrade = {
        id: 123,
        date: '2024-01-15',
        exitDate: '2024-01-20',
        symbol: 'BTC',
        buyType: '15分钟回踩',
        dir: '多',
        entry: 42000,
        stop: 41000,
        target: 44000,
        posSize: 10000,
        actualLots: 50,
        riskAmount: 200,
        exit: 43000,
        pnl: 500,
        pnlR: 2.5,
        status: 'win',
        note: '测试交易'
      };

      const serverTrade = tradeToServerFormat(frontendTrade);

      assert.equal(serverTrade.id, '123');
      assert.equal(serverTrade.openDate, '2024-01-15');
      assert.equal(serverTrade.closeDate, '2024-01-20');
      assert.equal(serverTrade.symbol, 'BTC');
      assert.equal(serverTrade.type, '15分钟回踩');
      assert.equal(serverTrade.direction, '多');
      assert.equal(serverTrade.entryPrice, 42000);
      assert.equal(serverTrade.stopLoss, 41000);
      assert.equal(serverTrade.takeProfit, 44000);
      assert.equal(serverTrade.positionSize, 10000);
      assert.equal(serverTrade.actualLots, 50);
      assert.equal(serverTrade.rAmount, 200);
      assert.equal(serverTrade.closePrice, 43000);
      assert.equal(serverTrade.pnlAmount, 500);
      assert.equal(serverTrade.pnlR, 2.5);
      assert.equal(serverTrade.status, 'win');
      assert.equal(serverTrade.notes, '测试交易');
    });

    test('空值使用默认值', () => {
      const result = tradeToServerFormat({ id: 'test' });
      assert.equal(result.openDate, '');
      assert.equal(result.closeDate, '');
      assert.equal(result.symbol, '');
      assert.equal(result.direction, '多');
      assert.equal(result.entryPrice, 0);
      assert.equal(result.stopLoss, 0);
      assert.equal(result.takeProfit, 0);
      assert.equal(result.positionSize, 0);
      assert.equal(result.actualLots, 0);
      assert.equal(result.rAmount, 0);
      assert.equal(result.closePrice, 0);
      assert.equal(result.pnlAmount, 0);
      assert.equal(result.pnlR, 0);
      assert.equal(result.status, 'open');
      assert.equal(result.notes, '');
    });

    test('数字字段使用 parseFloat 转换', () => {
      const result = tradeToServerFormat({
        id: 'x',
        entry: '42000.5',
        stop: '41000.2',
        pnl: '500.8'
      });
      assert.equal(typeof result.entryPrice, 'number');
      assert.equal(typeof result.stopLoss, 'number');
      assert.equal(typeof result.pnlAmount, 'number');
      assert.equal(result.entryPrice, 42000.5);
    });
  });

  describe('tradeFromServerFormat() 服务器→前端字段映射', () => {
    test('完整服务器记录字段映射', () => {
      const serverTrade = {
        id: 'uuid-123',
        open_date: '2024-01-15',
        close_date: '2024-01-20',
        symbol: 'ETH',
        type: '金叉共振',
        direction: '空',
        entry_price: 2500,
        stop_loss: 2600,
        take_profit: 2300,
        position_size: 5000,
        actual_lots: 2,
        r_amount: 100,
        close_price: 2350,
        pnl_amount: 60,
        pnl_r: 0.6,
        status: 'loss',
        notes: '测试'
      };

      const frontendTrade = tradeFromServerFormat(serverTrade);

      assert.equal(frontendTrade.id, 'uuid-123');
      assert.equal(frontendTrade.date, '2024-01-15');
      assert.equal(frontendTrade.exitDate, '2024-01-20');
      assert.equal(frontendTrade.symbol, 'ETH');
      assert.equal(frontendTrade.buyType, '金叉共振');
      assert.equal(frontendTrade.dir, '空');
      assert.equal(frontendTrade.entry, 2500);
      assert.equal(frontendTrade.stop, 2600);
      assert.equal(frontendTrade.target, 2300);
      assert.equal(frontendTrade.posSize, 5000);
      assert.equal(frontendTrade.actualLots, 2);
      assert.equal(frontendTrade.riskAmount, 100);
      assert.equal(frontendTrade.exit, 2350);
      assert.equal(frontendTrade.pnl, 60);
      assert.equal(frontendTrade.pnlR, 0.6);
      assert.equal(frontendTrade.status, 'loss');
      assert.equal(frontendTrade.note, '测试');
      assert.equal(frontendTrade.followedPlan, '是');
      assert.ok(frontendTrade.openTime, 'openTime 应被设置');
    });

    test('字段缺失时使用空值或默认值', () => {
      const frontendTrade = tradeFromServerFormat({ id: 'incomplete' });
      assert.equal(frontendTrade.id, 'incomplete');
      assert.equal(frontendTrade.date, '');
      assert.equal(frontendTrade.exitDate, '');
      assert.equal(frontendTrade.symbol, '');
      assert.equal(frontendTrade.buyType, '');
      assert.equal(frontendTrade.dir, '多');
      assert.equal(frontendTrade.entry, '');
      assert.equal(frontendTrade.stop, '');
      assert.equal(frontendTrade.target, '');
      assert.equal(frontendTrade.status, 'open');
      assert.equal(frontendTrade.note, '');
    });
  });

  describe('字段映射往返一致性', () => {
    test('前端 → 服务器 → 前端 数据保持一致', () => {
      const original = {
        id: 'trip-1',
        date: '2024-06-01',
        exitDate: '2024-06-05',
        symbol: 'AAPL',
        buyType: '趋势突破',
        dir: '多',
        entry: 180.5,
        stop: 175,
        target: 195,
        posSize: 9025,
        actualLots: 50,
        riskAmount: 275,
        exit: 192,
        pnl: 575,
        pnlR: 2.09,
        status: 'win',
        note: '完美交易'
      };

      const serverFormatted = tradeToServerFormat(original);
      const roundtripped = tradeFromServerFormat({
        id: serverFormatted.id,
        open_date: serverFormatted.openDate,
        close_date: serverFormatted.closeDate,
        symbol: serverFormatted.symbol,
        type: serverFormatted.type,
        direction: serverFormatted.direction,
        entry_price: serverFormatted.entryPrice,
        stop_loss: serverFormatted.stopLoss,
        take_profit: serverFormatted.takeProfit,
        position_size: serverFormatted.positionSize,
        actual_lots: serverFormatted.actualLots,
        r_amount: serverFormatted.rAmount,
        close_price: serverFormatted.closePrice,
        pnl_amount: serverFormatted.pnlAmount,
        pnl_r: serverFormatted.pnlR,
        status: serverFormatted.status,
        notes: serverFormatted.notes
      });

      assert.equal(roundtripped.id, original.id);
      assert.equal(roundtripped.date, original.date);
      assert.equal(roundtripped.exitDate, original.exitDate);
      assert.equal(roundtripped.symbol, original.symbol);
      assert.equal(roundtripped.buyType, original.buyType);
      assert.equal(roundtripped.dir, original.dir);
      assert.equal(roundtripped.entry, original.entry);
      assert.equal(roundtripped.stop, original.stop);
      assert.equal(roundtripped.target, original.target);
      assert.equal(roundtripped.posSize, original.posSize);
      assert.equal(roundtripped.actualLots, original.actualLots);
      assert.equal(roundtripped.riskAmount, original.riskAmount);
      assert.equal(roundtripped.exit, original.exit);
      assert.equal(roundtripped.pnl, original.pnl);
      assert.equal(roundtripped.pnlR, original.pnlR);
      assert.equal(roundtripped.status, original.status);
      assert.equal(roundtripped.note, original.note);
    });
  });

  describe('getCurrentUser()', () => {
    test('未登录时返回 null', () => {
      assert.equal(getCurrentUser(), null);
    });

    test('从 localStorage 恢复登录状态', () => {
      const user = { id: 'u1', username: 'alice', role: 'user' };
      globalThis.localStorage.setItem('sync_user', JSON.stringify(user));
      loadFrontendScripts(['sync.js']);
      const current = getCurrentUser();
      assert.equal(current.id, 'u1');
      assert.equal(current.username, 'alice');
      assert.equal(current.role, 'user');
    });
  });

  describe('logout()', () => {
    test('清除登录状态', () => {
      globalThis.localStorage.setItem('sync_user', JSON.stringify({
        id: 'u1', username: 'alice'
      }));
      loadFrontendScripts(['sync.js']);
      assert.equal(isLoggedIn(), true);

      logout();

      assert.equal(isLoggedIn(), false);
      assert.equal(globalThis.localStorage.getItem('sync_user'), null);
    });
  });

  describe('hasUnsyncedChanges() — P1-1', () => {
    test('无脏数据时返回 false', () => {
      // 确保 dirtyTradeIds / pendingDeletedTradeIds 为空
      globalThis.dirtyTradeIds = {};
      globalThis.pendingDeletedTradeIds = [];
      assert.strictEqual(hasUnsyncedChanges(), false);
    });

    test('dirtyTradeIds 有项时返回 true', () => {
      globalThis.dirtyTradeIds = { 'trade-1': true, 'trade-2': true };
      globalThis.pendingDeletedTradeIds = [];
      assert.strictEqual(hasUnsyncedChanges(), true);
    });

    test('pendingDeletedTradeIds 有项时返回 true', () => {
      globalThis.dirtyTradeIds = {};
      globalThis.pendingDeletedTradeIds = ['trade-3'];
      assert.strictEqual(hasUnsyncedChanges(), true);
    });

    test('dirtyTradeIds 未定义（storage.js 未加载）时安全返回 false', () => {
      delete globalThis.dirtyTradeIds;
      delete globalThis.pendingDeletedTradeIds;
      assert.strictEqual(hasUnsyncedChanges(), false);
    });

    test('暴露到 syncModule', () => {
      assert.strictEqual(typeof window.syncModule.hasUnsyncedChanges, 'function');
    });
  });
});
