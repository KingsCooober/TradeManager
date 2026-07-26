const mq = require('./market-quote.js');
(async () => {
  for (const sym of ['sh000001', 'sh000510', 'sz399673', 'sh000688']) {
    try {
      const data = await mq.fetchKLine(sym, 250);
      console.log(sym + ' (' + (data[0] && data[0].__name || sym) + '): ' + data.length + ' 根, 首日=' + data[0].date + ' 末日=' + data[data.length-1].date);
    } catch(e) { console.log(sym + ' 失败: ' + e.message); }
  }
})();