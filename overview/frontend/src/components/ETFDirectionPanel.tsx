import { ChartNoAxesCombined, Layers3, Newspaper, ArrowUpRight } from 'lucide-react';
import type { ETFDirectionFacts } from '../lib/backend';
import { safeResearchURL } from '../lib/stock-research';
import { formatCompactAmount } from '../lib/stock-analysis';
import { KLineChart } from './KLineChart';
import { ResearchPanel } from './StockResearchReport';

const relationLabel = (value: string) => ({tracking_index:'实际跟踪指数',sector_reference:'相关行业参照',etf_price_proxy:'ETF市价代理'}[value] || '研究对象待核实');
const trendLabel = (value: string) => ({rising:'均线多头排列',falling:'均线空头排列',mixed:'均线方向不一致',unknown:'长周期趋势待核实'}[value] || '待核实');
const relevanceLabel = (value:string) => ({direction:'方向相关',market_context:'外围市场',product_context:'产品相关'}[value] || '相关线索');
const newsStatus = (value: string) => ({retrieved:'已取得相关摘要',partial:'部分检索未完成',no_match:'本次未检出匹配消息',unavailable:'方向消息暂不可用',not_requested:'量化速览未检索消息'}[value] || '检索状态未知');
const metricText = (m: NonNullable<ETFDirectionFacts['technical']>['metrics'][number]) => m.value == null ? '未取得' : m.unit === '元' && m.label.includes('成交额') ? `${formatCompactAmount(m.value)}元` : `${m.value.toFixed(m.unit === '元' ? 3 : 2)}${m.unit}`;
const newsDate = (date?: string) => date ? new Date(date).toLocaleDateString('zh-CN', {timeZone:'Asia/Shanghai'}) : '日期未知';

export function etfDirectionText(d?: ETFDirectionFacts): string[] {
 if (!d) return [];
 return [
  `投资方向：${d.classification.primary.label}；交叉标签：${d.classification.tags.map(t=>t.label).join('、')}`,
  `分析对象：${d.classification.focus}；${d.classification.basis}`,
  ...(d.technical ? [`技术对象：${d.technical.name}（${d.technical.symbol}），${relationLabel(d.technical.relationship)}，截至${d.technical.as_of}`,...d.technical.metrics.map(m=>`${m.label}：${metricText(m)}`),...d.technical.limitations] : ['方向价格技术资料未提供，货币类侧重收益与资金面']),
  `方向消息：${newsStatus(d.news_coverage.status)}${d.news_coverage.status==='not_requested' ? '' : `；${d.news_coverage.from?.slice(0,10) || '—'} 至 ${d.news_coverage.to?.slice(0,10) || '—'}`}`,
  ...d.news.map(n=>`${newsDate(n.item.published_at)} ${n.item.title}（${relevanceLabel(n.relevance)}，摘要）[${n.source_id}] ${safeResearchURL(n.item.url) || ''}`),
  ...d.limitations,
 ];
}

export function ETFDirectionPanel({direction:d}: {direction:ETFDirectionFacts}) {
 const c=d.classification,t=d.technical;
 const headlineMetrics=t?.metrics.filter(m=>['5日价格涨幅','20日价格涨幅','60日价格涨幅','MA20','MA60','近60日窗口最大回撤'].includes(m.label)) || [];
 return <div className="etf-direction">
  <ResearchPanel label="先识别投资方向" title="这只 ETF 投向哪里" icon={Layers3} className="etf-direction-overview">
   <div className="etf-direction-identity"><div className="etf-direction-tags"><strong>{c.primary.label}</strong>{c.tags.filter(tag=>tag.key!==c.primary.key).map(tag=><span key={tag.key}>{tag.label}</span>)}{c.sector && <span>{c.sector}</span>}{c.status!=='disclosed_target' && c.status!=='asset_class' && <span>分类待核实</span>}</div>
   <h3>{c.focus || '跟踪对象待核实'}</h3><p className="stock-research-muted">{c.basis}</p></div>
   <div className="etf-research-focus"><span>研究重点</span><ul>{c.research_focus.map(focus => <li key={focus}>{focus}</li>)}</ul></div>
  </ResearchPanel>
  <ResearchPanel label="对应指数 / 板块" title="近期技术走势" icon={ChartNoAxesCombined} className="etf-direction-technical">
   {t ? <><div className="etf-direction-heading"><strong>{t.name} <small>{t.symbol}</small></strong><span>{relationLabel(t.relationship)} · 截至 {t.as_of}</span></div><p className="etf-trend-note"><span>{trendLabel(t.trend)}</span>仅描述完整交易日的价格趋势</p>
    <dl className="etf-metrics">{headlineMetrics.map(m=><div key={m.label} title={m.method}><dt>{m.label}</dt><dd className={m.label.includes("价格涨幅") && m.value != null ? m.value > 0 ? "up" : m.value < 0 ? "down" : undefined : undefined}>{metricText(m)}</dd></div>)}</dl>
    <details className="etf-direction-details"><summary>展开日线与完整技术指标</summary><KLineChart lines={t.bars} symbol={t.symbol} pricePrecision={t.relationship==='etf_price_proxy'?3:2} timeZone="Asia/Shanghai"/><p className="stock-research-muted">{t.relationship==='etf_price_proxy'?'ETF价格单位为元。':'指数点位不等于ETF价格。'} 成交额变化不能直接解释为资金净流入。</p><dl className="etf-metrics">{t.metrics.filter(m=>!headlineMetrics.includes(m)).map(m=><div key={m.label} title={m.method}><dt>{m.label}</dt><dd className={m.label.includes("价格涨幅") && m.value != null ? m.value > 0 ? "up" : m.value < 0 ? "down" : undefined : undefined}>{metricText(m)}</dd></div>)}</dl></details>
    {t.limitations.map(text=><p className="stock-research-muted" key={text}>{text}</p>)}</> : <p>{c.primary.key==='money'?'货币类侧重短端利率、收益分配与资金面；不套用股票价格突破分析。':'对应指数或板块日线尚未取得，暂不判断其当前技术走势。'}</p>}
  </ResearchPanel>
  <ResearchPanel label="投资方向相关消息" title="催化与风险线索" icon={Newspaper} className="etf-direction-catalysts">
   <div className="etf-news-coverage"><div><strong>{newsStatus(d.news_coverage.status)}</strong>{d.news_coverage.status !== 'not_requested' && <span>{newsDate(d.news_coverage.from)} — {newsDate(d.news_coverage.to)}</span>}</div><span>{d.news.length} 条线索</span></div>
   {d.news.length>0 ? <ul className="etf-direction-news">{d.news.slice(0,5).map(n=><li key={n.source_id}><div className="etf-news-meta"><time>{newsDate(n.item.published_at)}</time><span>{relevanceLabel(n.relevance)}</span><span>摘要</span></div>{safeResearchURL(n.item.url)?<a href={safeResearchURL(n.item.url)} target="_blank" rel="noreferrer">{n.item.title}<ArrowUpRight size={14} aria-hidden="true"/></a>:<strong>{n.item.title}</strong>}<details><summary>查看消息摘要与匹配依据</summary><p>{n.item.content || '仅有标题，未取得正文。'}</p><small>匹配：{n.matched_terms.join('、')} · 来源：{n.item.meta.source}</small></details></li>)}</ul> : <p className="stock-research-muted">{d.news_coverage.status==='not_requested'?'选择 AI 研究可检索方向消息。':'未取得匹配消息不代表没有催化或风险，已有技术事实仍可独立研究。'}</p>}
   {d.news.length>5 && <p className="stock-research-muted">其余 {d.news.length-5} 条随完整证据保存，可在研究证据中查看。</p>}
   <p className="stock-research-muted">摘要用于发现线索；事件影响需结合发生日期、传导机制与价格表现判断。</p>
   {d.limitations.map(text=><p className="stock-research-muted" key={text}>{text}</p>)}
  </ResearchPanel>
 </div>;
}
