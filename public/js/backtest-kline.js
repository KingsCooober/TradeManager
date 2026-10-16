/**
 * backtest-kline.js — 回测模块K线图（klinecharts 10.0.2 实现）
 *
 * 取代 backtest-chart.js 的 ECharts 主图 + 指数图实现。
 * 对外 BT_* 全局入口与 backtest-chart.js 同名同签名，backtest-main.js / backtest-trade.js 零改动依赖。
 *
 * 依赖（backtest.html 中先于本文件加载）：
 *   public/js/vendor/klinecharts.min.js  (全局 klinecharts)
 *
 * 交互语义（与原 ECharts 版保持一致）：
 *   - 索引窗口 [BT_winStartIdx, BT_winEndIdx] 闭区间，光标在窗内窗口不动，越界窗口贴边跟随
 *   - 可见根数连续可变 [15, 500]，滚轮连续缩放，锚点保持相对位置
 *   - hover 联动主图/指数图，2 秒无操作光标归位窗口最右
 *   - 右栏数据面板（tooltip 已废弃，v=70 起）
 *   - 量比 > 1.71 量柱高亮、VOL5 线、MA 1~6 条、红涨绿跌 #ef476f/#2d9f7f
 */
/* global klinecharts */
(function () {
	'use strict';

	// ============ 常量 ============
	var KC = (typeof klinecharts !== 'undefined') ? klinecharts : null;

	var BT_MIN_CHART_H = 240;
	var BT_MAX_CHART_H = 432;
	var BT_VISIBLE_BARS_MIN = 15;
	var BT_VISIBLE_BARS_MAX = 500;
	var BT_DEFAULT_VISIBLE_BARS = 90;
	var BT_ZOOM_STEP = 1.15;
	var BT_HOVER_IDLE_MS = 2000;
	var BT_COLOR_UP = '#ef476f';
	var BT_COLOR_DOWN = '#2d9f7f';
	var BT_VOL_HIGHLIGHT_RATIO = 1.71;
	// 量柱放量高亮色（涨/跌 × 底色/边框）
	var BT_VOL_HL = {
		up: { color: '#ff1744', border: '#d50000' },
		down: { color: '#00e676', border: '#00c853' }
	};
	var BT_VOL_MA5_COLOR = '#374151';
	// MA 色板（亮/暗）
	var BT_MA_COLORS = {
		light: ['#374151', '#C99700', '#2563EB', '#7C3AED', '#0891B2', '#DB2777'],
		dark: ['#CBD5E1', '#E0A800', '#5B8DEF', '#A78BFA', '#22D3EE', '#F472B6']
	};
	// 主图 pane id（klinecharts 内置蜡烛图 pane）
	var PANE_CANDLE = 'candle_pane';
	var OVERLAY_NAME = 'bt_trade_marker';
	var IND_MA = 'BT_MA';
	var IND_VOL = 'BT_VOL';

	// ============ 全局状态 ============
	var BT_chart = null;           // 主图 klinecharts 实例
	var BT_indexChart = null;      // 指数图 klinecharts 实例
	var BT_indexData = null;       // 指数图数据 {dates, ohlc, volumes, name}
	var BT_klineData = null;       // 主图数据 {dates, ohlc:[o,c,l,h], volumes, _volMA5, _prev5Avg, count, __period}
	var BT_maPeriods = [5, 10, 20];
	var BT_MA_DEFAULT = [5, 10, 20];
	var BT_showFlags = { ma: true, vol: true };
	var BT_currentIdx = 0;
	var BT_visibleBars = BT_DEFAULT_VISIBLE_BARS;
	var BT_winStartIdx = 0;
	var BT_winEndIdx = 0;
	var BT_currentDate = '';
	var BT_currentClose = null;
	// 注意：BT_currentSymbol / BT_currentSymbolName 不做本地副本——
	// main.js 直接写这两个全局（:703-704、:943-947），本模块读写均走 window 全局，避免 _syncGlobals 回写覆盖。
	// 注意：BT_trades 不做本地副本——backtest-trade.js（先于本文件加载）声明并重新赋值该全局
	// （BT_loadTrades/清空/导入导出路径），本模块只读 global.BT_trades，不初始化不回写。
	var BT_dateIndex = {};         // date -> idx（主图）
	var BT_indexDateIndex = {};    // date -> idx（指数图）
	var BT_initialWindowDone = false;
	var BT_hoverIdleTimer = null;
	var BT_hoverActive = false;
	var BT_cursorRAF = null;
	var BT_indexInfoRAF = null;
	var BT_fitRAF = null;
	// 防联动回环：正在由代码驱动另一图 crosshair
	var BT_crosshairSyncing = false;
	// 防窗口同步回环：正在由代码驱动指数图窗口
	var BT_indexWindowSyncing = false;

	// 暴露到全局（main.js / trade.js / 其他模块依赖）
	global.BT_chart = null; // 不再是 echarts 实例，保留名字供诊断（值同 BT_chart）
	global.BT_klineData = null;
	global.BT_maPeriods = BT_maPeriods;
	global.BT_showFlags = BT_showFlags;
	global.BT_currentIdx = BT_currentIdx;
	global.BT_visibleBars = BT_visibleBars;
	global.BT_winStartIdx = BT_winStartIdx;
	global.BT_winEndIdx = BT_winEndIdx;
	// BT_currentSymbol / BT_currentSymbolName / BT_trades 均归其他模块所有：
	// 只初始化不回写（main.js 写 symbol，trade.js 写 trades）
	global.BT_MA_DEFAULT = BT_MA_DEFAULT;
	global.BT_MIN_CHART_H = BT_MIN_CHART_H;
	global.BT_MAX_CHART_H = BT_MAX_CHART_H;
	global.BT_VISIBLE_BARS_MIN = BT_VISIBLE_BARS_MIN;
	global.BT_VISIBLE_BARS_MAX = BT_VISIBLE_BARS_MAX;
	global.BT_DEFAULT_VISIBLE_BARS = BT_DEFAULT_VISIBLE_BARS;
	global.BT_ZOOM_STEP = BT_ZOOM_STEP;
	global.BT_HOVER_IDLE_MS = BT_HOVER_IDLE_MS;
	global.BT_COLOR_UP = BT_COLOR_UP;
	global.BT_COLOR_DOWN = BT_COLOR_DOWN;

	// ============ 小工具 ============
	function _g(name) { return global[name]; }
	function _setG(name, v) { global[name] = v; }

	function _syncGlobals() {
		_setG('BT_klineData', BT_klineData);
		_setG('BT_maPeriods', BT_maPeriods);
		_setG('BT_showFlags', BT_showFlags);
		_setG('BT_currentIdx', BT_currentIdx);
		_setG('BT_visibleBars', BT_visibleBars);
		_setG('BT_winStartIdx', BT_winStartIdx);
		_setG('BT_winEndIdx', BT_winEndIdx);
		_setG('BT_chart', BT_chart);
	}

	function _isDark() {
		return document.documentElement.getAttribute('data-theme') === 'dark';
	}

	function _fmtNum(v, digits) {
		if (v === null || v === undefined || isNaN(v)) return '--';
		return Number(v).toFixed(digits === undefined ? 2 : digits);
	}

	function _pct(v) {
		if (v === null || v === undefined || isNaN(v)) return '--';
		var n = Number(v) * 100;
		return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
	}

	// 手 → 股，≥100手 显示万股
	function BT_formatVolume(vol) {
		if (vol === null || vol === undefined || isNaN(vol)) return '--';
		var v = Number(vol);
		if (v >= 1000000) return (v / 1000000).toFixed(2) + '亿股';
		if (v >= 10000) return (v / 10000).toFixed(2) + '万股';
		return Math.round(v) + '股';
	}

	// 金额（万元）→ 亿元/万亿
	function BT_formatAmount(amountWan) {
		if (amountWan === null || amountWan === undefined || isNaN(amountWan)) return '--';
		var v = Number(amountWan);
		if (v >= 100000000) return (v / 100000000).toFixed(2) + '万亿';
		if (v >= 10000) return (v / 10000).toFixed(2) + '亿';
		return v.toFixed(0) + '万';
	}

	// ============ 主题色板 ============
	function BT_maColors() {
		return _isDark() ? BT_MA_COLORS.dark.slice() : BT_MA_COLORS.light.slice();
	}

	function _axisTextColor() { return _isDark() ? '#aaa' : '#666'; }
	function _axisLineColor() { return _isDark() ? '#555' : '#ccc'; }
	function _splitLineColor() { return _isDark() ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'; }
	function _crosshairColor() { return _isDark() ? 'rgba(200,200,200,0.55)' : 'rgba(80,80,80,0.55)'; }

	function _buildStyles() {
		var dark = _isDark();
		return {
			grid: {
				show: true,
				horizontal: { show: true, size: 1, color: _splitLineColor(), style: 'dashed', dashedValue: [3, 3] },
				vertical: { show: false, size: 1, color: 'transparent', style: 'solid', dashedValue: [0, 0] }
			},
			candle: {
				type: 'candle_solid',
				bar: {
					compareRule: 'current_open',
					upColor: BT_COLOR_UP,
					downColor: BT_COLOR_DOWN,
					noChangeColor: BT_COLOR_UP,
					upBorderColor: BT_COLOR_UP,
					downBorderColor: BT_COLOR_DOWN,
					noChangeBorderColor: BT_COLOR_UP,
					upWickColor: BT_COLOR_UP,
					downWickColor: BT_COLOR_DOWN,
					noChangeWickColor: BT_COLOR_UP
				},
				area: { show: false },
				priceMark: { show: false },
				tooltip: { show: false, title: { show: false } }
			},
			indicator: {
				ohlc: { compareRule: 'current_open', upColor: BT_COLOR_UP, downColor: BT_COLOR_DOWN, noChangeColor: BT_COLOR_UP },
				bars: [{
					style: 'fill',
					upColor: BT_COLOR_UP,
					downColor: BT_COLOR_DOWN,
					noChangeColor: BT_COLOR_UP,
					borderStyle: 'solid',
					borderSize: 1,
					borderDashedValue: [0, 0]
				}],
				lines: BT_maColors().map(function (c) {
					return { style: 'solid', size: 1.5, color: c, smooth: true, dashedValue: [0, 0] };
				}),
				circles: [],
				texts: [],
				lastValueMark: { show: false },
				tooltip: { show: false, title: { show: false } }
			},
			xAxis: {
				show: true, size: 'auto',
				axisLine: { show: true, size: 1, color: _axisLineColor() },
				tickLine: { show: false, size: 0, color: 'transparent' },
				tickText: { show: true, size: 11, color: _axisTextColor(), family: 'inherit', marginStart: 4, marginEnd: 4 }
			},
			yAxis: {
				show: true, size: 'auto',
				axisLine: { show: true, size: 1, color: _axisLineColor() },
				tickLine: { show: false, size: 0, color: 'transparent' },
				tickText: { show: true, size: 11, color: _axisTextColor(), family: 'inherit', marginStart: 4, marginEnd: 4 }
			},
			separator: { size: 1, color: _splitLineColor(), fill: true, activeBackgroundColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)' },
			crosshair: {
				show: true,
				horizontal: {
					show: true,
					line: { show: true, style: 'dashed', size: 1, color: _crosshairColor(), dashedValue: [4, 3] },
					text: { show: false, size: 11, color: _axisTextColor(), family: 'inherit' }
				},
				vertical: {
					show: true,
					line: { show: true, style: 'dashed', size: 1, color: _crosshairColor(), dashedValue: [4, 3] },
					text: { show: false, size: 11, color: _axisTextColor(), family: 'inherit' }
				}
			},
			overlay: {
				point: { show: false },
				line: { show: false, style: 'solid', size: 1, color: 'transparent', smooth: false, dashedValue: [0, 0] },
				rect: { show: false, style: 'fill', color: 'transparent', borderColor: 'transparent', borderSize: 0, borderStyle: 'solid', borderDashedValue: [0, 0] },
				polygon: { show: false, style: 'fill', color: 'transparent', borderColor: 'transparent', borderSize: 0, borderStyle: 'solid', borderDashedValue: [0, 0] },
				circle: { show: false, style: 'fill', color: 'transparent', borderColor: 'transparent', borderSize: 0, borderStyle: 'solid', borderDashedValue: [0, 0] },
				arc: { show: false, style: 'solid', size: 1, color: 'transparent', dashedValue: [0, 0] },
				text: { show: false, size: 12, color: 'transparent', family: 'inherit' }
			}
		};
	}

	// ============ 数据转换 ============
	// BT_klineData.ohlc 顺序 [open, close, low, high] → klinecharts KLineData
	function _toKLineData(data) {
		var out = [];
		var dates = data.dates, ohlc = data.ohlc, vols = data.volumes;
		for (var i = 0; i < dates.length; i++) {
			var d = dates[i];
			var y = parseInt(d.slice(0, 4), 10);
			var m = parseInt(d.slice(5, 7), 10) - 1;
			var day = parseInt(d.slice(8, 10), 10);
			out.push({
				timestamp: new Date(y, m, day, 0, 0, 0).getTime(),
				open: ohlc[0][i],
				high: ohlc[3][i],
				low: ohlc[2][i],
				close: ohlc[1][i],
				volume: vols[i]
			});
		}
		return out;
	}

	function _parseDateTs(d) {
		return new Date(
			parseInt(d.slice(0, 4), 10),
			parseInt(d.slice(5, 7), 10) - 1,
			parseInt(d.slice(8, 10), 10),
			0, 0, 0
		).getTime();
	}

	// ============ 自定义 MA 指标（支持 1~6 条，calcParams=BT_maPeriods） ============
	function _registerIndicators() {
		if (!KC) return;

		// ---- MA：N 条均线，颜色按 BT_maColors() 主题色板 ----
		KC.registerIndicator({
			name: IND_MA,
			shortName: 'MA',
			series: 'price',
			calcParams: [],
			precision: 2,
			shouldOhlc: true,
			figures: [],
			regenerateFigures: function (calcParams) {
				// 注意：klinecharts v10 传入的是 calcParams 数组本身（不是 {calcParams} 指标对象）
				var figures = [];
				var ps = Array.isArray(calcParams) ? calcParams : (calcParams && calcParams.calcParams) || [];
				for (var i = 0; i < ps.length; i++) {
					figures.push({
						key: 'ma' + (i + 1),
						title: 'MA' + ps[i] + ': ',
						type: 'line'
					});
				}
				return figures;
			},
			calc: function (dataList, indicator) {
				var periods = indicator.calcParams;
				var closes = [];
				for (var i = 0; i < dataList.length; i++) closes.push(dataList[i].close);
				var result = [];
				for (var i = 0; i < dataList.length; i++) {
					var row = {};
					for (var p = 0; p < periods.length; p++) {
						var n = periods[p];
						if (i + 1 < n) { row['ma' + (p + 1)] = null; continue; }
						var sum = 0;
						for (var k = i + 1 - n; k <= i; k++) sum += closes[k];
						row['ma' + (p + 1)] = sum / n;
					}
					result.push(row);
				}
				return result;
			}
		});

		// ---- VOL：量柱 + VOL5 线；量比>1.71 高亮 ----
		// volRatio = 当日成交量 / 前5日均量（_prev5Avg 语义，不含当日）
		KC.registerIndicator({
			name: IND_VOL,
			shortName: 'VOL',
			series: 'volume',
			calcParams: [5],
			precision: 0,
			shouldFormatBigNumber: true,
			figures: [
				{
					key: 'vol5',
					title: 'VOL5: ',
					type: 'line',
					styles: function () { return { color: BT_VOL_MA5_COLOR, style: 'solid', size: 1.5, smooth: true, dashedValue: [0, 0] }; }
				},
				{
					key: 'volume',
					title: 'VOL: ',
					type: 'bar',
					styles: function (params) {
						var data = params.data;
						var cur = data.current;
						var prevBar = data.prev;
						if (!cur || cur.volume == null) return null;
						// calc 里已算好 up 标记（结果行无 close/open，不能直接用）
						var isUp = (cur.up !== undefined) ? cur.up :
							(prevBar && prevBar.close != null && cur.close != null) ? cur.close >= prevBar.close : true;
						var ratio = (cur.prevAvg && cur.prevAvg > 0) ? (cur.volume / cur.prevAvg) : 0;
						var hl = ratio > BT_VOL_HIGHLIGHT_RATIO;
						var base = isUp ? BT_COLOR_UP : BT_COLOR_DOWN;
						if (hl) {
							var h = isUp ? BT_VOL_HL.up : BT_VOL_HL.down;
							return {
								style: 'fill',
								color: h.color,
								borderColor: h.border,
								borderSize: 1,
								borderStyle: 'solid'
							};
						}
						return { style: 'fill', color: base, borderColor: base, borderSize: 1, borderStyle: 'solid' };
					}
				}
			],
			calc: function (dataList, indicator) {
				var n = indicator.calcParams[0] || 5;
				var result = [];
				var sum = 0;
				for (var i = 0; i < dataList.length; i++) {
					var bar = dataList[i];
					sum += bar.volume;
					if (i >= n) sum -= dataList[i - n].volume;
					var avg = i + 1 >= n ? sum / n : null;
					// 量比基准 = 前 n 日均量（不含当日）
					var prevAvg = (i - n >= 0) ? (sum - bar.volume) / n : null;
					// 涨跌判定（首日 fallback open）
					var isUp = (i > 0) ? bar.close >= dataList[i - 1].close : bar.close >= bar.open;
					result.push({
						volume: bar.volume,
						vol5: avg,
						prevAvg: prevAvg,
						up: isUp
					});
				}
				return result;
			}
		});
	}

	// ============ B/S 交易标记 overlay ============
	function _registerOverlay() {
		if (!KC) return;
		// 已注册过则跳过（registerOverlay 全局幂等风险：重名覆盖是允许的，直接注册即可）
		KC.registerOverlay({
			name: OVERLAY_NAME,
			totalStep: 1,     // 单点、即绘即成
			lock: true,
			figures: null,
			createPointFigures: function (params) {
				var overlay = params.overlay;
				var ext = overlay.extendData || {};
				var isBuy = ext.side === 'B';
				var color = isBuy ? BT_COLOR_UP : BT_COLOR_DOWN;
				var coord = params.coordinates[0];
				if (!coord) return [];
				var size = 12;
				// 三角箭头：买指上、卖指下（画布 y 向下为正）
				var tri = isBuy
					? [coord.x, coord.y - size, coord.x - size / 2, coord.y, coord.x + size / 2, coord.y]
					: [coord.x, coord.y + size, coord.x - size / 2, coord.y, coord.x + size / 2, coord.y];
				return [
					{
						key: 'marker',
						type: 'polygon',
						attrs: { coordinates: [{ x: tri[0], y: tri[1] }, { x: tri[2], y: tri[3] }, { x: tri[4], y: tri[5] }] },
						styles: { style: 'fill', color: color, borderColor: color, borderSize: 1 }
					},
					{
						key: 'label',
						type: 'text',
						attrs: { x: coord.x, y: isBuy ? coord.y + 12 : coord.y - 6, text: ext.side, align: 'center', baseline: 'middle' },
						styles: { color: color, size: 10, family: 'inherit', weight: 'bold' }
					}
				];
			}
		});
	}

	// ============ Data Loader ============
	function _makeDataLoader() {
		return {
			getBars: function (params) {
				// 数据全部一次性给入（本地数组），init 一次拉全
				var list = _toKLineData(BT_klineData);
				params.callback(list, false);
			}
		};
	}

	// ============ 窗口模型 ============
	function BT_clampVisibleBars(n) {
		if (typeof n !== 'number' || isNaN(n)) n = BT_DEFAULT_VISIBLE_BARS;
		return Math.max(BT_VISIBLE_BARS_MIN, Math.min(BT_VISIBLE_BARS_MAX, Math.round(n)));
	}

	function BT_getVisibleBars() { return BT_visibleBars; }

	function BT_getWindowRange() {
		return { start: BT_winStartIdx, end: BT_winEndIdx };
	}

	// 总绘图宽度 → barSpace
	function _barSpaceForVisible(vis) {
		if (!BT_chart) return 6;
		var size = BT_chart.getSize(PANE_CANDLE, 'main');
		var w = (size && size.width) ? size.width : 600;
		return Math.max(0.1, w / vis);
	}

	// 索引窗口 → klinecharts 像素窗口（setBarSpace + scrollToDataIndex）
	function BT_applyWindow() {
		if (!BT_chart || !BT_klineData || !BT_klineData.dates.length) return;
		var total = BT_klineData.dates.length;
		var vis = BT_visibleBars;
		BT_winStartIdx = Math.max(0, Math.min(total - vis, BT_winStartIdx));
		BT_winEndIdx = Math.min(total - 1, BT_winStartIdx + vis - 1);
		if (BT_winEndIdx - BT_winStartIdx + 1 < vis) {
			BT_winStartIdx = Math.max(0, BT_winEndIdx - vis + 1);
		}
		var space = _barSpaceForVisible(vis);
		BT_chart.setBarSpace(space);
		BT_chart.scrollToDataIndex(BT_winStartIdx);
		_syncIndexZoom();
	}

	// 光标钉最右初始化窗口
	function BT_initWindow(cursorIdx) {
		if (!BT_klineData) return;
		var total = BT_klineData.dates.length;
		var cur = Math.max(0, Math.min(total - 1, cursorIdx));
		BT_visibleBars = BT_clampVisibleBars(BT_visibleBars);
		BT_winStartIdx = Math.max(0, Math.min(total - BT_visibleBars, cur - BT_visibleBars + 1));
		BT_winEndIdx = Math.min(total - 1, BT_winStartIdx + BT_visibleBars - 1);
		BT_initialWindowDone = true;
		BT_applyWindow();
	}

	// 核心交互语义：光标在窗内窗口不动；越右界→窗口右移光标贴右缘；越左界→左移。
	// 边界判定必须用 `>` / `<`（历史上写成 >= 会导致光标永远停在倒数第2根）。
	function BT_moveCursorTo(targetIdx) {
		if (!BT_klineData || !BT_klineData.dates.length) return;
		var total = BT_klineData.dates.length;
		var t = Math.max(0, Math.min(total - 1, targetIdx));
		var prevCursor = BT_currentIdx;
		BT_currentIdx = t;
		if (t > BT_winEndIdx) {
			BT_winStartIdx = Math.max(0, Math.min(total - BT_visibleBars, t - BT_visibleBars + 1));
			BT_winEndIdx = Math.min(total - 1, BT_winStartIdx + BT_visibleBars - 1);
			BT_applyWindow();
		} else if (t < BT_winStartIdx) {
			BT_winStartIdx = Math.max(0, t);
			BT_winEndIdx = Math.min(total - 1, BT_winStartIdx + BT_visibleBars - 1);
			BT_applyWindow();
		}
		if (t !== prevCursor) {
			_setCrosshairOn(BT_chart, t, true);
			_setCrosshairOn(BT_indexChart, BT_mapMainIdxToIndex(t), true);
		}
		_syncGlobals();
		BT_updateCursorDisplay();
		if (typeof global.BT_renderStats === 'function') global.BT_renderStats();
		BT_syncIndexInfo();
		BT_saveCursorState();
	}

	// ============ 缩放 ============
	// 锚点相对位置保持：anchorIdx 在窗口中的 ratio 不变
	function BT_zoomBy(factor, anchorIdx) {
		if (!BT_klineData || !BT_klineData.dates.length) return;
		var total = BT_klineData.dates.length;
		var anchor = (anchorIdx === null || anchorIdx === undefined) ?
			((BT_currentIdx >= BT_winStartIdx && BT_currentIdx <= BT_winEndIdx) ? BT_currentIdx : BT_winEndIdx) :
			anchorIdx;
		var ratio = (BT_winEndIdx - BT_winStartIdx > 0) ? (anchor - BT_winStartIdx) / (BT_winEndIdx - BT_winStartIdx) : 0;
		var newVis = BT_clampVisibleBars(BT_visibleBars / factor);
		if (newVis === BT_visibleBars) return; // 已到边界
		BT_visibleBars = newVis;
		var start = Math.round(anchor - ratio * (newVis - 1));
		BT_winStartIdx = Math.max(0, Math.min(total - newVis, start));
		BT_winEndIdx = Math.min(total - 1, BT_winStartIdx + newVis - 1);
		BT_applyWindow();
		BT_syncVisibleBarsSelect();
		BT_refreshChartMarkers();
		BT_paintCrosshair();
		_syncGlobals();
		BT_saveCursorState();
	}

	function BT_zoomIn() { BT_zoomBy(BT_ZOOM_STEP, null); }
	function BT_zoomOut() { BT_zoomBy(1 / BT_ZOOM_STEP, null); }

	// 下拉框：固定可见根数
	function BT_zoomToBars(bars) {
		if (!BT_klineData || !BT_klineData.dates.length) return;
		var total = BT_klineData.dates.length;
		var vis = BT_clampVisibleBars(bars);
		var anchor = (BT_currentIdx >= BT_winStartIdx && BT_currentIdx <= BT_winEndIdx) ? BT_currentIdx : BT_winEndIdx;
		var ratio = (BT_winEndIdx - BT_winStartIdx > 0) ? (anchor - BT_winStartIdx) / (BT_winEndIdx - BT_winStartIdx) : 1;
		BT_visibleBars = vis;
		var start = Math.round(anchor - ratio * (vis - 1));
		BT_winStartIdx = Math.max(0, Math.min(total - vis, start));
		BT_winEndIdx = Math.min(total - 1, BT_winStartIdx + vis - 1);
		BT_applyWindow();
		BT_syncVisibleBarsSelect();
		BT_refreshChartMarkers();
		BT_paintCrosshair();
		_syncGlobals();
		BT_saveCursorState();
	}

	// 下拉框 change 入口（main.js 挂在 #btVisibleBars 上）
	function BT_applyVisibleBars() {
		var sel = document.getElementById('btVisibleBars');
		if (!sel) return;
		var v = parseInt(sel.value, 10);
		if (!isNaN(v)) BT_zoomToBars(v);
	}

	// ============ hover 空闲归位 ============
	function BT_noteHoverActive() {
		BT_hoverActive = true;
		if (BT_hoverIdleTimer) { clearTimeout(BT_hoverIdleTimer); BT_hoverIdleTimer = null; }
	}

	function BT_scheduleHoverIdleJump() {
		BT_hoverActive = false;
		if (BT_hoverIdleTimer) clearTimeout(BT_hoverIdleTimer);
		BT_hoverIdleTimer = setTimeout(function () {
			BT_hoverIdleTimer = null;
			BT_jumpToWindowRightEdge();
		}, BT_HOVER_IDLE_MS);
	}

	function BT_jumpToWindowRightEdge() {
		if (!BT_klineData || !BT_klineData.dates.length) return;
		BT_moveCursorTo(BT_winEndIdx);
	}

	// ============ 日期映射（主图 ↔ 指数图，停牌日兜底最近交易日） ============
	function _buildDateIndex(dates, store) {
		store = {};
		for (var i = 0; i < dates.length; i++) store[dates[i]] = i;
		return store;
	}

	// 主图 idx → 指数图 idx（指数 ≤ 主图日期的最大索引）
	function BT_mapMainIdxToIndex(idx) {
		if (!BT_indexData || !BT_indexData.dates.length || !BT_klineData) return null;
		var d = BT_klineData.dates[idx];
		var dates = BT_indexData.dates;
		// 二分：最后一个 <= d 的索引
		var lo = 0, hi = dates.length - 1, ans = -1;
		while (lo <= hi) {
			var mid = (lo + hi) >> 1;
			if (dates[mid] <= d) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
		}
		if (ans < 0) return 0;
		return ans;
	}

	// 指数图 idx → 主图 idx（主图 ≥ 指数日期的最小索引）
	function BT_mapIndexIdxToMain(idx) {
		if (!BT_indexData || !BT_klineData) return null;
		var d = BT_indexData.dates[idx];
		var dates = BT_klineData.dates;
		var lo = 0, hi = dates.length - 1, ans = -1;
		while (lo <= hi) {
			var mid = (lo + hi) >> 1;
			if (dates[mid] >= d) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
		}
		if (ans < 0) return dates.length - 1;
		return ans;
	}

	// ============ crosshair 驱动 ============
	// 在 chart 上把 crosshair 钉在 dataIndex；若 silent=true 不派发 onCrosshairChange（防回环）。
	// 注意：klinecharts setCrosshair 内部只读 x 像素 → 必须先换算像素坐标。
	function _setCrosshairOn(chart, idx, silent) {
		if (!chart || !KC) return;
		var data = chart.getDataList();
		if (!data || !data.length) return;
		var i = Math.max(0, Math.min(data.length - 1, idx));
		var bar = data[i];
		// dataIndex → x 像素（用 value 供水平线定位）
		var px = chart.convertToPixel({ dataIndex: i, value: bar.close }, { paneId: PANE_CANDLE });
		var opt = { notExecuteAction: !!silent };
		if (px && px.x !== undefined) {
			chart.setCrosshair({ x: px.x, y: px.y }, opt);
		} else {
			// 换算失败（尺寸未就绪等）退化为仅清空重画
			chart.setCrosshair({}, opt);
		}
	}

	function BT_crosshairMoveTo(idx, from) {
		if (from === 'main') _setCrosshairOn(BT_chart, idx, true);
		else if (from === 'index') _setCrosshairOn(BT_indexChart, idx, true);
	}

	function BT_hideCrosshairAt(domId) {
		// klinecharts crosshair 常驻策略：hover 离开不清空，仅由 idle jump 归位
		// 保留接口签名兼容旧调用
	}

	// ============ 几何 ============
	// 兼容 backtest-draw.js 的签名（该文件已确认死代码，保底）
	function BT_getPlotGeom(chart, isMain) {
		var c = chart || BT_chart;
		if (!c || !KC) return null;
		var size = c.getSize(PANE_CANDLE, 'main');
		if (!size) return null;
		var dataList = c.getDataList();
		// 绘图区左右边界对应的索引
		var left = c.convertFromPixel([{ x: size.left }, { x: size.left }], { paneId: PANE_CANDLE });
		var right = c.convertFromPixel([{ x: size.right - 1 }, { x: size.right - 1 }], { paneId: PANE_CANDLE });
		var minIdx = (left && left.dataIndex !== undefined) ? Math.ceil(left.dataIndex) : 0;
		var maxIdx = (right && right.dataIndex !== undefined) ? Math.floor(right.dataIndex) : (dataList ? dataList.length - 1 : 0);
		return {
			plotLeft: size.left,
			plotRight: size.right,
			plotTop: size.top,
			plotBottom: size.bottom,
			width: size.width,
			height: size.height,
			minIdx: minIdx,
			maxIdx: maxIdx
		};
	}

	function BT_isInsidePlot(chart, x, y) {
		var g = BT_getPlotGeom(chart, true);
		if (!g) return false;
		return x >= g.plotLeft && x <= g.plotRight && y >= g.plotTop && y <= g.plotBottom;
	}

	// ============ crosshair 事件（主图/指数图联动） ============
	function _attachChartEvents(chart, source) {
		if (!chart || !KC) return;

		chart.subscribeAction('onCrosshairChange', function (data) {
			if (BT_crosshairSyncing) return;
			var d = data || {};
			var idx = d.dataIndex;
			if (idx === undefined || idx === null) return;
			BT_noteHoverActive();
			if (source === 'main') {
				BT_onCursorMove(idx);
				// 指数图跟随
				var mi = BT_mapMainIdxToIndex(idx);
				if (mi !== null && BT_indexChart) {
					BT_crosshairSyncing = true;
					try { _setCrosshairOn(BT_indexChart, mi, true); } finally { BT_crosshairSyncing = false; }
				}
			} else if (source === 'index') {
				var mj = BT_mapIndexIdxToMain(idx);
				if (mj !== null) {
					BT_crosshairSyncing = true;
					try {
						_setCrosshairOn(BT_chart, mj, true);
					} finally { BT_crosshairSyncing = false; }
					BT_onCursorMove(mj);
				}
				BT_scheduleIndexInfoRender();
			}
		});

		chart.subscribeAction('onMouseLeave', function () {
			// 常驻光标策略：不主动清空，等待 idle jump 归位
			BT_scheduleHoverIdleJump();
		});

		// 用户滚轮/拖拽 → 反推窗口（只记状态不回写，对应原 dataZoom handler 策略）
		chart.subscribeAction('onVisibleRangeChange', function () {
			if (source !== 'main') return;
			if (!BT_chart || !BT_klineData || !BT_klineData.dates.length) return;
			var vr = BT_chart.getVisibleRange();
			var from = Math.max(0, Math.floor(vr.from));
			var to = Math.min(BT_klineData.dates.length - 1, Math.ceil(vr.to));
			if (to < from) to = from;
			var vis = BT_clampVisibleBars(to - from + 1);
			BT_winStartIdx = from;
			BT_winEndIdx = Math.min(BT_klineData.dates.length - 1, from + vis - 1);
			BT_visibleBars = vis;
			BT_syncVisibleBarsSelect();
			BT_refreshChartMarkers();
			_syncIndexZoom();
			_syncGlobals();
			BT_saveCursorState();
		});
	}

	// ============ 光标移动（hover 主链路） ============
	function BT_onCursorMove(idx) {
		if (!BT_klineData) return;
		var total = BT_klineData.dates.length;
		BT_currentIdx = Math.max(0, Math.min(total - 1, idx));
		// hover 不移动窗口（只有 BT_moveCursorTo 的越界才动窗口）
		if (BT_cursorRAF) return;
		BT_cursorRAF = requestAnimationFrame(function () {
			BT_cursorRAF = null;
			BT_updateCursorDisplay();
			if (typeof global.BT_renderStats === 'function') global.BT_renderStats();
			BT_syncIndexInfo();
			_syncGlobals();
			BT_saveCursorState();
		});
	}

	// rAF 合并渲染（原 renderStats + display + crosshair）
	function BT_scheduleCursorRender() {
		if (BT_cursorRAF) return;
		BT_cursorRAF = requestAnimationFrame(function () {
			BT_cursorRAF = null;
			BT_updateCursorDisplay();
			if (typeof global.BT_renderStats === 'function') global.BT_renderStats();
			BT_syncIndexInfo();
		});
	}

	function BT_scheduleIndexInfoRender() {
		if (BT_indexInfoRAF) return;
		BT_indexInfoRAF = requestAnimationFrame(function () {
			BT_indexInfoRAF = null;
			BT_updateIndexInfo();
		});
	}

	function BT_syncIndexInfo() {
		BT_scheduleIndexInfoRender();
	}

	// ============ 指数图窗口同步 ============
	function _syncIndexZoom() {
		if (!BT_indexChart || !BT_klineData || !BT_indexData) return;
		if (BT_indexWindowSyncing) return;
		BT_indexWindowSyncing = true;
		try {
			var total = BT_klineData.dates.length;
			var startIdx = Math.max(0, Math.min(total - 1, BT_winStartIdx));
			var endIdx = Math.max(0, Math.min(total - 1, BT_winEndIdx));
			var iStart = BT_mapMainIdxToIndex(startIdx);
			var iEnd = BT_mapMainIdxToIndex(endIdx);
			if (iStart === null || iEnd === null) return;
			var iTotal = BT_indexData.dates.length;
			var vis = Math.max(1, iEnd - iStart + 1);
			var space = Math.max(0.1, _indexPlotWidth() / vis);
			BT_indexChart.setBarSpace(space);
			BT_indexChart.scrollToDataIndex(Math.max(0, Math.min(iTotal - 1, iStart)));
		} finally {
			BT_indexWindowSyncing = false;
		}
	}

	function _indexPlotWidth() {
		if (!BT_indexChart) return 600;
		var size = BT_indexChart.getSize(PANE_CANDLE, 'main');
		return (size && size.width) ? size.width : 600;
	}

	function BT_syncIndexZoom() { _syncIndexZoom(); }

	function BT_syncIndexCursor(idx) {
		if (!BT_indexChart) return;
		var mi = BT_mapMainIdxToIndex(idx);
		if (mi !== null) _setCrosshairOn(BT_indexChart, mi, true);
	}

	function BT_pinIndexZoomToLatest() {
		if (!BT_indexChart || !BT_indexData || !BT_indexData.dates.length) return;
		var total = BT_indexData.dates.length;
		var vis = Math.min(BT_visibleBars, total);
		BT_indexChart.setBarSpace(_indexPlotWidth() / vis);
		BT_indexChart.scrollToDataIndex(Math.max(0, total - vis));
	}

	// ============ 光标显示（右栏 DOM） ============
	function BT_updateCursorDisplay() {
		if (!BT_klineData) return;
		var d = BT_klineData;
		var i = BT_currentIdx;
		var total = d.dates.length;
		if (i < 0 || i >= total) return;
		var o = d.ohlc[0][i], c = d.ohlc[1][i], l = d.ohlc[2][i], h = d.ohlc[3][i];
		var vol = d.volumes[i];
		var prevClose = (i > 0) ? d.ohlc[1][i - 1] : o;
		var pct = prevClose ? (c - prevClose) / prevClose : 0;

		BT_currentDate = d.dates[i];
		BT_currentClose = c;
		_setG('BT_currentDate', BT_currentDate);
		_setG('BT_currentClose', BT_currentClose);

		_setText('curDate', d.dates[i]);
		_setText('curSymbolName', _g('BT_currentSymbolName') || (_g('BT_currentSymbol') || '--'));
		_setText('curOpen', _fmtNum(o));
		_setText('curClose', _fmtNum(c));
		_setText('curHigh', _fmtNum(h)); // ohlc[3] = high
		_setText('curLow', _fmtNum(l));  // ohlc[2] = low
		var pctEl = document.getElementById('curPct');
		if (pctEl) {
			pctEl.textContent = _pct(pct);
			pctEl.style.color = pct > 0 ? BT_COLOR_UP : (pct < 0 ? BT_COLOR_DOWN : 'inherit');
		}
		_setText('curVol', BT_formatVolume(vol));
		_setText('curVolMa5', d._volMA5 ? BT_formatVolume(d._volMA5[i]) : '--');

		// 量比
		var ratio = (d._prev5Avg && d._prev5Avg[i]) ? vol / d._prev5Avg[i] : null;
		var ratioEl = document.getElementById('curRatio');
		if (ratioEl) {
			if (ratio === null || isNaN(ratio)) { ratioEl.textContent = '--'; ratioEl.style.color = '#666'; }
			else {
				ratioEl.textContent = ratio.toFixed(2);
				ratioEl.style.color = (ratio >= 2) ? BT_COLOR_UP : (ratio >= 1.5) ? BT_COLOR_UP :
					(ratio < 0.5) ? BT_COLOR_DOWN : (ratio < 0.8) ? BT_COLOR_DOWN : '#666';
			}
		}

		BT_fillMaValues('curMa', i);
	}

	function _setText(id, text) {
		var el = document.getElementById(id);
		if (el) el.textContent = (text === null || text === undefined) ? '--' : String(text);
	}

	// ============ MA 行渲染 / 回填 ============
	function BT_renderMaList(containerId, prefix) {
		var container = document.getElementById(containerId);
		if (!container) return;
		container.innerHTML = '';
		var colors = BT_maColors();
		for (var i = 0; i < BT_maPeriods.length; i++) {
			var row = document.createElement('div');
			row.className = 'ma-row';
			var dot = document.createElement('span');
			dot.className = 'ma-dot';
			dot.style.background = colors[i % colors.length];
			var label = document.createElement('span');
			label.className = 'ma-label';
			label.textContent = 'MA' + BT_maPeriods[i];
			var val = document.createElement('span');
			val.className = 'ma-val';
			val.id = prefix + 'MaVal' + i;
			val.textContent = '--';
			row.appendChild(dot);
			row.appendChild(label);
			row.appendChild(val);
			container.appendChild(row);
		}
	}

	function BT_fillMaValues(containerId, idx) {
		// containerId: 'curMa' | 'idxMa'；idx 是当前光标索引
		var prefix = (containerId === 'idxMa') ? 'idx' : 'cur';
		if (containerId === 'idxMa') {
			// 指数图 MA
			if (!BT_indexData || !BT_indexData.maLines) return;
			var iIdx = BT_mapMainIdxToIndex(BT_currentIdx);
			if (iIdx === null) return;
			for (var i = 0; i < BT_maPeriods.length; i++) {
				var el = document.getElementById('idxMaVal' + i);
				if (!el) continue;
				var line = BT_indexData.maLines[i];
				var v = (line && line[iIdx] !== undefined) ? line[iIdx] : null;
				el.textContent = (v === null || v === undefined) ? '--' : _fmtNum(v);
			}
			return;
		}
		// 主图 MA
		if (!BT_klineData || !BT_klineData.maLines) return;
		for (var i = 0; i < BT_maPeriods.length; i++) {
			var el = document.getElementById('curMaVal' + i);
			if (!el) continue;
			var line = BT_klineData.maLines[i];
			var v = (line && line[idx] !== undefined) ? line[idx] : null;
			el.textContent = (v === null || v === undefined) ? '--' : _fmtNum(v);
		}
	}

	// ============ MA 计算（含 WeakMap 记忆化，兼容旧签名） ============
	var _maCache = new WeakMap();

	function BT_computeMAFromCloses(ohlc, n) {
		var closes = BT_getCloses(ohlc);
		if (!closes.length || n <= 0) return [];
		var cached = _maCache.get(closes);
		var byN = cached || {};
		var key = 'n' + n;
		if (cached && cached[key]) return cached[key];
		var out = new Array(closes.length);
		var sum = 0;
		for (var i = 0; i < closes.length; i++) {
			sum += closes[i];
			if (i >= n) sum -= closes[i - n];
			out[i] = (i + 1 >= n) ? sum / n : null;
		}
		byN[key] = out;
		_maCache.set(closes, byN);
		return out;
	}

	function BT_getCloses(ohlc) {
		if (!ohlc || !ohlc[1]) return [];
		return ohlc[1]; // ohlc[1] = close 数组
	}

	// ============ 指数图 ============
	function BT_initIndexChart() {
		if (!KC) return;
		var dom = document.getElementById('btChartIndex');
		if (!dom) return;
		if (BT_indexChart) { try { KC.dispose(BT_indexChart); } catch (e) {} BT_indexChart = null; }
		BT_indexChart = KC.init(dom, {
			styles: _buildStyles(),
			layout: { barSpaceLimit: { min: 0.1, max: 500 } }
		});
		if (!BT_indexChart) return;
		BT_indexChart.setSymbol({ ticker: 'index', pricePrecision: 2, volumePrecision: 0 });
		BT_indexChart.setPeriod({ type: 'day', span: 1 });
		BT_indexChart.setDataLoader(_makeIndexDataLoader());
		BT_indexChart.setZoomEnabled(false);
		BT_indexChart.setScrollEnabled(false);
		_attachChartEvents(BT_indexChart, 'index');
		// 指数图 VOLUME pane 初始隐藏（跟主图 showVol 联动在 renderIndexChart 中处理）
	}

	function _makeIndexDataLoader() {
		return {
			getBars: function (params) {
				if (!BT_indexData) { params.callback([], false); return; }
				params.callback(_toKLineData(BT_indexData), false);
			}
		};
	}

	function BT_renderIndexChart(data, indexName) {
		if (!BT_indexChart || !KC) return;
		// 日期裁剪到主图 [首根, 末根]
		var trimmed = _trimToMainRange(data);
		BT_indexData = trimmed;
		BT_indexData.name = indexName || trimmed.name || '';
		BT_indexData.maLines = [];
		var closes = trimmed.ohlc[1];
		for (var i = 0; i < BT_maPeriods.length; i++) {
			BT_indexData.maLines.push(BT_computeMAFromCloses(trimmed.ohlc, BT_maPeriods[i]));
		}

		BT_indexChart.setSymbol({ ticker: 'index', pricePrecision: 2, volumePrecision: 0 });
		BT_indexChart.setPeriod({ type: 'day', span: 1 });
		BT_indexChart.resetData(); // 触发 getBars 重新拉

		// MA 指标重建
		_rebuildIndicators(BT_indexChart, { ma: true, vol: true });

		// 标题
		var titleEl = document.getElementById('indexTitle');
		if (titleEl) titleEl.textContent = BT_indexData.name;

		BT_updateIndexInfo(true);
		_syncIndexZoom();
		if (!BT_klineData || !BT_klineData.dates.length) BT_pinIndexZoomToLatest();
	}

	// 裁剪指数数据到主图日期范围
	function _trimToMainRange(data) {
		if (!BT_klineData || !BT_klineData.dates.length) return data;
		var firstDate = BT_klineData.dates[0];
		var lastDate = BT_klineData.dates[BT_klineData.dates.length - 1];
		var dates = [], ohlc = [[], [], [], []], vols = [];
		for (var i = 0; i < data.dates.length; i++) {
			var d = data.dates[i];
			if (d < firstDate || d > lastDate) continue;
			dates.push(d);
			ohlc[0].push(data.ohlc[0][i]);
			ohlc[1].push(data.ohlc[1][i]);
			ohlc[2].push(data.ohlc[2][i]);
			ohlc[3].push(data.ohlc[3][i]);
			vols.push(data.volumes[i]);
		}
		return { dates: dates, ohlc: ohlc, volumes: vols, name: data.name, __period: data.__period };
	}

	function BT_updateIndexInfo(forceIdx) {
		if (!BT_indexData || !BT_indexData.dates.length) return;
		var iIdx = BT_mapMainIdxToIndex(BT_currentIdx);
		if (iIdx === null || iIdx < 0 || iIdx >= BT_indexData.dates.length) return;
		var d = BT_indexData;
		var i = iIdx;
		var o = d.ohlc[0][i], c = d.ohlc[1][i], l = d.ohlc[2][i], h = d.ohlc[3][i];
		var prevClose = (i > 0) ? d.ohlc[1][i - 1] : o;
		var pct = prevClose ? (c - prevClose) / prevClose : 0;

		_setText('idxDate', d.dates[i]);
		_setText('idxOpen', _fmtNum(o));
		_setText('idxClose', _fmtNum(c));
		_setText('idxHigh', _fmtNum(h));
		_setText('idxLow', _fmtNum(l));
		var pctEl = document.getElementById('idxPct');
		if (pctEl) {
			pctEl.textContent = _pct(pct);
			pctEl.style.color = pct > 0 ? BT_COLOR_UP : (pct < 0 ? BT_COLOR_DOWN : 'inherit');
		}
		// 指数图 volumes 实际是成交额（万元）
		_setText('idxVol', BT_formatAmount(d.volumes[i]));
		BT_fillMaValues('idxMa', i);
	}

	// ============ 指标重建工具 ============
	// 重建主图或指数图的 MA / VOL 指标
	function _rebuildIndicators(chart, opts) {
		if (!chart) return;
		// 先全删
		var existing = chart.getIndicators();
		if (existing && existing.length) {
			for (var i = 0; i < existing.length; i++) {
				chart.removeIndicator({ id: existing[i].id });
			}
		}
		// MA（stack 到主 pane）
		if (opts.ma && BT_showFlags.ma) {
			chart.createIndicator({ name: IND_MA, calcParams: BT_maPeriods.slice() }, true);
		}
		// VOL（series:'volume' → klinecharts 自动建/复用 volume pane）
		if (opts.vol && BT_showFlags.vol) {
			chart.createIndicator({ name: IND_VOL, calcParams: [5] }, false);
		}
	}

	// ============ 主图 ============
	function BT_initChart() {
		if (!KC) {
			console.error('[backtest-kline] klinecharts 未加载（public/js/vendor/klinecharts.min.js）');
			return;
		}
		var dom = document.getElementById('btChart');
		if (!dom) return;
		if (BT_chart) { try { KC.dispose(BT_chart); } catch (e) {} BT_chart = null; }

		_registerIndicators();
		_registerOverlay();

		BT_chart = KC.init(dom, {
			styles: _buildStyles(),
			layout: { barSpaceLimit: { min: 0.1, max: 500 } }
		});
		if (!BT_chart) return;

		BT_chart.setSymbol({ ticker: 'backtest', pricePrecision: 2, volumePrecision: 0 });
		BT_chart.setPeriod({ type: 'day', span: 1 });
		BT_chart.setDataLoader(_makeDataLoader());

		// 布局：主图 + VOL pane（klinecharts 依据 series:'volume' 自动建 volume pane）
		BT_chart.createIndicator({ name: IND_VOL, calcParams: [5] }, false);

		_attachChartEvents(BT_chart, 'main');

		BT_renderMaList('curMa', 'cur');
		BT_renderMaList('idxMa', 'idx');
	}

	// ============ 渲染主数据 ============
	function BT_renderKLine(data) {
		if (!BT_chart) BT_initChart();
		if (!BT_chart || !data) return;
		BT_klineData = data;
		BT_initialWindowDone = false;

		// 日期索引
		BT_dateIndex = {};
		for (var i = 0; i < data.dates.length; i++) BT_dateIndex[data.dates[i]] = i;

		// MA 线缓存（供右栏 curMa 显示）
		data.maLines = [];
		for (var i = 0; i < BT_maPeriods.length; i++) {
			data.maLines.push(BT_computeMAFromCloses(data.ohlc, BT_maPeriods[i]));
		}

		// 月线 banner
		if (data.__period === 'month') BT_showPeriodBanner();
		else BT_hidePeriodBanner();

		// 主图重拉数据
		BT_chart.setSymbol({ ticker: data.symbol || 'backtest', pricePrecision: 2, volumePrecision: 0 });
		BT_chart.setPeriod({ type: 'day', span: 1 });
		BT_chart.resetData();

		// 指标重建
		_rebuildIndicators(BT_chart, { ma: true, vol: true });

		_syncGlobals();
		BT_refreshChartMarkers();
		BT_initWindow(BT_currentIdx);
		BT_updateCursorDisplay();
		BT_renderMaList('curMa', 'cur');
		BT_fillMaValues('curMa', BT_currentIdx);
		if (typeof global.BT_renderStats === 'function') global.BT_renderStats();
		_syncIndexZoom();
	}

	// ============ 交易标记 ============
	function BT_refreshChartMarkers() {
		if (!BT_chart || !BT_klineData) return;
		// 全删重建
		BT_chart.removeOverlay({ name: OVERLAY_NAME });
		var trades = _g('BT_trades');
		if (!trades || !trades.length) return;
		for (var i = 0; i < trades.length; i++) {
			var t = trades[i];
			var idx = BT_dateIndex[t.date];
			if (idx === undefined) continue;
			var low = BT_klineData.ohlc[2][idx];
			BT_chart.createOverlay({
				name: OVERLAY_NAME,
				paneId: PANE_CANDLE,
				points: [{ dataIndex: idx, value: low * 0.99 }],
				extendData: { side: t.side }
			});
		}
	}

	// ============ 主题 ============
	function BT_applyTheme() {
		var styles = _buildStyles();
		if (BT_chart) BT_chart.setStyles(styles);
		if (BT_indexChart) BT_indexChart.setStyles(styles);
		BT_renderMaList('curMa', 'cur');
		BT_renderMaList('idxMa', 'idx');
		BT_fillMaValues('curMa', BT_currentIdx);
		BT_updateIndexInfo();
	}

	// storage 事件监听（其他页签切主题）
	window.addEventListener('storage', function (e) {
		if (e.key === 'app_theme') BT_applyTheme();
	});

	// ============ 高度自适应 ============
	function BT_fitChartHeights() {
		var mainDom = document.getElementById('btChart');
		var idxDom = document.getElementById('btChartIndex');
		var idxSection = document.getElementById('btIndexSection');
		if (!mainDom) return;
		var viewportH = window.innerHeight;
		var availH = viewportH - 300; // 页头/控制栏/边距预估
		var h = Math.max(BT_MIN_CHART_H, Math.min(BT_MAX_CHART_H, Math.round(availH * 0.6)));
		mainDom.style.height = h + 'px';
		if (idxDom && idxSection && idxSection.style.display !== 'none') {
			idxDom.style.height = Math.max(120, Math.min(240, Math.round(availH * 0.3))) + 'px';
		}
		if (BT_chart) BT_chart.resize();
		if (BT_indexChart) BT_indexChart.resize();
		BT_refreshChartMarkers();
	}

	function BT_scheduleFitChartHeights() {
		if (BT_fitRAF) cancelAnimationFrame(BT_fitRAF);
		BT_fitRAF = requestAnimationFrame(function () {
			BT_fitRAF = null;
			BT_fitChartHeights();
		});
	}

	window.addEventListener('resize', function () {
		BT_scheduleFitChartHeights();
	});

	// ============ 显隐开关 ============
	function BT_toggleShowMA() {
		BT_showFlags.ma = !BT_showFlags.ma;
		_rebuildIndicators(BT_chart, { ma: true, vol: false });
		_rebuildIndicators(BT_indexChart, { ma: true, vol: false });
		_syncGlobals();
	}

	function BT_toggleShowVol() {
		BT_showFlags.vol = !BT_showFlags.vol;
		_rebuildIndicators(BT_chart, { ma: false, vol: true });
		_rebuildIndicators(BT_indexChart, { ma: false, vol: true });
		_syncGlobals();
	}

	function BT_toggleShowIndex() {
		var section = document.getElementById('btIndexSection');
		if (!section) return;
		var show = section.style.display === 'none';
		section.style.display = show ? '' : 'none';
		if (show) {
			BT_scheduleFitChartHeights();
			setTimeout(function () {
				BT_scheduleFitChartHeights();
				if (!BT_indexChart) BT_initIndexChart();
				if (typeof global.BT_loadIndex === 'function') global.BT_loadIndex(true);
			}, 100);
		}
	}

	// ============ MA 周期更新 ============
	function BT_updateMAPeriods() {
		var periods = [];
		for (var i = 1; i <= 3; i++) {
			var el = document.getElementById('ma' + i);
			if (!el) continue;
			var v = parseInt(el.value, 10);
			if (!isNaN(v) && v > 0 && v <= 400) periods.push(v);
		}
		if (!periods.length) periods = BT_MA_DEFAULT.slice();
		BT_maPeriods = periods;
		// 重建 MA 指标
		_rebuildIndicators(BT_chart, { ma: true, vol: false });
		_rebuildIndicators(BT_indexChart, { ma: true, vol: false });
		// 缓存 MA 线并回填右栏
		if (BT_klineData) {
			BT_klineData.maLines = [];
			for (var i = 0; i < BT_maPeriods.length; i++) {
				BT_klineData.maLines.push(BT_computeMAFromCloses(BT_klineData.ohlc, BT_maPeriods[i]));
			}
		}
		if (BT_indexData) {
			BT_indexData.maLines = [];
			for (var i = 0; i < BT_maPeriods.length; i++) {
				BT_indexData.maLines.push(BT_computeMAFromCloses(BT_indexData.ohlc, BT_maPeriods[i]));
			}
		}
		BT_renderMaList('curMa', 'cur');
		BT_renderMaList('idxMa', 'idx');
		BT_fillMaValues('curMa', BT_currentIdx);
		BT_updateIndexInfo();
		BT_paintCrosshair();
		BT_saveCursorState();
		_syncGlobals();
	}

	// ============ 旧接口兼容（crosshair/draw/tooltip 已废弃路径） ============
	function BT_paintCrosshair() {
		// klinecharts 内置 crosshair 常驻，此函数保留签名供 resize/theme 后调用
		if (!BT_chart || !BT_klineData || !BT_klineData.dates.length) return;
		var i = BT_currentIdx;
		if (i < BT_winStartIdx || i > BT_winEndIdx) {
			// 窗口外不显示（klinecharts 自身会隐藏，无需处理）
			return;
		}
		_setCrosshairOn(BT_chart, i, true);
	}

	function BT_setupCustomTooltip() { /* v=70 起废弃：数据在右栏 */ }
	function BT_setupIndexTooltip() { /* v=70 起废弃：数据在右栏 */ }
	function BT_setupChartCursor() { /* 滑块光标样式已由 klinecharts 内置处理 */ }
	function BT_toggleZoomLock() { /* 空占位，保留签名 */ }
	function BT_initZoomLockUI() { /* 空占位，保留签名 */ }

	// ============ hover 联动入口 ============
	function BT_hoverSyncFrom(idx, from) {
		// 兼容旧签名；klinecharts 事件驱动下新链路在 _attachChartEvents
		if (from === 'main') BT_onCursorMove(idx);
		else if (from === 'index') {
			var mj = BT_mapIndexIdxToMain(idx);
			if (mj !== null) BT_onCursorMove(mj);
			BT_scheduleIndexInfoRender();
		}
	}

	// ============ misc 兼容 ============
	function BT_showPeriodBanner() {
		var banner = document.getElementById('btPeriodBanner');
		if (banner) banner.style.display = '';
	}

	function BT_hidePeriodBanner() {
		var banner = document.getElementById('btPeriodBanner');
		if (banner) banner.style.display = 'none';
	}

	function BT_syncVisibleBarsSelect() {
		var sel = document.getElementById('btVisibleBars');
		if (!sel) return;
		var v = String(BT_visibleBars);
		var found = false;
		for (var i = 0; i < sel.options.length; i++) {
			if (sel.options[i].value === v) { found = true; break; }
		}
		if (!found) {
			var opt = document.createElement('option');
			opt.value = v;
			opt.textContent = v + '根';
			opt.setAttribute('data-dynamic', '1');
			// 插到数值排序合理位置（简单：追加）
			sel.appendChild(opt);
		}
		sel.value = v;
	}

	function BT_setCursor(idx) {
		if (idx === null || idx === undefined) return;
		if (!BT_klineData || !BT_klineData.dates.length) return;
		BT_moveCursorTo(idx);
	}

	function BT_refreshEquityCurve() {
		// 资金曲线已删除（用户要求）；trade.js 5 处调用不能改名
		if (typeof global.BT_renderStats === 'function') global.BT_renderStats();
	}

	// ============ 状态持久化 ============
	function BT_saveCursorState() {
		if (typeof global.BT_saveStateNow === 'function') {
			try { global.BT_saveStateNow(); } catch (e) {}
		}
	}

	// ============ 导出 ============
	global.BT_initChart = BT_initChart;
	global.BT_initIndexChart = BT_initIndexChart;
	global.BT_renderKLine = BT_renderKLine;
	global.BT_renderIndexChart = BT_renderIndexChart;
	global.BT_setCursor = BT_setCursor;
	global.BT_moveCursorTo = BT_moveCursorTo;
	global.BT_initWindow = BT_initWindow;
	global.BT_applyWindow = BT_applyWindow;
	global.BT_zoomBy = BT_zoomBy;
	global.BT_zoomIn = BT_zoomIn;
	global.BT_zoomOut = BT_zoomOut;
	global.BT_zoomToBars = BT_zoomToBars;
	global.BT_applyVisibleBars = BT_applyVisibleBars;
	global.BT_updateMAPeriods = BT_updateMAPeriods;
	global.BT_toggleShowMA = BT_toggleShowMA;
	global.BT_toggleShowVol = BT_toggleShowVol;
	global.BT_toggleShowIndex = BT_toggleShowIndex;
	global.BT_fitChartHeights = BT_fitChartHeights;
	global.BT_scheduleFitChartHeights = BT_scheduleFitChartHeights;
	global.BT_refreshChartMarkers = BT_refreshChartMarkers;
	global.BT_refreshEquityCurve = BT_refreshEquityCurve;
	global.BT_updateCursorDisplay = BT_updateCursorDisplay;
	global.BT_updateIndexInfo = BT_updateIndexInfo;
	global.BT_syncIndexZoom = BT_syncIndexZoom;
	global.BT_syncIndexCursor = BT_syncIndexCursor;
	global.BT_paintCrosshair = BT_paintCrosshair;
	global.BT_getPlotGeom = BT_getPlotGeom;
	global.BT_isInsidePlot = BT_isInsidePlot;
	global.BT_maColors = BT_maColors;
	global.BT_formatVolume = BT_formatVolume;
	global.BT_formatAmount = BT_formatAmount;
	global.BT_renderMaList = BT_renderMaList;
	global.BT_fillMaValues = BT_fillMaValues;
	global.BT_computeMAFromCloses = BT_computeMAFromCloses;
	global.BT_getCloses = BT_getCloses;
	global.BT_showPeriodBanner = BT_showPeriodBanner;
	global.BT_hidePeriodBanner = BT_hidePeriodBanner;
	global.BT_clampVisibleBars = BT_clampVisibleBars;
	global.BT_syncVisibleBarsSelect = BT_syncVisibleBarsSelect;
	global.BT_getVisibleBars = BT_getVisibleBars;
	global.BT_initZoomLockUI = BT_initZoomLockUI;
	global.BT_toggleZoomLock = BT_toggleZoomLock;
	global.BT_setupCustomTooltip = BT_setupCustomTooltip;
	global.BT_setupIndexTooltip = BT_setupIndexTooltip;
	global.BT_setupChartCursor = BT_setupChartCursor;
	global.BT_scheduleCursorRender = BT_scheduleCursorRender;
	global.BT_onCursorMove = BT_onCursorMove;
	global.BT_hoverSyncFrom = BT_hoverSyncFrom;
	global.BT_mapMainIdxToIndex = BT_mapMainIdxToIndex;
	global.BT_mapIndexIdxToMain = BT_mapIndexIdxToMain;
	global.BT_crosshairMoveTo = BT_crosshairMoveTo;
	global.BT_hideCrosshairAt = BT_hideCrosshairAt;
	global.BT_noteHoverActive = BT_noteHoverActive;
	global.BT_scheduleHoverIdleJump = BT_scheduleHoverIdleJump;
	global.BT_jumpToWindowRightEdge = BT_jumpToWindowRightEdge;
	global.BT_scheduleIndexInfoRender = BT_scheduleIndexInfoRender;
	global.BT_applyTheme = BT_applyTheme;
	// 兼容 backtest-crosshair.js（若仍被引用）
	global.BT_repaintCrosshair = BT_paintCrosshair;
	// 诊断
	global.BT_kline = {
		chart: function () { return BT_chart; },
		indexChart: function () { return BT_indexChart; },
		version: KC ? KC.version() : null
	};
})();
