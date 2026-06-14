// ===== 每日交易计划 数据管理 =====
// 状态机：草稿(draft) → 已确认(confirmed) → 已执行(executed) → 已完成(completed) / 已取消(cancelled)
// 执行状态：未执行(not_executed) / 部分执行(partial) / 完全执行(full) / 取消执行(cancelled)

(function () {
  'use strict';

  // ===== 常量定义 =====
  const PLAN_STATUS = {
    draft:     { label: '草稿',     color: 'gray'   },
    confirmed: { label: '已确认',   color: 'blue'   },
    executed:  { label: '已执行',   color: 'purple' },
    completed: { label: '已完成',   color: 'green'  },
    cancelled: { label: '已取消',   color: 'red'    },
  };

  const EXEC_STATUS = {
    not_executed: { label: '未执行',     color: 'gray'  },
    partial:      { label: '部分执行',   color: 'yellow'},
    full:         { label: '完全执行',   color: 'green' },
    cancelled:    { label: '取消执行',   color: 'red'   },
  };

  const DIRECTION = {
    long:  { label: '做多',  color: 'green' },
    short: { label: '做空',  color: 'red'   },
    buy:   { label: '买入',  color: 'green' },
    sell:  { label: '卖出',  color: 'red'   },
  };

  const SESSION = {
    morning:  { label: '早盘 09:30-11:30' },
    noon:     { label: '午盘 13:00-15:00' },
    closing:  { label: '尾盘 14:30-15:00' },
    night:    { label: '夜盘 21:00-23:00' },
    custom:   { label: '自定义' },
  };

  const MARKETS = ['股票', '期货', '外汇', '数字货币', '期权', 'ETF'];

  // ===== 工具函数 =====
  function genId(prefix) {
    return (prefix || 'plan') + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
  }

  function todayISO() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function tomorrowISO() {
    var d = new Date();
    d.setDate(d.getDate() + 1);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  // 计算风险收益比
  // entry: 入场价, target: 止盈价, stop: 止损价, direction: 'long'|'short'
  function calcRR(entry, target, stop, direction) {
    if (entry == null || target == null || stop == null) return null;
    var e = Number(entry), t = Number(target), s = Number(stop);
    if (isNaN(e) || isNaN(t) || isNaN(s) || e === 0) return null;
    var reward, risk;
    if (direction === 'long' || direction === 'buy') {
      reward = t - e;
      risk = e - s;
    } else {
      reward = e - t;
      risk = s - e;
    }
    if (risk <= 0) return { reward: reward, risk: risk, ratio: null, valid: false };
    return { reward: reward, risk: risk, ratio: reward / risk, valid: true };
  }

  // 格式化风险收益比
  function formatRR(rr) {
    if (!rr || rr.ratio == null) return '-';
    return '1 : ' + rr.ratio.toFixed(2);
  }

  // 计算实际盈亏（不考虑手续费之外的滑点等）
  // direction, entry, exit, qty, fee
  function calcPnL(direction, entry, exit, qty, fee) {
    if (entry == null || exit == null || qty == null) return null;
    var e = Number(entry), x = Number(exit), q = Number(qty), f = Number(fee || 0);
    if (isNaN(e) || isNaN(x) || isNaN(q)) return null;
    var pnl;
    if (direction === 'long' || direction === 'buy') {
      pnl = (x - e) * q - f;
    } else {
      pnl = (e - x) * q - f;
    }
    return pnl;
  }

  // ===== 数据库操作 =====
  // 保存计划
  function savePlan(plan) {
    return new Promise(function (resolve, reject) {
      if (!db) return reject(new Error('数据库未初始化'));
      plan.updatedAt = Date.now();
      if (!plan.createdAt) plan.createdAt = plan.updatedAt;
      var tx = db.transaction(['plans'], 'readwrite');
      var store = tx.objectStore('plans');
      var req = store.put(plan);
      req.onsuccess = function () { resolve(plan); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // 获取单个计划
  function getPlan(id) {
    return new Promise(function (resolve, reject) {
      if (!db) return reject(new Error('数据库未初始化'));
      var tx = db.transaction(['plans'], 'readonly');
      var store = tx.objectStore('plans');
      var req = store.get(id);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // 获取所有计划
  function getAllPlans() {
    return new Promise(function (resolve, reject) {
      if (!db) return reject(new Error('数据库未初始化'));
      var tx = db.transaction(['plans'], 'readonly');
      var store = tx.objectStore('plans');
      var req = store.getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // 按日期获取
  function getPlansByDate(date) {
    return new Promise(function (resolve, reject) {
      if (!db) return reject(new Error('数据库未初始化'));
      var tx = db.transaction(['plans'], 'readonly');
      var store = tx.objectStore('plans');
      var idx = store.index('date');
      var req = idx.getAll(date);
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // 删除计划
  function deletePlan(id) {
    return new Promise(function (resolve, reject) {
      if (!db) return reject(new Error('数据库未初始化'));
      var tx = db.transaction(['plans'], 'readwrite');
      var store = tx.objectStore('plans');
      var req = store.delete(id);
      req.onsuccess = function () { resolve(true); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // 批量删除
  function deletePlans(ids) {
    return new Promise(function (resolve, reject) {
      if (!db) return reject(new Error('数据库未初始化'));
      var tx = db.transaction(['plans'], 'readwrite');
      var store = tx.objectStore('plans');
      var pending = ids.length;
      var errored = false;
      ids.forEach(function (id) {
        var req = store.delete(id);
        req.onsuccess = function () {
          pending--;
          if (pending === 0 && !errored) resolve(true);
        };
        req.onerror = function () {
          if (!errored) { errored = true; reject(req.error); }
        };
      });
      if (ids.length === 0) resolve(true);
    });
  }

  // ===== 模板操作 =====
  function saveTemplate(tmpl) {
    return new Promise(function (resolve, reject) {
      if (!db) return reject(new Error('数据库未初始化'));
      tmpl.updatedAt = Date.now();
      if (!tmpl.createdAt) tmpl.createdAt = tmpl.updatedAt;
      var tx = db.transaction(['planTemplates'], 'readwrite');
      var store = tx.objectStore('planTemplates');
      var req = store.put(tmpl);
      req.onsuccess = function () { resolve(tmpl); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function getAllTemplates() {
    return new Promise(function (resolve, reject) {
      if (!db) return reject(new Error('数据库未初始化'));
      var tx = db.transaction(['planTemplates'], 'readonly');
      var store = tx.objectStore('planTemplates');
      var req = store.getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function deleteTemplate(id) {
    return new Promise(function (resolve, reject) {
      if (!db) return reject(new Error('数据库未初始化'));
      var tx = db.transaction(['planTemplates'], 'readwrite');
      var store = tx.objectStore('planTemplates');
      var req = store.delete(id);
      req.onsuccess = function () { resolve(true); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // ===== 工厂函数 =====
  function createEmptyPlan() {
    var now = Date.now();
    return {
      id: genId('plan'),
      userId: null,
      date: todayISO(),
      status: 'draft',
      markets: [],
      strategy: '',
      profitTarget: null,
      riskTarget: null,
      tradingSession: 'morning',
      customSession: '',
      marketSentiment: '',
      reminderEnabled: false,
      reminderTime: '09:00',
      notes: '',
      items: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  function createEmptyItem() {
    return {
      id: genId('item'),
      symbol: '',
      direction: 'long',
      entryPriceMin: null,
      entryPriceMax: null,
      actualEntryPrice: null,
      targetPrice: null,
      stopLossPrice: null,
      quantity: null,
      reason: '',
      executionStatus: 'not_executed',
      executionTime: '',
      fee: 0,
      actualExitPrice: null,
      realizedPnl: null,
      resultNote: '',
    };
  }

  // ===== 统计 =====
  function summarizePlan(plan) {
    var summary = {
      itemCount: plan.items.length,
      executedCount: 0,
      fullExecuted: 0,
      partialExecuted: 0,
      notExecuted: 0,
      cancelled: 0,
      totalPlannedRisk: 0,
      totalActualPnl: 0,
      avgRR: 0,
      rrCount: 0,
    };
    plan.items.forEach(function (it) {
      switch (it.executionStatus) {
        case 'full':    summary.fullExecuted++;    break;
        case 'partial': summary.partialExecuted++; break;
        case 'cancelled': summary.cancelled++;    break;
        default:        summary.notExecuted++;     break;
      }
      if (it.executionStatus === 'full' || it.executionStatus === 'partial') {
        summary.executedCount++;
      }
      // 计划风险：止损距离 * 数量
      if (it.stopLossPrice != null && it.entryPriceMin != null && it.quantity != null) {
        var risk = Math.abs(Number(it.entryPriceMin) - Number(it.stopLossPrice)) * Number(it.quantity);
        if (!isNaN(risk)) summary.totalPlannedRisk += risk;
      }
      // 实际盈亏
      if (it.actualExitPrice != null && it.actualEntryPrice != null) {
        var pnl = calcPnL(it.direction, it.actualEntryPrice, it.actualExitPrice, it.quantity, it.fee);
        if (pnl != null) summary.totalActualPnl += pnl;
      }
      // R/R
      var rr = calcRR(it.entryPriceMin, it.targetPrice, it.stopLossPrice, it.direction);
      if (rr && rr.valid) {
        summary.avgRR += rr.ratio;
        summary.rrCount++;
      }
    });
    if (summary.rrCount > 0) summary.avgRR = summary.avgRR / summary.rrCount;
    return summary;
  }

  // ===== 导出 =====
  window.PlanModule = {
    // 常量
    PLAN_STATUS: PLAN_STATUS,
    EXEC_STATUS: EXEC_STATUS,
    DIRECTION: DIRECTION,
    SESSION: SESSION,
    MARKETS: MARKETS,
    // 工具
    genId: genId,
    todayISO: todayISO,
    tomorrowISO: tomorrowISO,
    calcRR: calcRR,
    formatRR: formatRR,
    calcPnL: calcPnL,
    // 数据库
    savePlan: savePlan,
    getPlan: getPlan,
    getAllPlans: getAllPlans,
    getPlansByDate: getPlansByDate,
    deletePlan: deletePlan,
    deletePlans: deletePlans,
    saveTemplate: saveTemplate,
    getAllTemplates: getAllTemplates,
    deleteTemplate: deleteTemplate,
    // 工厂
    createEmptyPlan: createEmptyPlan,
    createEmptyItem: createEmptyItem,
    // 统计
    summarizePlan: summarizePlan,
  };
})();
