import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, LoaderCircle, X } from 'lucide-react';
import { type BackendConfig, type KLine, requestJSON } from '../../lib/backend';
import { KLinePanel } from './KLinePanel';

/**
 * 个股走势弹窗。
 *
 * 行情总览里到处是「个股标签」（研报标的、龙虎榜、资金流榜单），
 * 看到不认识的票想确认走势，原来只能切去题材雷达重新搜一遍。
 * 这里给标签套一层点击：就地弹出近一年日 K（MA10/MA20 + 成交量副图）。
 *
 * 用 context 而不是逐层传 props —— MarketDataViews 里有好几个视图函数，
 * 每个都往下加一对 onOpenStock 会污染一长串函数签名。
 */

type StockPeekTarget = { symbol: string; name?: string };

const StockPeekContext = createContext<(symbol: string, name?: string) => void>(() => {});

/** 在任意组件里拿到「打开个股走势」的入口：const openStock = useStockPeek() */
export function useStockPeek() {
	return useContext(StockPeekContext);
}

/** 近一年 ≈ 243 个交易日，取 250 覆盖整年 */
const peekLimit = 250;

// 同一只票反复开关不重复拉行情（5 分钟）
const peekCache = new Map<string, { lines: KLine[]; at: number }>();
const peekCacheTTL = 5 * 60 * 1000;

export function StockPeekProvider({ config, children }: { config: BackendConfig | null; children: ReactNode }) {
	const [target, setTarget] = useState<StockPeekTarget | null>(null);
	const open = useCallback((symbol: string, name?: string) => {
		const clean = (symbol || '').trim();
		if (!clean) return;
		setTarget({ symbol: clean, name: (name || '').trim() || undefined });
	}, []);
	return <StockPeekContext.Provider value={open}>
		{children}
		{target ? <StockKLineModal config={config} target={target} onClose={() => setTarget(null)} /> : null}
	</StockPeekContext.Provider>;
}

function StockKLineModal({ config, target, onClose }: { config: BackendConfig | null; target: StockPeekTarget; onClose: () => void }) {
	const [lines, setLines] = useState<KLine[]>([]);
	const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
	const [error, setError] = useState('');

	useEffect(() => {
		let cancelled = false;
		const cached = peekCache.get(target.symbol);
		if (cached && Date.now() - cached.at < peekCacheTTL) {
			setLines(cached.lines);
			setState('ready');
			return;
		}
		if (!config) {
			setState('error');
			setError('后端未配置，无法读取日线');
			return;
		}
		setState('loading');
		requestJSON<{ data: KLine[] }>(config, `/api/v1/quotes/kline?symbol=${encodeURIComponent(target.symbol)}&period=day&limit=${peekLimit}`)
			.then((payload) => {
				if (cancelled) return;
				const rows = (payload.data || []).slice(-peekLimit);
				if (!rows.length) {
					setState('error');
					setError('该标的暂无日线数据');
					return;
				}
				peekCache.set(target.symbol, { lines: rows, at: Date.now() });
				setLines(rows);
				setState('ready');
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setState('error');
				setError(err instanceof Error ? err.message : '日线数据加载失败');
			});
		return () => { cancelled = true; };
	}, [config, target.symbol]);

	// ESC 关闭 + 锁背景滚动，避免弹窗打开时背后页面还能滑动
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
		window.addEventListener('keydown', onKey);
		const previous = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			window.removeEventListener('keydown', onKey);
			document.body.style.overflow = previous;
		};
	}, [onClose]);

	const label = target.name || target.symbol;
	const last = lines.at(-1);
	const first = lines[0];
	const rangePercent = first && last && first.close ? (last.close / first.close - 1) * 100 : 0;
	// 图上不再画最高/最低价的浮动标注（会跟 OHLC、MA 图例撞），改在 footer 里给区间高低
	const rangeHigh = lines.length ? Math.max(...lines.map((line) => line.high)) : 0;
	const rangeLow = lines.length ? Math.min(...lines.map((line) => line.low)) : 0;

	// portal 到 body：工作区里有多层 overflow 容器，留在原地会被裁掉
	return createPortal(<div className="stock-peek-mask" onClick={onClose} role="presentation">
		<section
			className="stock-peek-dialog"
			role="dialog"
			aria-modal="true"
			aria-label={`${label} 近一年日线走势`}
			onClick={(event) => event.stopPropagation()}
		>
			<header>
				<div className="stock-peek-title">
					<span>个股走势 · 近一年</span>
					<h3>{label}<small>{target.symbol}</small></h3>
				</div>
				{state === 'ready' && last ? <div className="stock-peek-quote">
					<strong>{last.close.toFixed(2)}</strong>
					<em className={rangePercent > 0 ? 'up' : rangePercent < 0 ? 'down' : 'flat'}>
						{rangePercent > 0 ? '+' : ''}{rangePercent.toFixed(2)}%
					</em>
					<small>区间涨跌</small>
				</div> : null}
				<button type="button" className="stock-peek-close" onClick={onClose} aria-label="关闭"><X size={18} /></button>
			</header>
			<div className="stock-peek-body">
				{state === 'loading' ? <div className="stock-peek-state"><LoaderCircle className="spin" size={20} /><span>正在读取近一年日线…</span></div> : null}
				{state === 'error' ? <div className="stock-peek-state error"><AlertTriangle size={20} /><span>{error}</span></div> : null}
				{state === 'ready' ? <KLinePanel lines={lines} height={400} /> : null}
			</div>
			<footer>近一年 {lines.length || '--'} 个交易日{lines.length ? ` · 区间 ${rangeLow.toFixed(2)} ~ ${rangeHigh.toFixed(2)}` : ''} · MA10 / MA20 · 成交量（无均线）· 滚轮缩放、拖动平移</footer>
		</section>
	</div>, document.body);
}
