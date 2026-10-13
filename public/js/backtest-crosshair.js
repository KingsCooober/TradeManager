// public/js/backtest-crosshair.js
// 回测页 K 线图十字光标（自绘层）
//
// 为什么不用 ECharts 内置 axisPointer：
//   本页 tooltip.show=false（改用自定义 DOM tooltip，避免遮挡 K 线），
//   而 ECharts 5 的 axisPointer 展示链路挂在 tooltip 上 —— tooltip 不显示时，
//   整条链路被跳过，实测 hover 时 chart canvas 像素完全不变（十字光标不出现）。
//   试过"顶层 axisPointer + 各 xAxis.axisPointer.show=true"均无效。
//
// 方案：用一层绝对定位的透明 canvas 覆盖在图表之上，按 BT_currentIdx 计算像素位置
//   并绘制横线（价格线，贯穿所有 grid）+ 竖线（时间线）。
//   行为完全可控，不依赖 ECharts 内部实现。
//
// 关键点：
//   - x 坐标用 BT_chart.convertToPixel({xAxisIndex: 0}, idx)，与 K 线像素严格对齐
//   - y 坐标取该 idx 的收盘价在**主图 grid** 上的像素位置（横线跟随价格）
//   - 竖线贯穿绘图区（从主图顶到成交量底），与主图/成交量两个 grid 对齐
//   - devicePixelRatio 适配，避免高清屏下线条发虚
(function (global) {
  'use strict';

  // 线条颜色：竖线稍深、横线稍浅，虚线，浅灰不抢眼但能看清位置
  var COLORS = {
    v: 'rgba(128,128,128,0.55)',
    h: 'rgba(128,128,128,0.45)'
  };

  // 每张图一个实例（主图与指数图是不同容器，不能共用一个 overlay）
  var instances = {};        // domId -> { overlay, ctx2d, dpr, chart, getOpts }

  function getInst(domId) {
    return instances[domId] || null;
  }

  function ensureCanvas(inst) {
    var dom = document.getElementById(inst.domId);
    if (!dom) return null;
    if (inst.overlay && inst.overlay.parentNode === dom) return inst.overlay;
    if (inst.overlay && inst.overlay.parentNode) inst.overlay.parentNode.removeChild(inst.overlay);

    inst.overlay = document.createElement('canvas');
    inst.overlay.className = 'bt-crosshair-layer';
    inst.overlay.style.cssText = [
      'position: absolute',
      'left: 0',
      'top: 0',
      'pointer-events: none',
      'z-index: 20'
    ].join(';');
    dom.appendChild(inst.overlay);
    inst.ctx2d = null;
    return inst.overlay;
  }

  function syncSize(inst) {
    var dom = document.getElementById(inst.domId);
    if (!inst.overlay || !dom) return;
    var w = dom.clientWidth;
    var h = dom.clientHeight;
    if (!w || !h) return;
    var dpr = global.devicePixelRatio || 1;
    inst.overlay.style.width = w + 'px';
    inst.overlay.style.height = h + 'px';
    inst.overlay.width = Math.round(w * dpr);
    inst.overlay.height = Math.round(h * dpr);
    if (!inst.ctx2d) inst.ctx2d = inst.overlay.getContext('2d');
    inst.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    inst.dpr = dpr;
  }

  function clear(inst) {
    if (!inst.ctx2d || !inst.overlay) return;
    inst.ctx2d.clearRect(0, 0, inst.overlay.width, inst.overlay.height);
  }

  /**
   * 根据当前 idx 重绘十字光标
   */
  function draw(inst, idx, opts) {
    if (!inst.chart || idx == null || idx < 0) return;
    var cv = ensureCanvas(inst);
    if (!cv) return;
    if (!inst.overlay.width || !inst.overlay.height) syncSize(inst);
    clear(inst);
    if (!inst.ctx2d) return;

    var opt = opts || {};
    var plotTop = opt.plotTop != null ? opt.plotTop : 18;
    var plotBottom = opt.plotBottom != null ? opt.plotBottom : 383;

    // ---- 竖线：x 对齐 K 线中心 ----
    var px = inst.chart.convertToPixel({ xAxisIndex: 0 }, idx);
    if (px == null || isNaN(px)) return;
    var x = Math.round(px) + 0.5;   // +0.5 让 1px 线在奇偶像素下都清晰

    // ---- 横线：y 取该 idx 收盘价在主图 grid 的像素位置 ----
    var py = null;
    var close = null;
    var data = opt.data;
    if (data && data.ohlc && data.ohlc[idx]) {
      close = data.ohlc[idx][1];
    }
    if (close != null) {
      py = inst.chart.convertToPixel({ yAxisIndex: 0 }, close);
    }

    inst.ctx2d.save();
    inst.ctx2d.lineWidth = 1;
    inst.ctx2d.setLineDash([4, 3]);

    // 竖线
    inst.ctx2d.strokeStyle = COLORS.v;
    inst.ctx2d.beginPath();
    inst.ctx2d.moveTo(x, plotTop);
    inst.ctx2d.lineTo(x, plotBottom);
    inst.ctx2d.stroke();

    // 横线（仅在有价格时画）
    if (py != null && !isNaN(py)) {
      var y = Math.round(py) + 0.5;
      inst.ctx2d.strokeStyle = COLORS.h;
      inst.ctx2d.beginPath();
      inst.ctx2d.moveTo(opt.plotLeft != null ? opt.plotLeft : 60, y);
      inst.ctx2d.lineTo(opt.plotRight != null ? opt.plotRight : (inst.overlay.width / inst.dpr - 30), y);
      inst.ctx2d.stroke();
    }

    inst.ctx2d.restore();
    inst.visible = true;
  }

  function hide(inst) {
    clear(inst);
    inst.visible = false;
  }

  /**
   * 绑定到某个 ECharts 实例
   * @param {string} domId 图表容器 id（如 'btChart' / 'btChartIndex'）
   * @param {object} chart ECharts 实例
   * @param {function} getOpts 提供绘图区几何信息的函数
   */
  function attach(domId, chart, getOpts) {
    if (!chart) return;
    // 同 domId 重复 attach 时，只解绑**本模块自己注册的**处理器。
    // ⚠ 不能用 chart.off('mousemove')（无 handler 参数）—— 那会清掉该事件下
    //   所有处理器，连页面自身的光标/十字线逻辑一起干掉。
    var prev = instances[domId];
    if (prev && prev.chart) {
      if (prev.onMousemove) { try { prev.chart.off('mousemove', prev.onMousemove); } catch (e) {} }
      if (prev.onUpdateAxisPointer) { try { prev.chart.off('updateAxisPointer', prev.onUpdateAxisPointer); } catch (e) {} }
      if (prev.onZrMove && prev.chart.getZr) { try { prev.chart.getZr().off('mousemove', prev.onZrMove); } catch (e) {} }
    }
    if (prev && prev.overlay && prev.overlay.parentNode) prev.overlay.parentNode.removeChild(prev.overlay);

    var inst = {
      domId: domId, chart: chart, getOpts: getOpts || function () { return {}; },
      overlay: null, ctx2d: null, dpr: 1, visible: false,
      onMousemove: null, onUpdateAxisPointer: null, onZrMove: null
    };
    instances[domId] = inst;

    ensureCanvas(inst);
    syncSize(inst);

    var onHover = function (idx) {
      // idx 非法时**不清除**：光标常驻，保留上一次的有效位置。
      // （ECharts 兜底事件里 dataIndex 可能为 undefined，以前会直接把光标清掉。）
      if (idx == null || idx < 0) { return; }
      var o = inst.getOpts(idx) || {};
      draw(inst, idx, o);
    };

    // 通知页面"当前没有 hover 任何 K 线"（移出图表 / 落在无 K 线区域）
    // 页面据此启动"2 秒后归位到窗口最右一根"的计时。
    var notifyLeave = function (o) {
      o = o || inst.getOpts() || {};
      if (typeof o.onHoverLeave === 'function') o.onHoverLeave();
    };

    // ★ 事件源（实测结论）：
    //   - chart 'mousemove'：tooltip.show=false 时实测 0 次触发，拿不到 dataIndex
    //   - chart 'updateAxisPointer'：能触发，但 axesInfo 实测为空数组 []（拿不到 value）
    //     （这正是页面旧注释里提到过的"link 配置错误导致 axesInfo=[]"的老问题）
    // 因此改为**直接监听 zrender 的 mousemove**，用 offsetX 自行换算索引：
    //   chart.convertFromPixel({ xAxisIndex: 0 }, offsetX) → K线索引
    // 这样完全绕开 ECharts 的事件分发与坐标轴解析，行为稳定可控。
    var zr = chart.getZr ? chart.getZr() : null;
    if (zr && zr.on) {
      var onZrMove = function (e) {
        var offX = e && e.offsetX;
        if (offX == null) return;
        var offY = e && e.offsetY;
        var o = inst.getOpts() || {};
        var idx = chart.convertFromPixel({ xAxisIndex: 0 }, offX);
        // convertFromPixel 可能返回小数，取整并做边界校验
        if (idx == null || isNaN(idx)) { notifyLeave(o); return; }
        idx = Math.round(idx);
        // ★ 边界钳制：鼠标落在绘图区**之外**（左侧 y 轴刻度、右侧留白、
        //   底部缩放滑块等）时，convertFromPixel 仍会换算出一个索引，
        //   导致"没有 K 线的地方也出现光标，显示范围与实际可见 K 线不一致"。
        //
        //   ★ 这里"忽略本次移动"而不是"隐藏光标"：光标常驻语义下，
        //     鼠标只是路过图外（例如去点右上角按钮），光标应停在原位。
        //     同时通知页面"当前没有 hover 任何 K 线"，由页面决定 2 秒后归位。
        if (o.plotLeft != null && o.plotRight != null) {
          if (offX < o.plotLeft || offX > o.plotRight) { notifyLeave(o); return; }
        }
        if (o.minIdx != null && o.maxIdx != null &&
            !isNaN(o.minIdx) && !isNaN(o.maxIdx)) {
          var lo = Math.min(o.minIdx, o.maxIdx);
          var hi = Math.max(o.minIdx, o.maxIdx);
          if (idx < lo || idx > hi) { notifyLeave(o); return; }
        }
        // ★ 纵向同理：底部 dataZoom 滑块不在 K 线区域内，
        //   指针在那里时应让位给拖动手势，光标保持在原位
        if (offY != null && o.plotBottom != null && offY > o.plotBottom) {
          notifyLeave(o); return;
        }
        onHover(idx);
        // 回传给页面：驱动另一张图的光标与两侧数据栏（两图互相同步）
        if (typeof o.onHoverIdx === 'function') o.onHoverIdx(idx);
      };
      zr.on('mousemove', onZrMove);
      inst.onZrMove = onZrMove;
      // zrender 的 globalout 同样需要独立解绑
      // ★ 不再在 globalout 里直接 hide：光标要常驻（鼠标移出后仍显示当前位置）。
      //   这里只做"重新绘制"清残影，并通知页面"已不再 hover"。
      zr.on('globalout', function () {
        var o = inst.getOpts() || {};
        notifyLeave(o);
        if (typeof global.BT_repaintCrosshair === 'function') global.BT_repaintCrosshair();
      });
    }

    // 仍保留 ECharts 事件作为补充（部分场景下 mousemove / showTip 可用）
    var onUpdate = function (event) {
      var info = event && event.axesInfo && event.axesInfo[0];
      if (!info || info.value === undefined || info.value === null) return;
      onHover(info.value);
    };
    var onMove = function (params) {
      onHover(params && params.dataIndex);
    };
    inst.onUpdateAxisPointer = onUpdate;
    inst.onMousemove = onMove;

    chart.on('updateAxisPointer', onUpdate);
    chart.on('mousemove', onMove);
    // ★ 同样不在 globalout / mouseout 里清掉光标（光标常驻语义），
    //   但要通知页面"已不再 hover" → 启动 2 秒后归位到最右一根。
    chart.on('globalout', function () {
      notifyLeave();
      if (typeof global.BT_repaintCrosshair === 'function') global.BT_repaintCrosshair();
    });
    if (chart.getZr) {
      chart.getZr().on('globalout', function () {
        notifyLeave();
        if (typeof global.BT_repaintCrosshair === 'function') global.BT_repaintCrosshair();
      });
    }
  }

  function detach(domId) {
    var inst = instances[domId];
    if (!inst) return;
    // 只解绑本模块注册的 handler（off 不传 handler 会清空全部，误伤页面逻辑）
    if (inst.chart && inst.onMousemove) { try { inst.chart.off('mousemove', inst.onMousemove); } catch (e) {} }
    if (inst.chart && inst.onUpdateAxisPointer) { try { inst.chart.off('updateAxisPointer', inst.onUpdateAxisPointer); } catch (e) {} }
    if (inst.chart && inst.onZrMove && inst.chart.getZr) { try { inst.chart.getZr().off('mousemove', inst.onZrMove); } catch (e) {} }
    if (inst.overlay && inst.overlay.parentNode) inst.overlay.parentNode.removeChild(inst.overlay);
    delete instances[domId];
  }

  // 提供全局重绘入口：光标"常驻"，鼠标移出 / 容器尺寸变化时
  // 由页面（backtest-chart.js 的 BT_paintCrosshair）决定画在哪里 / 是否隐藏。
  global.BT_repaintCrosshair = function () {
    if (typeof global.BT_paintCrosshair === 'function') global.BT_paintCrosshair();
  };

  global.BT_crosshair = {
    attach: attach,
    detach: detach,
    /**
     * 由外部（例如另一张图 hover 时）指定下标绘制光标。
     * 只画线，不回调 onHover / onHoverIdx，避免两图互相触发形成死循环。
     */
    drawAt: function (domId, idx) {
      var inst = instances[domId];
      if (!inst || idx == null || isNaN(idx)) return;
      syncSize(inst);
      draw(inst, idx, inst.getOpts() || {});
    },
    /** 隐藏指定图表的光标 */
    hideAt: function (domId) {
      var inst = instances[domId];
      if (inst) hide(inst);
    },
    /** 容器尺寸变化后同步所有已绑定图表的 overlay 尺寸并重绘 */
    redraw: function () {
      Object.keys(instances).forEach(function (k) {
        var inst = instances[k];
        syncSize(inst);
      });
      // 尺寸同步完再由页面按当前光标重绘（光标常驻）
      if (typeof global.BT_repaintCrosshair === 'function') global.BT_repaintCrosshair();
    }
  };
})(window);