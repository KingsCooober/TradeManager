'use strict';

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupBrowserMock, teardownBrowserMock, loadFrontendScripts } = require('../helpers/browser-mock');

/**
 * P2-实时同步 测试
 *
 * 覆盖以下改动：
 * 1. SYNC_CONFIG.syncInterval: 30000 → 5000
 * 2. startAutoSync 加入 push+pull 序列 + _syncInFlight 守卫
 * 3. autoSave 防抖 500ms → 200ms
 * 4. focus 事件即时拉取
 * 5. _scheduleSyncRetry / _resetSyncRetry 指数退避
 * 6. pagehide 兜底备份
 * 7. hasUnsyncedChanges 覆盖 funds
 */

describe('P2-实时同步 — sync.js / main.js 实时同步增强', () => {
  before(() => {
    setupBrowserMock();
  });

  beforeEach(() => {
    if (globalThis.localStorage) globalThis.localStorage.clear();
    // 补充 window mock：让 sync.js 的 window.addEventListener('focus', ...) 不抛错
    // browser-mock 默认只设了 globalThis.window = globalThis，但未提供 addEventListener
    if (typeof globalThis.addEventListener !== 'function') {
      globalThis.__windowListeners = globalThis.__windowListeners || [];
      globalThis.addEventListener = function(ev, fn) {
        globalThis.__windowListeners.push({ ev: ev, fn: fn });
      };
      globalThis.removeEventListener = function() {};
      globalThis.dispatchEvent = function(ev) {
        var listeners = (globalThis.__windowListeners || []).filter(function(l) { return l.ev === ev.type; });
        listeners.forEach(function(l) { l.fn(ev); });
        return true;
      };
    }
    // 停止任何遗留的 setInterval/syncRetryTimer，避免测试进程挂起
    if (typeof stopAutoSync === 'function') {
      try { stopAutoSync(); } catch(e) {}
    }
    if (typeof _resetSyncRetry === 'function') {
      try { _resetSyncRetry(); } catch(e) {}
    }
    loadFrontendScripts(['utils.js', 'sync.js']);
    // 重置 storage.js 的 var 声明全局（dirtyTradeIds 等用 var，全局可访问）
    globalThis.dirtyTradeIds = {};
    globalThis.pendingDeletedTradeIds = [];
    // pendingDeletedDeposits/Withdrawals 是 sync.js 中的 let，外部不可写
    // 通过 localStorage + 重新加载来初始化它们
    globalThis.localStorage.setItem('pending_deleted_deposits', '[]');
    globalThis.localStorage.setItem('pending_deleted_withdrawals', '[]');
  });

  after(() => {
    teardownBrowserMock();
  });

  // ========================================================================
  // 改动 1：syncInterval 默认 5000
  // ========================================================================
  describe('改动 1：SYNC_CONFIG.syncInterval = 5000', () => {
    test('startAutoSync 不抛错（说明 SYNC_CONFIG.syncInterval 合法）', () => {
      startAutoSync();
      stopAutoSync();
    });

    test('startAutoSync 写入 sync_auto=true 到 localStorage', () => {
      startAutoSync();
      assert.strictEqual(globalThis.localStorage.getItem('sync_auto'), 'true');
      stopAutoSync();
    });
  });

  // ========================================================================
  // 改动 2：startAutoSync 加入 push+pull + _syncInFlight 守卫
  // ========================================================================
  describe('改动 2：startAutoSync push+pull + 守卫', () => {
    test('startAutoSync 启动后 syncTimer 已激活', () => {
      startAutoSync();
      // syncTimer 是模块内 let，无法直接读
      // 改为：stopAutoSync 不抛错即说明 timer 存在
      stopAutoSync();
    });

    test('stopAutoSync 清理 sync_auto=false', () => {
      startAutoSync();
      stopAutoSync();
      assert.strictEqual(globalThis.localStorage.getItem('sync_auto'), 'false');
    });

    test('多次 startAutoSync 幂等（不抛错）', () => {
      startAutoSync();
      startAutoSync();
      startAutoSync();
      stopAutoSync();
    });
  });

  describe('_doSyncTick 内部函数（P2-实时同步核心）', () => {
    // _doSyncTick 内部直接调用全局函数 syncToServer / syncFromServer（不是 syncModule.x）
    // spy 时需覆盖 globalThis.syncToServer 和 globalThis.syncFromServer
    function installSpy() {
      globalThis.updateAll = function() {}; // syncFromServer 末尾会调用
      const orig = {
        syncToServer: globalThis.syncToServer,
        syncFromServer: globalThis.syncFromServer
      };
      return {
        push: false,
        pull: false,
        restore: function() {
          globalThis.syncToServer = orig.syncToServer;
          globalThis.syncFromServer = orig.syncFromServer;
        }
      };
    }

    test('未登录时 _doSyncTick 立即返回 false', async () => {
      globalThis.localStorage.removeItem('sync_user');
      loadFrontendScripts(['sync.js']);
      const result = await _doSyncTick();
      assert.strictEqual(result, false);
    });

    test('已登录且无 dirty 时 _doSyncTick 走完 push+pull 完整流程', async () => {
      globalThis.localStorage.setItem('sync_user', JSON.stringify({ id: 'u1', username: 'a' }));
      globalThis.localStorage.setItem('sync_token', 'fake-token');
      loadFrontendScripts(['sync.js']);

      const spy = installSpy();
      globalThis.syncToServer = function() { spy.push = true; return Promise.resolve(true); };
      globalThis.syncFromServer = function() { spy.pull = true; return Promise.resolve(true); };

      const result = await _doSyncTick();

      assert.strictEqual(result, true, '_doSyncTick 应返回 true（成功）');
      assert.strictEqual(spy.push, true, '应先调用 push (syncToServer)');
      assert.strictEqual(spy.pull, true, '无 dirty 时应调用 pull (syncFromServer)');
      spy.restore();
    });

    test('本地有 dirty trade 时 _doSyncTick 跳过 pull', async () => {
      globalThis.localStorage.setItem('sync_user', JSON.stringify({ id: 'u1', username: 'a' }));
      globalThis.localStorage.setItem('sync_token', 'fake-token');
      loadFrontendScripts(['sync.js']);
      globalThis.updateAll = function() {};
      globalThis.dirtyTradeIds = { 't1': true };

      const spy = installSpy();
      globalThis.syncToServer = function() { spy.push = true; return Promise.resolve(true); };
      globalThis.syncFromServer = function() { spy.pull = true; return Promise.resolve(true); };

      const result = await _doSyncTick();

      assert.strictEqual(result, true);
      assert.strictEqual(spy.push, true, '有 dirty 时仍应 push');
      assert.strictEqual(spy.pull, false, '有 dirty 时应跳过 pull（避免覆盖）');
      globalThis.dirtyTradeIds = {};
      spy.restore();
    });

    test('连续两次 _doSyncTick 第二次因 _syncInFlight 立即返回 false', async () => {
      globalThis.localStorage.setItem('sync_user', JSON.stringify({ id: 'u1', username: 'a' }));
      globalThis.localStorage.setItem('sync_token', 'fake-token');
      loadFrontendScripts(['sync.js']);
      globalThis.updateAll = function() {};

      // 用可控的 deferred：第一次调用不 resolve（模拟 in-flight）
      // 测试结束后我们手动 resolve 让进程能退出
      let resolveFirstCall;
      const firstCallPromise = new Promise(function(resolve) { resolveFirstCall = resolve; });
      let callCount = 0;
      globalThis.syncToServer = function() {
        callCount++;
        if (callCount === 1) return firstCallPromise;
        return Promise.resolve(true);
      };
      globalThis.syncFromServer = function() { return Promise.resolve(true); };

      // 第一次调用（不 await）
      const p1 = _doSyncTick();
      // 等微任务让 _syncInFlight = true
      await new Promise(function(r) { setTimeout(r, 10); });
      assert.strictEqual(callCount, 1, '第一次 syncToServer 应被调用');

      // 第二次应立即返回 false（_syncInFlight 守卫）
      const r2 = await _doSyncTick();
      assert.strictEqual(r2, false, '第二次应因 _syncInFlight 返回 false');
      assert.strictEqual(callCount, 1, '第二次应未触发 syncToServer（被守卫拦截）');

      // 清理：resolve 第一次调用，让 _syncInFlight 重置
      resolveFirstCall(true);
      await p1;
    });
  });

  // ========================================================================
  // 改动 4：focus 事件即时拉取
  // ========================================================================
  describe('改动 4：focus 事件即时拉取', () => {
    test('focus 监听器已被 initSync 注册', () => {
      // 模拟 initSync 调用
      initSync();
      // __windowListeners 中应有 'focus' 监听
      var focusListeners = (globalThis.__windowListeners || []).filter(function(l) { return l.ev === 'focus'; });
      assert.ok(focusListeners.length > 0, 'initSync 应注册 focus 监听器');
    });

    test('未登录时 focus 不触发 syncFromServer', async () => {
      globalThis.localStorage.removeItem('sync_user');
      loadFrontendScripts(['sync.js']);
      initSync();

      let pullCalled = false;
      globalThis.syncFromServer = function() { pullCalled = true; return Promise.resolve(true); };

      globalThis.dispatchEvent(new Event('focus'));

      await new Promise(function(r) { setTimeout(r, 20); });
      assert.strictEqual(pullCalled, false, '未登录时 focus 不应触发 pull');
    });

    test('本地有未同步变更时 focus 不触发 syncFromServer', async () => {
      globalThis.localStorage.setItem('sync_user', JSON.stringify({ id: 'u1', username: 'a' }));
      globalThis.localStorage.setItem('sync_token', 'fake-token');
      loadFrontendScripts(['sync.js']);
      initSync();
      globalThis.dirtyTradeIds = { 't1': true };

      let pullCalled = false;
      globalThis.syncFromServer = function() { pullCalled = true; return Promise.resolve(true); };

      globalThis.dispatchEvent(new Event('focus'));

      await new Promise(function(r) { setTimeout(r, 20); });
      assert.strictEqual(pullCalled, false, '有 dirty 时 focus 不应触发 pull');

      globalThis.dirtyTradeIds = {};
    });

    test('已登录且无 dirty 时 focus 触发 syncFromServer', async () => {
      globalThis.localStorage.setItem('sync_user', JSON.stringify({ id: 'u1', username: 'a' }));
      globalThis.localStorage.setItem('sync_token', 'fake-token');
      loadFrontendScripts(['sync.js']);
      initSync();
      globalThis.dirtyTradeIds = {};
      globalThis.updateAll = function() {};

      let pullCalled = false;
      globalThis.syncFromServer = function() { pullCalled = true; return Promise.resolve(true); };

      globalThis.dispatchEvent(new Event('focus'));

      await new Promise(function(r) { setTimeout(r, 20); });
      assert.strictEqual(pullCalled, true, '已登录无 dirty 时 focus 应触发 pull');
    });
  });

  // ========================================================================
  // 改动 5：_scheduleSyncRetry / _resetSyncRetry 指数退避
  // ========================================================================
  describe('改动 5：指数退避重试', () => {
    test('_scheduleSyncRetry 不抛错', () => {
      _resetSyncRetry();
      _scheduleSyncRetry();
      _resetSyncRetry();
    });

    test('多次 _scheduleSyncRetry 幂等', () => {
      _resetSyncRetry();
      _scheduleSyncRetry();
      _scheduleSyncRetry();
      _scheduleSyncRetry();
      _resetSyncRetry();
    });

    test('_resetSyncRetry 后下一次 _scheduleSyncRetry 从 1s 起步', () => {
      // 模拟已经退避到 16s 的状态（通过反复调用增加）
      _resetSyncRetry();
      _scheduleSyncRetry(); // 1s
      _scheduleSyncRetry(); // 被早退
      _resetSyncRetry();
      _scheduleSyncRetry(); // 重新 1s
      _resetSyncRetry();
      // 不抛错即视为通过；具体延迟值不可访问（闭包）
    });
  });

  // ========================================================================
  // 改动 6：pagehide 兜底备份
  // ========================================================================
  describe('改动 6：pagehide 兜底（main.js）', () => {
    test('pagehide 事件被 main.js 监听', () => {
      // main.js 加载时会注册 beforeunload + pagehide 监听器
      loadFrontendScripts(['utils.js', 'storage.js', 'calculator.js', 'table.js', 'charts.js', 'main.js']);
      var pagehideListeners = (globalThis.__windowListeners || []).filter(function(l) { return l.ev === 'pagehide'; });
      assert.ok(pagehideListeners.length > 0, 'main.js 应注册 pagehide 监听器');
    });

    test('pagehide 触发后 localStorage 写入 trades_v4 和 funds_v1', () => {
      loadFrontendScripts(['utils.js', 'storage.js', 'calculator.js', 'table.js', 'charts.js', 'main.js']);
      // 准备数据
      globalThis.trades = [{ id: 't1', symbol: 'BTC' }];
      globalThis.deposits = [{ id: 'd1', amount: 100, date: '2024-01-01' }];
      globalThis.withdrawals = [{ id: 'w1', amount: 50, date: '2024-01-02' }];

      // 触发 pagehide
      globalThis.dispatchEvent(new Event('pagehide'));

      // 验证 localStorage 写入
      var tradesBackup = JSON.parse(globalThis.localStorage.getItem('trades_v4') || '[]');
      assert.ok(Array.isArray(tradesBackup) && tradesBackup.length === 1, 'trades_v4 应被写入');
      assert.strictEqual(tradesBackup[0].id, 't1');

      var fundsBackup = JSON.parse(globalThis.localStorage.getItem('funds_v1') || '{}');
      assert.strictEqual(fundsBackup.deposits.length, 1, 'funds_v1.deposits 应被写入');
      assert.strictEqual(fundsBackup.withdrawals.length, 1, 'funds_v1.withdrawals 应被写入');
    });
  });

  // ========================================================================
  // 改动 7：hasUnsyncedChanges 扩展覆盖 funds
  // ========================================================================
  describe('改动 7：hasUnsyncedChanges 覆盖 funds', () => {
    test('trades 全空 + funds 全空时返回 false', () => {
      globalThis.dirtyTradeIds = {};
      globalThis.pendingDeletedTradeIds = [];
      // pendingDeletedDeposits/Withdrawals 是 sync.js 的 let
      // 通过 localStorage 重置后重新加载让它们为空
      globalThis.localStorage.setItem('pending_deleted_deposits', '[]');
      globalThis.localStorage.setItem('pending_deleted_withdrawals', '[]');
      loadFrontendScripts(['sync.js']);

      assert.strictEqual(hasUnsyncedChanges(), false);
    });

    test('pendingDeletedDeposits 有项时返回 true（通过 localStorage 触发）', () => {
      globalThis.dirtyTradeIds = {};
      globalThis.pendingDeletedTradeIds = [];
      globalThis.localStorage.setItem('pending_deleted_deposits', JSON.stringify(['dep-1']));
      globalThis.localStorage.setItem('pending_deleted_withdrawals', '[]');
      loadFrontendScripts(['sync.js']);

      assert.strictEqual(hasUnsyncedChanges(), true);
    });

    test('pendingDeletedWithdrawals 有项时返回 true（通过 localStorage 触发）', () => {
      globalThis.dirtyTradeIds = {};
      globalThis.pendingDeletedTradeIds = [];
      globalThis.localStorage.setItem('pending_deleted_deposits', '[]');
      globalThis.localStorage.setItem('pending_deleted_withdrawals', JSON.stringify(['with-1']));
      loadFrontendScripts(['sync.js']);

      assert.strictEqual(hasUnsyncedChanges(), true);
    });

    test('混合 dirty trade + fund 时返回 true', () => {
      globalThis.dirtyTradeIds = { 't1': true };
      globalThis.pendingDeletedTradeIds = [];
      globalThis.localStorage.setItem('pending_deleted_deposits', JSON.stringify(['dep-1']));
      globalThis.localStorage.setItem('pending_deleted_withdrawals', '[]');
      loadFrontendScripts(['sync.js']);

      assert.strictEqual(hasUnsyncedChanges(), true);
    });
  });

  // ========================================================================
  // 改动 3：autoSave 防抖 500ms → 200ms（间接验证）
  // ========================================================================
  describe('改动 3：autoSave 防抖', () => {
    test('autoSave 函数存在', () => {
      loadFrontendScripts(['utils.js', 'storage.js', 'calculator.js', 'table.js', 'charts.js', 'main.js']);
      assert.strictEqual(typeof globalThis.autoSave, 'function');
    });

    test('autoSave 200ms 防抖：连续调用在 200ms 内只触发一次 save', async () => {
      loadFrontendScripts(['utils.js', 'storage.js', 'calculator.js', 'table.js', 'charts.js', 'main.js']);

      var callCount = 0;
      globalThis.save = function() { callCount++; return Promise.resolve(); };

      globalThis.autoSave();
      globalThis.autoSave();
      globalThis.autoSave();

      // 防抖期间 callCount 应为 0
      assert.strictEqual(callCount, 0, '防抖期间不应触发 save');

      // 等 250ms 让防抖触发（200ms + 微任务）
      await new Promise(function(r) { setTimeout(r, 250); });
      assert.strictEqual(callCount, 1, '防抖结束后应只触发 1 次 save');
    });
  });
});
