// public/js/quote.js
// 免费 A 股行情获取（东方财富 / 新浪财经）
// 全局对象: window.QuoteAPI

(function () {
  'use strict';

  // 行情缓存（5 分钟）
  var CACHE_TTL = 5 * 60 * 1000;
  var cache = {};

  // 股票代码 → 东方财富 secid 映射
  // 沪市: 1.6xxxxx, 5xxxxx, 9xxxxx
  // 深市: 0.0xxxxx, 0.2xxxxx, 0.3xxxxx
  // 京市: 0.8xxxxx
  function toSecId(symbol) {
    if (!symbol) return null;
    var m = symbol.match(/^(\d{6})/);
    if (!m) return null;
    var code = m[1];
    var first = code.charAt(0);
    if (first === '6' || first === '5' || first === '9') {
      return '1.' + code;
    } else if (first === '0' || first === '2' || first === '3') {
      return '0.' + code;
    } else if (first === '8') {
      return '0.' + code;
    }
    return '1.' + code;
  }

  // 单只股票行情
  function fetchQuote(symbol) {
    if (!symbol) return Promise.resolve(null);
    var m = symbol.match(/^(\d{6})/);
    if (!m) return Promise.resolve(null);
    var code = m[1];
    var secid = toSecId(code);
    if (!secid) return Promise.resolve(null);

    // 命中缓存
    var now = Date.now();
    if (cache[code] && now - cache[code].ts < CACHE_TTL) {
      return Promise.resolve(cache[code].data);
    }

    // 通过本机代理拉取（绕过 CORS）
    var url = '/api/quote?secid=' + encodeURIComponent(secid);

    return fetch(url)
      .then(function (r) {
        if (!r.ok) return null;
        return r.json();
      })
      .then(function (json) {
        if (!json || !json.data || json.data.price == null) return null;
        var d = json.data;
        return {
          symbol: d.symbol || code,
          name: d.name || '',
          price: d.price,
          open: d.open,
          high: d.high,
          low: d.low,
          preClose: d.preClose,
          volume: d.volume,
          amount: d.amount,
          change: d.change,
          changePct: d.changePct,
          turnoverRate: d.turnoverRate,
          source: d.source,
          ts: Date.now(),
        };
      })
      .then(function (q) {
        if (q) cache[code] = { ts: Date.now(), data: q };
        return q;
      })
      .catch(function (e) {
        console.warn('[QuoteAPI] 获取行情失败', code, e.message);
        return null;
      });
  }

  // 批量获取行情
  function fetchQuotes(symbols) {
    if (!Array.isArray(symbols) || !symbols.length) return Promise.resolve([]);
    var tasks = symbols.map(function (s) {
      return fetchQuote(s).then(function (q) { return q; });
    });
    return Promise.all(tasks);
  }

  // 计算盈亏
  function calcPnL(item, quote) {
    if (!item || !quote || !quote.price) return null;
    var entry = item.actualEntryPrice;
    if (entry == null) entry = item.entryPriceMax;
    if (entry == null) entry = item.entryPriceMin;
    if (entry == null) return null;
    var qty = item.quantity;
    if (qty == null) return null;
    var diff = quote.price - entry;
    if (item.direction === 'short' || item.direction === 'sell') {
      diff = -diff;
    }
    return diff * qty;
  }

  // 计算盈亏率
  function calcPnLPct(item, quote) {
    if (!item || !quote || !quote.price) return null;
    var entry = item.actualEntryPrice;
    if (entry == null) entry = item.entryPriceMax;
    if (entry == null) entry = item.entryPriceMin;
    if (entry == null) return null;
    var diff = quote.price - entry;
    if (item.direction === 'short' || item.direction === 'sell') {
      diff = -diff;
    }
    return (diff / entry) * 100;
  }

  // 暴露 API
  window.QuoteAPI = {
    fetchQuote: fetchQuote,
    fetchQuotes: fetchQuotes,
    toSecId: toSecId,
    calcPnL: calcPnL,
    calcPnLPct: calcPnLPct,
    clearCache: function () { cache = {}; },
  };
})();
