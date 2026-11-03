import { useEffect, useMemo, useRef } from 'react';
import type { Chart, KLineData } from 'klinecharts';
import type { KLine } from '../../lib/backend';

type Props = {
	lines: KLine[];
	/** 画布高度（px）。klinecharts 是 canvas，必须给明确高度 */
	height?: number;
	/** 主图均线周期，空数组表示不加均线 */
	maPeriods?: number[];
	/** 是否显示成交量副图 */
	showVolume?: boolean;
	/** 紧凑模式：小卡片里用，关掉图例浮层、字号调小，否则 320px 宽会糊成一团 */
	compact?: boolean;
};

/** 从 CSS 变量取当前主题色，保证和页面其他部分一致（含暗色主题） */
function themeColor(name: string, fallback: string) {
	if (typeof window === 'undefined') return fallback;
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return value || fallback;
}

function styleChart(chart: Chart, compact = false) {
	const up = themeColor('--up', '#d9463e');
	const down = themeColor('--down', '#12845f');
	const line = themeColor('--line-soft', '#e8edf3');
	const muted = themeColor('--theme-muted', '#65768c');
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
		formatDate: ({ timestamp, type }) => {
			const date = new Date(timestamp);
			const pad = (input: number) => String(input).padStart(2, '0');
			const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
			if (type === 'xAxis') return monthDay;
			return `${date.getFullYear()}-${monthDay}`;
		},
	});
	chart.setStyles({
		grid: {
			show: true,
			horizontal: { color: line, size: 1, style: 'solid' },
			vertical: { color: line, size: 1, style: 'solid' },
		},
		candle: {
			// candle_down_stroke：阴线只描边不填充，阳线仍实心
			type: 'candle_down_stroke',
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
					line: { show: true, style: 'dashed', dashedValue: [3, 3], size: 1 },
					text: { show: true, style: 'fill', color: '#ffffff', size: fontSize, family: 'inherit', paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, borderRadius: 2 },
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

function loadBars(chart: Chart, bars: KLineData[], version: number) {
	if (!bars.length) return;
	chart.setDataLoader({
		getBars: ({ type, callback }) => {
			callback(type === 'init' ? bars : [], { backward: false, forward: false });
		},
	});
	chart.setSymbol({ ticker: `kline-${version}`, pricePrecision: 2, volumePrecision: 0 });
	chart.setPeriod({ span: 1, type: 'day' });
}

/**
 * 通用 K 线面板：klinecharts 10 封装。
 * 内置十字光标、缩放、平移，主图挂 MA、下方挂 VOL，阴线空心。
 */
export function KLinePanel({ lines, height = 300, maPeriods = [10, 20], showVolume = true, compact = false }: Props) {
	const holderRef = useRef<HTMLDivElement | null>(null);
	const chartRef = useRef<Chart | null>(null);
	const apiRef = useRef<typeof import('klinecharts') | null>(null);
	const versionRef = useRef(0);

	const bars = useMemo<KLineData[]>(() => [...lines]
		.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
		.map((line) => ({
			timestamp: new Date(line.time).getTime(),
			open: line.open,
			high: line.high,
			low: line.low,
			close: line.close,
			volume: line.volume,
		})), [lines]);
	const barsRef = useRef(bars);
	barsRef.current = bars;

	// klinecharts 在模块加载时读取 window；延迟到浏览器 effect 中加载，避免 Node 测试/SSR 导入崩溃。
	useEffect(() => {
		const holder = holderRef.current;
		if (!holder) return;
		let cancelled = false;
		let resizeObserver: ResizeObserver | undefined;
		let themeObserver: MutationObserver | undefined;
		void import('klinecharts').then((api) => {
			if (cancelled) return;
			apiRef.current = api;
			const chart = api.init(holder, { locale: 'zh-CN' });
			if (!chart) return;
			chartRef.current = chart;
			styleChart(chart, compact);
			if (maPeriods.length) chart.createIndicator({ name: 'MA', paneId: 'candle_pane', calcParams: maPeriods });
			// 空参数只显示成交量柱，不带出 MA5/MA10/MA20 三条量均线。
			if (showVolume) chart.createIndicator({ name: 'VOL', calcParams: [] });
			resizeObserver = new ResizeObserver(() => chart.resize());
			resizeObserver.observe(holder);
			themeObserver = new MutationObserver(() => styleChart(chart, compact));
			themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
			versionRef.current += 1;
			loadBars(chart, barsRef.current, versionRef.current);
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
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// v10 用 setDataLoader + setSymbol/setPeriod 重载；ticker 版本号确保数据变化会触发刷新。
	useEffect(() => {
		const chart = chartRef.current;
		if (!chart) return;
		versionRef.current += 1;
		loadBars(chart, bars, versionRef.current);
	}, [bars]);

	return <div className="kline-panel" ref={holderRef} style={{ height: `${height}px` }} />;
}
