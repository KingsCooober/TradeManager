import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ETFAnalysisReport, etfSnapshotText } from './ETFAnalysisReport';
import { etfDirectionFixture } from '../test-utils/etf-fixture';
import { researchPlanText } from '../lib/stock-research';

const props={view:'research' as const,copied:false,exporting:false,onCopy:()=>{},onExport:()=>{},onRefresh:()=>{},onAskAI:()=>{}};
describe('ETF direction-first report',()=>{
 it('leads with mandate, actual index technicals and direction news',()=>{
  const a=etfDirectionFixture();const html=renderToStaticMarkup(<ETFAnalysisReport {...props} analysis={a}/>);
  for(const label of ['成长科技','行业主题','这只 ETF 投向哪里','实际跟踪指数','000685.SH','1900.00点','方向技术面','方向消息面','半导体需求与供给'])expect(html).toContain(label);
  expect(html.indexOf('近期技术走势')).toBeLessThan(html.indexOf('ETF 基金档案与量化事实'));
  expect(html.indexOf('方向技术面')).toBeLessThan(html.indexOf('底层资产方向'));
  expect(etfSnapshotText(a)).toContain('实际跟踪指数');expect(researchPlanText(a)).toContain('方向消息面');
 });
 it('labels proxy evidence, missing news and provisional classification without inventing facts',()=>{
  const a=etfDirectionFixture(false),d=a.etf.direction!;
  d.technical!.relationship='etf_price_proxy';d.classification.status='provisional';d.news=[];d.news_coverage.status='no_match';
  const html=renderToStaticMarkup(<ETFAnalysisReport {...props} analysis={a}/>);
  expect(html).toContain('ETF市价代理');expect(html).toContain('分类待核实');expect(html).toContain('未取得匹配消息不代表没有催化或风险');expect(html).not.toContain('实际跟踪指数');
 });
});
