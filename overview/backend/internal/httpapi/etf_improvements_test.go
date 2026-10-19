package httpapi

import (
	"context"
	"easy-stock/backend/internal/etfanalysis"
	"easy-stock/backend/internal/foundation"
	"easy-stock/backend/internal/providers/eastmoney"
	"easy-stock/backend/internal/providers/fund"
	"easy-stock/backend/internal/providers/sina"
	"easy-stock/backend/internal/providers/tencent"
	"easy-stock/backend/internal/stockanalysis"
	"os"
	"testing"
	"time"
)

type chipETFProvider struct{ etfDataFixture }

func (chipETFProvider) ETFDirectory(context.Context) ([]foundation.Instrument, error) {
	return []foundation.Instrument{{Symbol: "588200.SH", Name: "科创芯片ETF嘉实"}, {Symbol: "588201.SH", Name: "科创芯片ETF样本"}, {Symbol: "588202.SH", Name: "科创芯片增强ETF样本"}}, nil
}
func (chipETFProvider) ETFProfile(_ context.Context, symbol string) (foundation.ETFProfile, error) {
	p := foundation.ETFProfile{Instrument: foundation.Instrument{Symbol: symbol}, TrackingTarget: "上证科创板芯片指数", AssetClass: "equity"}
	if symbol == "588202.SH" {
		p.TrackingTarget = "另一芯片指数"
	}
	return p, nil
}
func TestETFPeersAliasCandidatesStillRequireExactIndex(t *testing.T) {
	s := &Server{etfProvider: chipETFProvider{}}
	p, _ := s.etfProvider.ETFProfile(context.Background(), "588200.SH")
	peers, scope := s.collectETFPeers(context.Background(), p, 3)
	if len(peers) != 1 || peers[0].Profile.Symbol != "588201.SH" {
		t.Fatal(peers, scope)
	}
}

type chipFinancialFixture struct{}

func (chipFinancialFixture) StockFinancialEvidence(_ context.Context, symbol string, _ int) ([]foundation.StockFinancialEvidence, error) {
	return []foundation.StockFinancialEvidence{{Symbol: symbol, ReportDate: "2026-06-30", Fields: map[string]float64{"revenue_yoy": 20, "net_profit_yoy": -3}}, {Symbol: symbol, ReportDate: "2026-12-31", Fields: map[string]float64{"revenue_yoy": 99}}, {Symbol: "WRONG", ReportDate: "2026-06-30", Fields: map[string]float64{"revenue_yoy": 99}}}, nil
}
func TestETFUnderlyingSampleKeepsDateIdentityAndWeights(t *testing.T) {
	now := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	s := &Server{etfUnderlyingFinancials: chipFinancialFixture{}}
	h := foundation.ETFHoldings{AssetType: "equity", ReportDate: "2026-06-30", Items: []foundation.ETFHolding{{Symbol: "688001.SH", WeightPercent: 2}, {Symbol: "688002.SH", WeightPercent: 8}, {Symbol: "688003.SH", WeightPercent: 4}, {Symbol: "688004.SH", WeightPercent: 6}, {Code: "0700", WeightPercent: 10}}}
	sample := s.collectETFUnderlying(context.Background(), []foundation.ETFHoldings{h}, now)
	if len(sample) != 3 || sample[0].Holding.Symbol != "688002.SH" {
		t.Fatal(sample)
	}
	for _, v := range sample {
		if len(v.Financials) != 1 || v.Financials[0].Fields["revenue_yoy"] != 20 || v.HoldingReportDate != "2026-06-30" {
			t.Fatal(v)
		}
	}
}
func TestETFLiveChipResearchEvidence(t *testing.T) {
	if os.Getenv("EASY_STOCK_LIVE_ETF") != "1" {
		t.Skip("opt-in public-source check")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 65*time.Second)
	defer cancel()
	sn, em := sina.NewClient(), eastmoney.NewClient()
	s := &Server{etfDirectionMarket: em, stockNewsSearch: em, etfProvider: fund.NewClient(), etfExecution: sn, etfKLinePrimary: em, etfKLineFallback: sn, realtimeProvider: sn, kLinePrimary: em, kLineFallback: sn, etfUnderlyingFinancials: sn, etfUnderlyingValuation: tencent.NewClient()}
	a, snapshot, err := s.collectETFResearch(ctx, stockanalysis.ResearchRequest{Symbol: "588200.SH", InstrumentType: "etf", AnalysisLevel: stockanalysis.ResearchLevelStandard})
	if err != nil {
		t.Fatal(err)
	}
	d := a.ETF
	if d.BenchmarkSymbol != "000685.SH" || len(d.BenchmarkBars) == 0 || len(d.Peers) == 0 || len(d.Actions.Items) == 0 || len(d.Underlying) == 0 {
		t.Fatalf("missing enrichment benchmark=%s/%d peers=%d actions=%+v underlying=%d", d.BenchmarkSymbol, len(d.BenchmarkBars), len(d.Peers), d.Actions.Items, len(d.Underlying))
	}
	if d.Direction == nil || d.Direction.Classification.Primary.Key != "growth_tech" || d.Direction.Technical == nil || d.Direction.Technical.Relationship != "tracking_index" {
		t.Fatalf("missing direction: %+v", d.Direction)
	}
	t.Logf("direction=%s sector=%s technical=%s/%s trend=%s news=%d coverage=%s", d.Direction.Classification.Primary.Label, d.Direction.Classification.Sector, d.Direction.Technical.Name, d.Direction.Technical.AsOf, d.Direction.Technical.Trend, len(d.Direction.News), d.Direction.NewsCoverage.Status)
	for _, n := range d.Direction.News {
		t.Logf("direction news: %s %s %s", n.Item.PublishedAt.Format("2006-01-02"), n.Relevance, n.Item.Title)
	}
	t.Logf("benchmark=%s bars=%d peers=%d underlying=%d sources=%d", d.BenchmarkSymbol, len(d.BenchmarkBars), len(d.Peers), len(d.Underlying), len(snapshot.Sources))
	for i := 1; i < len(d.TrendBars); i++ {
		r := d.TrendBars[i].Close / d.TrendBars[i-1].Close
		if r < .6 || r > 1.4 {
			t.Log("discontinuity", d.TrendBars[i-1].Time, d.Bars[i-1].Close, d.TrendBars[i].Time, d.Bars[i].Close)
		}
	}
	for _, m := range d.Metrics {
		if m.Value != nil {
			t.Log(m.Label, *m.Value, m.AsOf)
		}
	}
	for _, n := range d.Announcements {
		t.Log(n.Title, n.ContentStatus)
	}
	for _, v := range d.Underlying {
		t.Log(v.Holding.Name, v.Holding.WeightPercent, len(v.Financials), v.Valuation != nil)
	}
	if etfanalysis.BenchmarkSymbol(d.Profile) == "" {
		t.Fatal("lost identity")
	}
}

func TestETFLiveDirectionTypes(t *testing.T) {
	if os.Getenv("EASY_STOCK_LIVE_ETF") != "1" {
		t.Skip("opt-in public direction check")
	}
	for _, symbol := range []string{"510300.SH", "510880.SH", "512880.SH"} {
		t.Run(symbol, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			em, sn := eastmoney.NewClient(), sina.NewClient()
			s := &Server{etfProvider: fund.NewClient(), etfDirectionMarket: em, stockNewsSearch: em, kLinePrimary: em, kLineFallback: sn}
			p, err := s.etfProvider.ETFProfile(ctx, symbol)
			if err != nil {
				t.Fatal(err)
			}
			c := etfanalysis.ClassifyDirection(p)
			series := s.collectETFDirectionMarket(ctx, p, c)
			news, coverage := s.collectETFDirectionNews(ctx, symbol, c, time.Now().UTC())
			t.Logf("%s target=%s type=%s series=%s/%s bars=%d news=%d/%s", symbol, p.TrackingTarget, c.Primary.Label, series.Relationship, series.Symbol, len(series.Bars), len(news), coverage.Status)
			if len(series.Bars) == 0 {
				t.Error("no underlying series")
			}
		})
	}
}
