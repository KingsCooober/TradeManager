import { useEffect, useMemo, useRef } from 'react';
import type { Chart, KLineData, YAxisTemplate } from 'klinecharts';
import type { KLine } from '../../lib/backend';

type ChartMode = 'intraday' | 'daily';
type ChartState = 'loading' | 'ready' | 'error' | 'idle';

type Props = {
	lines: KLine[];
	/** 画布高度（px）。klinecharts 是 canvas，必须给明确高度 */
	height?: number;
	/** 主图均线周期，空数组表示不加均线；分时模式固定用 20 点均线 */
	maPeriods?: number[];
	/** 是否显示成交量副图 */
	showVolume?: boolean;
	/** 紧凑模式：小卡片里用，关掉图例浮层、字号调小，否则 320px 宽会糊成一团 */
	compact?: boolean;
	/** intraday 用收盘折线 + 20 点均线，daily 用蜡烛 */
	mode?: ChartMode;
	/** 价格精度，ETF 净值类用 3 */
	pricePrecision?: number;
	/** 标的代码，用于分时涨跌停幅度说明 */
	symbol?: string;
	/** 数据状态，用于占位文案 */
	state?: ChartState;
	/** 占位文案里的周期名（分时 / 5日 / 日K / 周K / 月K） */
	periodLabel?: string;
	/** 时区，默认浏览器本地 */
	timeZone?: string;
	/** 是否加左侧涨跌幅轴与 0% 基准线（带图例说明） */
	showPercentAxis?: boolean;
};

/** 左侧涨跌幅轴：display 域是百分比，real 域仍是价格 */
const PERCENT_AXIS = 'kline-change-percent';

type ChartWithBase = Chart & { __klinePercentBase?: number };

/** 从 CSS 变量取当前主题色，保证和页面其他部分一致（含暗色主题） */
function themeColor(name: string, fallback: string) {
	if (typeof window === 'undefined') return fallback;
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return value || fallback;
}

/** 分时涨跌停幅度：创业板/科创板 20%，北交所 30%，其余 10% */
function intradayLimitPercent(symbol = '') {
	const [rawCode, rawMarket] = symbol.toUpperCase().split('.');
	const code = rawCode || '';
	const market = rawMarket || '';
	if (market === 'BJ' || /^(4|8|92)/.test(code)) return 30;
	if (/^(300|301|302|303|688|689)/.test(code)) return 20;
	return 10;
}

type DateFormatter = (params: { timestamp: number; type: 'tooltip' | 'crosshair' | 'xAxis' }) => string;

function createDateFormatter(timeZone: string | undefined, mode: ChartMode, multiDay: boolean): DateFormatter {
	const pad = (value: number) => String(value).padStart(2, '0');
	const intl = timeZone
		? new Intl.DateTimeFormat('zh-CN', {
			timeZone,
			hour12: false,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
		})
		: null;
	const read = (timestamp: number) => {
		const date = new Date(timestamp);
		if (!intl) {
			return {
				year: String(date.getFullYear()),
				month: pad(date.getMonth() + 1),
				day: pad(date.getDate()),
				hour: pad(date.getHours()),
				minute: pad(date.getMinutes()),
			};
		}
		const parts: Record<string, string> = {};
		for (const part of intl.formatToParts(date)) parts[part.type] = part.value;
		return {
			year: parts.year ?? '',
			month: parts.month ?? '',
			day: parts.day ?? '',
			hour: parts.hour === '24' ? '00' : parts.hour ?? '',
			minute: parts.minute ?? '',
		};
	};
	return ({ timestamp, type }) => {
		const { year, month, day, hour, minute } = read(timestamp);
		if (mode === 'intraday') {
			// 5 日分时跨天，坐标轴只写 HH:mm 会看不出是哪一天
			if (type === 'xAxis') return multiDay ? `${month}-${day} ${hour}:${minute}` : `${hour}:${minute}`;
			return `${month}-${day} ${hour}:${minute}`;
		}
		return type === 'xAxis' ? `${month}-${day}` : `${year}-${month}-${day}`;
	};
}

/**
 * 涨跌幅轴模板。
 * real / value 域保持价格，display 域换算成相对基准价的百分比；
 * 两个方向都用 range 自带的 realFrom/realTo/displayFrom/displayTo 做线性插值，
 * 这样 klinecharts 在缩放、平移时重建 range 也不会丢基准。
 */
function percentAxisTemplate(): YAxisTemplate {
	return {
		name: PERCENT_AXIS,
		minSpan: () => 0.01,
		valueToRealValue: (value) => value,
		realValueToValue: (value) => value,
		realValueToDisplayValue: (value, { range }) => (range.realRange === 0
			? 0
			: range.displayFrom + ((value - range.realFrom) / range.realRange) * range.displayRange),
		displayValueToRealValue: (value, { range }) => (range.displayRange === 0
			? range.realFrom
			: range.realFrom + ((value - range.displayFrom) / range.displayRange) * range.realRange),
		displayValueToText: (value) => {
			const numeric = Number(value);
			if (!Number.isFinite(numeric)) return '--';
			return `${numeric > 0 ? '+' : ''}${numeric.toFixed(2)}%`;
		},
		createRange: ({ chart, defaultRange }) => {
			const base = (chart as ChartWithBase).__klinePercentBase ?? 0;
			const toPercent = (price: number) => (base > 0 ? ((price - base) / base) * 100 : 0);
			const displayFrom = toPercent(defaultRange.from);
			const displayTo = toPercent(defaultRange.to);
			return { ...defaultRange, displayFrom, displayTo, displayRange: displayTo - displayFrom };
		},
	};
}

let percentAxisRegistered = false;
function ensurePercentAxis(api: typeof import('klinecharts')) {
	if (percentAxisRegistered) return;
	api.registerYAxis(percentAxisTemplate());
	percentAxisRegistered = true;
}

function styleChart(chart: Chart, options: { compact: boolean; mode: ChartMode; formatDate: DateFormatter; showLastText: boolean }) {
	const { compact, mode, formatDate, showLastText } = options;
	const intraday = mode === 'intraday';
	const up = themeColor('--up', '#d9463e');
	const down = themeColor('--down', '#12845f');
	const line = themeColor('--line-soft', '#e8edf3');
	const muted = themeColor('--theme-muted', '#65768c');
	const accent = themeColor('--theme-blue', '#2476d2');
	const fontSize = compact ? 9 : 11;
	// 默认的 506.148M / 3-07-23 是英文习惯，换成 A 股看得懂的 亿/万 和 月-日
	chart.setFormatter({
		formatBigNumber: (value) => {
			const numeric = typeof value === 'string' ? Number(value) : value;
			if (!Number.isFinite(numeric)) return String(value);
			const abs = Math.abs(numeric);
			if (abs >= 1e8) return `${(numeric / 1e8).toFixed(2)}亿`;
			if (abs >= 1e4) return `${(numeric / 1e4).toFixed(2)}万`;
			return String(numeric);
		},
		formatDate,
	});
	chart.setStyles({
		grid: {
			show: true,
			horizontal: { color: line, size: 1, style: 'solid' },
			vertical: { color: line, size: 1, style: 'solid' },
		},
		candle: {
			// 日线 candle_down_stroke：阴线只描边不填充，阳线仍实心；
			// 分时用 area：只取 close 画折线，不看 high/low，就是分时走势图。
			type: intraday ? 'area' : 'candle_down_stroke',
			area: {
				lineSize: 2,
				lineColor: accent,
				value: 'close',
				smooth: false,
				backgroundColor: [
					{ offset: 0, color: 'rgba(36, 118, 210, 0.18)' },
					{ offset: 1, color: 'rgba(36, 118, 210, 0.02)' },
				],
			},
			bar: {
				compareRule: 'current_open',
				upColor: up,
				downColor: down,
				noChangeColor: muted,
				upBorderColor: up,
				downBorderColor: down,
				noChangeBorderColor: muted,
				upWickColor: up,
				downWickColor: down,
				noChangeWickColor: muted,
			},
			priceMark: {
				show: true,
				// 最高/最低价的浮动文字会跟左上角的 OHLC、MA 图例撞在一起
				// （最高点刚好落在左侧时就重叠成一串数字），所以不画；
				// 区间高低值改到调用方的信息栏里展示，位置固定不会打架。
				high: { show: false, color: muted, textSize: fontSize, textFamily: 'inherit', textWeight: 'normal', textOffset: 4 },
				low: { show: false, color: muted, textSize: fontSize, textFamily: 'inherit', textWeight: 'normal', textOffset: 4 },
				last: {
					show: true,
					upColor: up,
					downColor: down,
					noChangeColor: muted,
					// 带涨跌幅轴时不画最后价虚线与气泡：手动轴的标签落在左侧轴条右缘，
					// 虚线又横穿左上的 OHLC/MA 图例，两处都会跟图例打架；
					// 最新价改由下方图例的「0%基准」和调用方报价栏说明。
					line: { show: showLastText, style: 'dashed', dashedValue: [3, 3], size: 1 },
					text: { show: showLastText, style: 'fill', color: '#ffffff', size: fontSize, family: 'inherit', paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, borderRadius: 2 },
				},
			},
			// compact 模式下关掉 OHLC 图例：小卡片里那行字会比 K 线还显眼。
			// 非 compact 必须把 tooltip 写全 —— 只传 { title: { show: false } } 会把
			// showRule / legend.template 一起顶掉，鼠标划过就什么都不显示。
			tooltip: compact ? { showRule: 'none' } : {
				showRule: 'always',
				showType: 'standard',
				rect: {
					position: 'fixed',
					paddingLeft: 8,
					paddingRight: 8,
					paddingTop: 6,
					paddingBottom: 6,
					offsetLeft: 8,
					offsetTop: 8,
					offsetRight: 8,
					offsetBottom: 8,
					borderRadius: 6,
					borderSize: 1,
					borderColor: line,
					color: themeColor('--theme-surface', '#ffffff'),
				},
				// title 用 {ticker}·{period} 会显示成 kline-3·1d，没意义，关掉
				title: { show: false },
				legend: {
					size: fontSize,
					color: muted,
					marginLeft: 8,
					marginTop: 2,
					marginRight: 8,
					marginBottom: 6,
					defaultValue: '--',
					// 中文标签：日期 / 开 / 高 / 低 / 收 / 量 / 涨跌幅
					template: [
						{ title: '日期', value: '{time}' },
						{ title: '开', value: '{open}' },
						{ title: '高', value: '{high}' },
						{ title: '低', value: '{low}' },
						{ title: '收', value: '{close}' },
						{ title: '涨跌', value: '{change}' },
						{ title: '量', value: '{volume}' },
					],
				},
			},
		},
		indicator: {
			// ⚠️ 成交量柱的颜色取的是 bars[0].upColor / downColor，
			// 而 klinecharts 的默认值是「绿涨红跌」（西方配色）。
			// 只覆盖 ohlc 不够 —— 那样量柱会跟 K 线的红涨绿跌正好反着。
			bars: [{ style: 'fill', borderStyle: 'solid', borderSize: 1, upColor: up, downColor: down, noChangeColor: muted }],
			ohlc: { compareRule: 'current_open', upColor: up, downColor: down, noChangeColor: muted },
			lastValueMark: { show: false },
			// 只在 compact 时关指标图例；非 compact 传 undefined 会把默认配置整块顶掉
			tooltip: compact ? { showRule: 'none' } : { showRule: 'always', showType: 'standard' },
		},
		xAxis: {
			show: true,
			axisLine: { show: false },
			tickLine: { show: false, length: 0 },
			tickText: { show: true, color: muted, size: fontSize, family: 'inherit', marginStart: 6, marginEnd: 6 },
		},
		yAxis: {
			show: true,
			axisLine: { show: false },
			tickLine: { show: false, length: 0 },
			tickText: { show: true, color: muted, size: fontSize, family: 'inherit', marginStart: 6, marginEnd: 6 },
		},
		separator: { size: 1, color: line },
		crosshair: {
			show: true,
			horizontal: {
				show: true,
				line: { show: true, style: 'dashed', dashedValue: [3, 3], size: 1, color: muted },
				text: { show: true, style: 'fill', color: '#ffffff', size: 11, family: 'inherit', paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, borderRadius: 2 },
			},
			vertical: {
				show: true,
				line: { show: true, style: 'dashed', dashedValue: [3, 3], size: 1, color: muted },
				text: { show: true, style: 'fill', color: '#ffffff', size: 11, family: 'inherit', paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, borderRadius: 2 },
			},
		},
	});
}

function loadBars(chart: Chart, bars: KLineData[], version: number, mode: ChartMode, pricePrecision: number) {
	if (!bars.length) return;
	chart.setDataLoader({
		getBars: ({ type, callback }) => {
			callback(type === 'init' ? bars : [], { backward: false, forward: false });
		},
	});
	// ticker 变更会触发 setSymbol 的 yAxis 重算标记，分时与日线各自独立
	chart.setSymbol({ ticker: `kline-${mode}-${version}`, pricePrecision, volumePrecision: 0 });
	chart.setPeriod({ span: 1, type: mode === 'intraday' ? 'minute' : 'day' });
}

/**
 * 通用 K 线面板：klinecharts 10 封装。
 * 内置十字光标、缩放、平移，主图挂 MA、下方挂 VOL，阴线空心。
 * mode="intraday" 时改为收盘折线 + 20 点均线，并可加左侧涨跌幅轴与 0% 基准线。
 */
export function KLinePanel({
	lines,
	height = 300,
	maPeriods = [10, 20],
	showVolume = true,
	compact = false,
	mode = 'daily',
	pricePrecision = 2,
	symbol,
	state = 'ready',
	periodLabel,
	timeZone,
	showPercentAxis = false,
}: Props) {
	const holderRef = useRef<HTMLDivElement | null>(null);
	const chartRef = useRef<Chart | null>(null);
	const apiRef = useRef<typeof import('klinecharts') | null>(null);
	const versionRef = useRef(0);
	const zeroLineRef = useRef<string | null>(null);

	const bars = useMemo<KLineData[]>(() => [...lines]
		.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
		.map((line) => ({
			timestamp: new Date(line.time).getTime(),
			open: line.open,
			high: line.high,
			low: line.low,
			close: line.close,
			volume: line.volume,
			amount: line.amount,
			turnoverRate: line.turnover_rate,
		})), [lines]);

	// 0% 基准：分时优先用接口给的 previous_close（当日分时被裁剪成单日时也能对齐），
	// 否则退回第一根收盘价，与原先手绘 SVG 的取法一致。
	const referencePrice = useMemo(() => {
		if (!bars.length) return 0;
		if (mode === 'intraday') {
			const supplied = lines.find((line) => line.previous_close != null && line.previous_close > 0)?.previous_close;
			if (supplied && supplied > 0) return supplied;
		}
		const first = bars[0].close;
		if (first > 0) return first;
		return Math.max(...bars.map((bar) => bar.low), 0.01);
	}, [bars, lines, mode]);

	// 「5日」分时跨天，坐标轴要带日期，否则一天的两段看不出边界
	const multiDay = useMemo(() => {
		if (!bars.length) return false;
		const first = new Date(bars[0].timestamp);
		const last = new Date(bars[bars.length - 1].timestamp);
		return first.getDate() !== last.getDate() || first.getMonth() !== last.getMonth() || first.getFullYear() !== last.getFullYear();
	}, [bars]);

	const formatDate = useMemo(() => createDateFormatter(timeZone, mode, multiDay), [timeZone, mode, multiDay]);
	const effectiveMa = mode === 'intraday' ? [20] : maPeriods;
	const maKey = effectiveMa.join(',');
	const percentRange = intradayLimitPercent(symbol);
	const label = periodLabel ?? (mode === 'intraday' ? '分时' : '日K');
	const ready = state !== 'loading' && lines.length > 0;

	const barsRef = useRef(bars);
	barsRef.current = bars;
	const baseRef = useRef(referencePrice);
	baseRef.current = referencePrice;
	const formatRef = useRef(formatDate);
	formatRef.current = formatDate;
	const showPercentAxisRef = useRef(showPercentAxis);
	showPercentAxisRef.current = showPercentAxis;
	const precisionRef = useRef(pricePrecision);
	precisionRef.current = pricePrecision;

	// klinecharts 在模块加载时读取 window；延迟到浏览器 effect 中加载，避免 Node 测试/SSR 导入崩溃。
	useEffect(() => {
		const holder = holderRef.current;
		if (!holder || !ready) return;
		let cancelled = false;
		let resizeObserver: ResizeObserver | undefined;
		let themeObserver: MutationObserver | undefined;
		void import('klinecharts').then((api) => {
			if (cancelled) return;
			apiRef.current = api;
			ensurePercentAxis(api);
			const chart = api.init(holder, timeZone ? { locale: 'zh-CN', timezone: timeZone } : { locale: 'zh-CN' });
			if (!chart) return;
			chartRef.current = chart;
			(chart as ChartWithBase).__klinePercentBase = baseRef.current;
			styleChart(chart, { compact, mode, formatDate: formatRef.current, showLastText: !showPercentAxisRef.current });
			if (effectiveMa.length) chart.createIndicator({ name: 'MA', paneId: 'candle_pane', calcParams: effectiveMa });
			// 空参数只显示成交量柱，不带出 MA5/MA10/MA20 三条量均线。
			if (showVolume) chart.createIndicator({ name: 'VOL', calcParams: [] });
			if (showPercentAxis) chart.createYAxis({ name: PERCENT_AXIS, position: 'left' });
			resizeObserver = new ResizeObserver(() => chart.resize());
			resizeObserver.observe(holder);
			themeObserver = new MutationObserver(() => styleChart(chart, { compact, mode, formatDate: formatRef.current, showLastText: !showPercentAxisRef.current }));
			themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
			versionRef.current += 1;
			loadBars(chart, barsRef.current, versionRef.current, mode, precisionRef.current);
			applyZeroLine(chart);
		}).catch(() => {
			// 与 init 失败保持一致：保留空画布，不影响页面其他模块。
		});

		return () => {
			cancelled = true;
			resizeObserver?.disconnect();
			themeObserver?.disconnect();
			apiRef.current?.dispose(holder);
			apiRef.current = null;
			chartRef.current = null;
			zeroLineRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mode, compact, showVolume, showPercentAxis, maKey, ready, timeZone]);

	// v10 用 setDataLoader + setSymbol/setPeriod 重载；ticker 版本号确保数据变化会触发刷新。
	useEffect(() => {
		const chart = chartRef.current;
		if (!chart) return;
		(chart as ChartWithBase).__klinePercentBase = referencePrice;
		versionRef.current += 1;
		loadBars(chart, bars, versionRef.current, mode, pricePrecision);
		applyZeroLine(chart);
	}, [bars, referencePrice, mode, pricePrecision]);

	/** 0% 基准横线：基准价变化时先删旧线再画，避免叠加 */
	function applyZeroLine(chart: Chart) {
		if (zeroLineRef.current) {
			chart.removeOverlay({ id: zeroLineRef.current });
			zeroLineRef.current = null;
		}
		if (!showPercentAxis || !(referencePrice > 0)) return;
		const created = chart.createOverlay({
			name: 'horizontalStraightLine',
			points: [{ value: referencePrice }],
			lock: true,
			// 只要那条虚线，不要左端的拖拽圆点和坐标轴上的投影
			needDefaultPointFigure: false,
			needDefaultXAxisFigure: false,
			needDefaultYAxisFigure: false,
			styles: {
				line: {
					color: themeColor('--theme-line', '#aab9c9'),
					size: 1,
					style: 'dashed',
					dashedValue: [5, 4],
				},
			},
		});
		zeroLineRef.current = typeof created === 'string' ? created : null;
	}

	if (state === 'loading') return <div className="kline-chart-placeholder">正在加载{label}数据…</div>;
	if (!lines.length) {
		return <div className="kline-chart-placeholder">{state === 'error' ? `${label}数据暂不可用，请稍后重试。` : `暂无${label}数据。`}</div>;
	}

	const panel = <div className="kline-panel" ref={holderRef} style={{ height: `${height}px` }} />;
	if (!showPercentAxis) return panel;

	return (
		<div className="kline-chart-wrap">
			{panel}
			<div className="kline-chart-legend">
				<span className="kline-legend-item"><span className="zero-dot" />0%基准：{referencePrice.toFixed(pricePrecision)}</span>
				{mode === 'intraday' && <span className="limit-note">涨跌幅范围 ±{percentRange}%</span>}
				<span className="volume-note">左侧涨跌幅 · 右侧价格 · 柱体为成交量</span>
				{mode === 'intraday' && (
					<span className="kline-legend-item">
						<span className="close-dot" />收盘价<span className="average-dot" />20点均线
					</span>
				)}
			</div>
		</div>
	);
}
