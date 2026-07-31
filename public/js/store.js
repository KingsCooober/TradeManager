/**
 * DataStore — 统一数据层
 *
 * 三层存储：内存缓存 → IndexedDB（离线）→ 服务器（跨设备同步）
 *
 * 核心理念：
 *   新功能只需 var col = DataStore.collection('xxx') 即可获得完整的持久化 + 同步能力
 *   不再需要手动建表、写 API、写 sync 逻辑
 *
 * 用法：
 *   var btTrades = DataStore.collection('backtest_trades');
 *   await btTrades.save({ id: 'xxx', date: '2024-01-01', action: 'buy', ... });
 *   var items = await btTrades.getAll();           // 返回数组
 *   var item  = await btTrades.get('xxx');          // 返回单条
 *   await btTrades.delete('xxx');
 *   await btTrades.clear();
 *   btTrades.onChange(function(items) { ... });     // 监听变化
 *
 * 自动同步：
 *   - 登录后自动从服务器拉取最新数据（sync.js 调用 DataStore.onLogin）
 *   - 写入后 1s 防抖同步到服务器
 *   - 离线时数据存在 IndexedDB，上线后自动同步
 *   - 未登录时仅用 IndexedDB（本地模式）
 */

var DataStore = (function() {

  // ===== IndexedDB 配置 =====
  var DB_NAME = 'DataStoreDB';
  var DB_VERSION = 1;
  var STORE_NAME = 'items';  // 单一 store，用 collection 字段区分

  var _db = null;
  var _collections = {};     // collection name → { items: {}, listeners: [] }
  var _syncTimer = null;
  var _syncPending = {};     // collection → { adds: Set, deletes: Set }
  var _loggedIn = false;
  var _pulling = false;      // 正在从服务器拉取，避免写操作触发同步

  // ===== IndexedDB 初始化 =====
  function initDB() {
    return new Promise(function(resolve) {
      if (_db) { resolve(_db); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = function(e) {
        console.error('[DataStore] IndexedDB 打开失败:', e.target.error);
        resolve(null);  // 降级：仅用内存
      };
      req.onsuccess = function(e) {
        _db = e.target.result;
        resolve(_db);
      };
      req.onupgradeneeded = function(e) {
        var database = e.target.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          var store = database.createObjectStore(STORE_NAME, { keyPath: ['collection', 'id'] });
          store.createIndex('collection', 'collection', { unique: false });
        }
      };
    });
  }

  // ===== IndexedDB 读写 =====
  function idbGetAll(collection) {
    return new Promise(function(resolve) {
      if (!_db) { resolve([]); return; }
      var tx = _db.transaction([STORE_NAME], 'readonly');
      var store = tx.objectStore(STORE_NAME);
      var idx = store.index('collection');
      var req = idx.getAll(collection);
      req.onsuccess = function() { resolve(req.result || []); };
      req.onerror = function() { resolve([]); };
    });
  }

  function idbPut(collection, item) {
    return new Promise(function(resolve) {
      if (!_db) { resolve(); return; }
      var tx = _db.transaction([STORE_NAME], 'readwrite');
      var store = tx.objectStore(STORE_NAME);
      var record = Object.assign({}, item, { collection: collection });
      var req = store.put(record);
      req.onsuccess = function() { resolve(); };
      req.onerror = function() { resolve(); };
    });
  }

  function idbDelete(collection, id) {
    return new Promise(function(resolve) {
      if (!_db) { resolve(); return; }
      var tx = _db.transaction([STORE_NAME], 'readwrite');
      var store = tx.objectStore(STORE_NAME);
      var req = store.delete([collection, id]);
      req.onsuccess = function() { resolve(); };
      req.onerror = function() { resolve(); };
    });
  }

  function idbClear(collection) {
    return new Promise(function(resolve) {
      if (!_db) { resolve(); return; }
      var tx = _db.transaction([STORE_NAME], 'readwrite');
      var store = tx.objectStore(STORE_NAME);
      var idx = store.index('collection');
      var cursorReq = idx.openCursor(collection);
      cursorReq.onsuccess = function(e) {
        var cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = function() { resolve(); };
    });
  }

  // ===== 服务器同步 =====
  function authFetch(url, options) {
    if (typeof window.authFetch === 'function') return window.authFetch(url, options);
    return fetch(url, options);
  }

  function isLoggedIn() {
    if (typeof syncModule !== 'undefined' && syncModule.isLoggedIn) return syncModule.isLoggedIn();
    try { return !!localStorage.getItem('sync_token'); } catch (e) { return false; }
  }

  // 从服务器拉取某 collection 的全部数据 → 覆盖 IndexedDB + 内存
  async function pullFromServer(collection) {
    if (!isLoggedIn()) return;
    try {
      var res = await authFetch('/api/data/' + collection);
      if (!res.ok) return;
      var result = await res.json();
      var items = result.items || [];

      // 更新 IndexedDB：先清后写
      await idbClear(collection);
      var col = _collections[collection];
      if (col) {
        col.items = {};
        for (var i = 0; i < items.length; i++) {
          var item = items[i].data;
          col.items[item.id] = item;
          await idbPut(collection, item);
        }
        _notify(collection);
      }
      console.log('[DataStore] 拉取 ' + collection + ': ' + items.length + ' 条');
    } catch (e) {
      console.warn('[DataStore] 拉取 ' + collection + ' 失败:', e.message);
    }
  }

  // 防抖同步：1s 内的多次写操作合并为一次服务器请求
  function scheduleSync(collection, type, id) {
    if (!isLoggedIn()) return;
    if (!_syncPending[collection]) _syncPending[collection] = { adds: {}, deletes: {} };
    if (type === 'delete') {
      delete _syncPending[collection].adds[id];
      _syncPending[collection].deletes[id] = true;
    } else {
      delete _syncPending[collection].deletes[id];
      _syncPending[collection].adds[id] = true;
    }
    if (_syncTimer) clearTimeout(_syncTimer);
    _syncTimer = setTimeout(flushSync, 1000);
  }

  // 执行同步：把待处理的变更推送到服务器
  async function flushSync() {
    _syncTimer = null;
    if (!isLoggedIn()) return;

    for (var colName in _syncPending) {
      var pending = _syncPending[colName];
      var col = _collections[colName];
      if (!col) continue;

      // 推送新增/修改
      var addIds = Object.keys(pending.adds);
      for (var i = 0; i < addIds.length; i++) {
        var item = col.items[addIds[i]];
        if (!item) continue;
        try {
          await authFetch('/api/data/' + colName, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.id, data: item })
          });
        } catch (e) {
          console.warn('[DataStore] 同步失败:', colName, addIds[i], e.message);
        }
      }

      // 推送删除
      var deleteIds = Object.keys(pending.deletes);
      for (var j = 0; j < deleteIds.length; j++) {
        try {
          await authFetch('/api/data/' + colName + '/' + deleteIds[j], { method: 'DELETE' });
        } catch (e) {
          console.warn('[DataStore] 删除同步失败:', colName, deleteIds[j], e.message);
        }
      }
    }
    _syncPending = {};
  }

  // 通知监听器
  function _notify(collection) {
    var col = _collections[collection];
    if (!col) return;
    var items = Object.keys(col.items).map(function(k) { return col.items[k]; });
    for (var i = 0; i < col.listeners.length; i++) {
      try { col.listeners[i](items); } catch (e) {}
    }
  }

  // ===== Collection 对象 =====
  function createCollection(name) {
    var col = {
      name: name,
      items: {},         // id → item
      listeners: [],
      _loaded: false
    };

    // 从 IndexedDB 加载到内存（仅首次）
    col._ensureLoaded = async function() {
      if (col._loaded) return;
      var records = await idbGetAll(name);
      col.items = {};
      for (var i = 0; i < records.length; i++) {
        var item = records[i];
        delete item.collection;  // 去掉内部字段
        col.items[item.id] = item;
      }
      col._loaded = true;
    };

    // 获取全部（返回数组）
    col.getAll = async function() {
      await col._ensureLoaded();
      // 如果已登录但未从服务器拉过，尝试拉一次
      if (isLoggedIn() && !col._pulled) {
        col._pulled = true;
        _pulling = true;
        await pullFromServer(name);
        _pulling = false;
      }
      return Object.keys(col.items).map(function(k) { return col.items[k]; });
    };

    // 获取单条
    col.get = async function(id) {
      await col._ensureLoaded();
      return col.items[id] || null;
    };

    // 按 filter 函数查询
    col.query = async function(filterFn) {
      var all = await col.getAll();
      return all.filter(filterFn);
    };

    // 保存（upsert）
    col.save = async function(item) {
      if (!item.id) { console.error('[DataStore] 保存失败: item 缺少 id 字段'); return; }
      await col._ensureLoaded();
      col.items[item.id] = item;
      await idbPut(name, item);
      _notify(name);
      if (!_pulling) scheduleSync(name, 'save', item.id);
    };

    // 批量保存
    col.saveBatch = async function(items) {
      await col._ensureLoaded();
      for (var i = 0; i < items.length; i++) {
        if (!items[i].id) continue;
        col.items[items[i].id] = items[i];
        await idbPut(name, items[i]);
        if (!_pulling) scheduleSync(name, 'save', items[i].id);
      }
      _notify(name);
    };

    // 删除
    col.delete = async function(id) {
      await col._ensureLoaded();
      delete col.items[id];
      await idbDelete(name, id);
      _notify(name);
      if (!_pulling) scheduleSync(name, 'delete', id);
    };

    // 清空
    col.clear = async function() {
      await col._ensureLoaded();
      var ids = Object.keys(col.items);
      col.items = {};
      await idbClear(name);
      _notify(name);
      // 服务器清空
      if (isLoggedIn()) {
        try { await authFetch('/api/data/' + name, { method: 'DELETE' }); } catch (e) {}
      }
    };

    // 监听变化
    col.onChange = function(callback) {
      col.listeners.push(callback);
    };

    return col;
  }

  // ===== 公共 API =====

  // 获取/创建 collection
  function collection(name) {
    if (!_collections[name]) {
      _collections[name] = createCollection(name);
    }
    return _collections[name];
  }

  // 登录后调用：拉取所有已注册的 collection
  async function onLogin() {
    _loggedIn = true;
    var names = Object.keys(_collections);
    for (var i = 0; i < names.length; i++) {
      _collections[names[i]]._pulled = false;
      _pulling = true;
      await pullFromServer(names[i]);
      _pulling = false;
    }
    // 确保待同步的变更也推上去
    flushSync();
  }

  // 登出后调用：保留本地缓存，停止同步
  function onLogout() {
    _loggedIn = false;
    _syncPending = {};
    if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
  }

  // 手动触发同步（可用于页面 focus 时）
  async function syncAll() {
    if (!isLoggedIn()) return;
    var names = Object.keys(_collections);
    for (var i = 0; i < names.length; i++) {
      _pulling = true;
      await pullFromServer(names[i]);
      _pulling = false;
    }
    flushSync();
  }

  // 初始化（打开 IndexedDB）
  async function init() {
    await initDB();
  }

  return {
    collection: collection,
    onLogin: onLogin,
    onLogout: onLogout,
    syncAll: syncAll,
    init: init,
    isLoggedIn: isLoggedIn
  };
})();
