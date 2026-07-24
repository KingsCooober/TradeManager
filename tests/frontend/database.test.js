'use strict';

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupBrowserMock, teardownBrowserMock, loadFrontendScripts } = require('../helpers/browser-mock');

// ===== 轻量 IndexedDB mock =====
// 仅模拟 clearAllFundsFromDB / clearAllTradesFromDB 所需的最小接口：
//   db.transaction(storeNames, mode) -> tx
//   tx.objectStore(name) -> store
//   store.clear() -> request { onsuccess, onerror }
//   db.objectStoreNames.contains(name)
function createMockDB(storeNames) {
  const storeData = {}; // 记录每个 store 被 clear 的次数
  storeNames.forEach(function(n) { storeData[n] = 0; });

  const objectStoreNames = {
    contains: function(name) { return storeNames.indexOf(name) !== -1; }
  };

  const db = {
    objectStoreNames: objectStoreNames,
    transaction: function(names, mode) {
      const txStores = {};
      names.forEach(function(n) {
        txStores[n] = {
          clear: function() {
            const req = { onsuccess: null, onerror: null };
            // 异步触发 onsuccess，模拟真实 IDB 行为
            setTimeout(function() {
              storeData[n] = (storeData[n] || 0) + 1;
              if (req.onsuccess) req.onsuccess({});
            }, 0);
            return req;
          }
        };
      });
      return {
        objectStore: function(name) { return txStores[name]; },
        onabort: null,
        onerror: null
      };
    },
    _storeData: storeData
  };

  return db;
}

describe('database.js 测试', () => {
  before(() => {
    setupBrowserMock();
  });

  beforeEach(() => {
    if (globalThis.localStorage) globalThis.localStorage.clear();
    loadFrontendScripts(['utils.js', 'database.js']);
  });

  after(() => {
    teardownBrowserMock();
  });

  describe('clearAllFundsFromDB() — P0-3', () => {
    test('db 未初始化时应 resolve 而非 reject', async () => {
      // database.js 加载后 db 为 null
      assert.strictEqual(globalThis.db, null);
      await assert.doesNotReject(async () => {
        await clearAllFundsFromDB();
      });
    });

    test('清空 deposits 和 withdrawals 两个 store', async () => {
      const mockDb = createMockDB(['trades', 'deposits', 'withdrawals', 'settings']);
      globalThis.db = mockDb;

      await clearAllFundsFromDB();

      assert.strictEqual(mockDb._storeData['deposits'], 1, 'deposits 应被清空 1 次');
      assert.strictEqual(mockDb._storeData['withdrawals'], 1, 'withdrawals 应被清空 1 次');
      assert.strictEqual(mockDb._storeData['trades'], 0, 'trades 不应被清空');
      assert.strictEqual(mockDb._storeData['settings'], 0, 'settings 不应被清空');
    });

    test('当 deposits/withdrawals store 不存在时安全降级（不抛错）', async () => {
      // 仅有 trades store，没有 deposits/withdrawals
      const mockDb = createMockDB(['trades', 'settings']);
      globalThis.db = mockDb;

      await assert.doesNotReject(async () => {
        await clearAllFundsFromDB();
      });
      // 不应触发任何 clear
      assert.strictEqual(mockDb._storeData['trades'], 0);
      assert.strictEqual(mockDb._storeData['settings'], 0);
    });

    test('单事务原子性：两个 store 在同一 transaction 中清空', async () => {
      let capturedTxStores = null;
      const mockDb = createMockDB(['trades', 'deposits', 'withdrawals']);
      const origTransaction = mockDb.transaction;
      mockDb.transaction = function(names, mode) {
        capturedTxStores = { names: names.slice(), mode: mode };
        return origTransaction.call(this, names, mode);
      };
      globalThis.db = mockDb;

      await clearAllFundsFromDB();

      assert.ok(capturedTxStores, '应创建事务');
      assert.deepStrictEqual(capturedTxStores.names.sort(), ['deposits', 'withdrawals'], '应在一个事务中清空两个 store');
      assert.strictEqual(capturedTxStores.mode, 'readwrite', '事务应为 readwrite 模式');
    });

    test('store.clear 出错时不阻断另一个 store', async () => {
      // 构造 deposits.clear 直接触发 onerror 的 mock
      const objectStoreNames = { contains: function(n) { return n === 'deposits' || n === 'withdrawals'; } };
      const storeData = { deposits: 0, withdrawals: 0 };
      const db = {
        objectStoreNames: objectStoreNames,
        transaction: function(names, mode) {
          const txStores = {};
          names.forEach(function(n) {
            txStores[n] = {
              clear: function() {
                const req = { onsuccess: null, onerror: null };
                setTimeout(function() {
                  if (n === 'deposits') {
                    // deposits 清空失败
                    if (req.onerror) req.onerror({ target: { error: new Error('mock error') } });
                  } else {
                    // withdrawals 清空成功
                    storeData[n]++;
                    if (req.onsuccess) req.onsuccess({});
                  }
                }, 0);
                return req;
              }
            };
          });
          return {
            objectStore: function(name) { return txStores[name]; },
            onabort: null,
            onerror: null
          };
        }
      };
      globalThis.db = db;

      // 应 resolve 而非 reject（错误被吞掉并降级）
      await assert.doesNotReject(async () => {
        await clearAllFundsFromDB();
      });
      assert.strictEqual(storeData['withdrawals'], 1, 'withdrawals 仍应被清空');
    });
  });

  describe('clearAllTradesFromDB() 回归', () => {
    test('清空 trades store', async () => {
      const mockDb = createMockDB(['trades', 'deposits', 'withdrawals']);
      globalThis.db = mockDb;

      await clearAllTradesFromDB();

      assert.strictEqual(mockDb._storeData['trades'], 1, 'trades 应被清空 1 次');
      assert.strictEqual(mockDb._storeData['deposits'], 0, 'deposits 不应被清空');
    });

    test('db 未初始化时 reject', async () => {
      globalThis.db = null;
      await assert.rejects(async () => {
        await clearAllTradesFromDB();
      });
    });
  });
});
