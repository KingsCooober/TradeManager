package etfanalysis

import (
	"easy-stock/backend/internal/foundation"
	"math"
	"testing"
	"time"
)

func TestETFSplitAdjustmentKeepsRawAnchorsAndRecentHistory(t *testing.T) {
	now := time.Date(2026, 10, 12, 9, 10, 0, 0, time.UTC)
	bars := []foundation.KLine{}
	for i := 0; i < 70; i++ {
		v := 3.
		if i >= 20 {
			v = 1.
		}
		bars = append(bars, foundation.KLine{Time: now.AddDate(0, 0, i-70), Open: v, High: v, Low: v, Close: v, Amount: 100, Volume: 100})
	}
	p := foundation.ETFProfile{Instrument: foundation.Instrument{Symbol: "588200.SH"}, AssetClass: "equity"}
	actions := foundation.ETFActions{Symbol: p.Symbol, Items: []foundation.ETFAction{{Kind: "split", Date: bars[20].Time.Format("2006-01-02"), Value: 3}}, Meta: foundation.SourceMeta{Source: "fixture"}}
	a := BuildWithActions(p, foundation.ETFNetValues{}, bars, actions, now)
	if a.Bars[0].Close != 3 || a.TrendBars[0].Close != 1 || bars[0].Close != 3 {
		t.Fatal("raw prices changed", a.Bars[0], a.TrendBars[0])
	}
	for _, m := range a.Metrics {
		if m.Label == "60日价格涨幅" && (m.Value == nil || math.Abs(*m.Value) > 1e-8) {
			t.Fatalf("split became a crash: %+v", m)
		}
	}
	b := Build(p, foundation.ETFNetValues{}, bars, now)
	for _, m := range b.Metrics {
		if m.Label == "60日价格涨幅" && m.Value != nil {
			t.Fatal("unresolved discontinuity emitted", m)
		}
		if m.Label == "5日价格涨幅" && m.Value == nil {
			t.Fatal("recent independent window lost")
		}
	}
	// Future or mismatched actions must not adjust the past.
	actions.Items[0].Date = now.AddDate(0, 0, 1).Format("2006-01-02")
	c := BuildWithActions(p, foundation.ETFNetValues{}, bars, actions, now)
	if c.TrendBars[0].Close != 3 {
		t.Fatal("future action leaked")
	}
}

func TestETFPostCloseReferenceDoesNotUnlockTrading(t *testing.T) {
	now := time.Date(2026, 10, 12, 9, 10, 0, 0, time.UTC)
	at := time.Date(2026, 10, 12, 7, 34, 58, 0, time.UTC)
	p := foundation.ETFProfile{Instrument: foundation.Instrument{Symbol: "588200.SH"}, AssetClass: "equity"}
	e := foundation.ETFExecution{Symbol: p.Symbol, Price: number(.996), Bid: number(.995), Ask: number(.996), BidUnits: number(100), AskUnits: number(100), IOPV: number(.9964), QuoteAt: at, IOPVAt: at, QuoteStatus: "normal_quote"}
	a := AssessExecution(p, e, now)
	if a.Comparable || a.PremiumPercent != nil || a.ObservationPremiumPercent == nil || math.Abs(*a.ObservationPremiumPercent-(-.04014452027298)) > 1e-6 {
		t.Fatalf("bad close reference %+v", a)
	}
	e.IOPVAt = at.Add(-time.Minute)
	if AssessExecution(p, e, now).ObservationPremiumPercent != nil {
		t.Fatal("mismatched close accepted")
	}
	e.IOPVAt = at
	p.CrossBorder = true
	if AssessExecution(p, e, now).ObservationPremiumPercent != nil {
		t.Fatal("cross-border stale valuation accepted")
	}
}

func TestETFIndexIdentityAndBenchmark(t *testing.T) {
	p := foundation.ETFProfile{TrackingTarget: "上证科创板芯片指数", AssetClass: "equity"}
	if BenchmarkSymbol(p) != "000685.SH" || PeerSearchKey(p.TrackingTarget) != "科创芯片" {
		t.Fatal("chip benchmark missing")
	}
	other := p
	other.TrackingTarget = "中证半导体产业指数"
	if SameIndex(p, other) {
		t.Fatal("different semiconductor indexes merged")
	}
	other = p
	other.CrossBorder = true
	if SameIndex(p, other) {
		t.Fatal("cross-border mismatch")
	}
}

func TestETFSplitRecordDateMayPrecedeMarketEffectiveDate(t *testing.T) {
	now := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
	bars := []foundation.KLine{}
	for i, v := range []float64{3.613, 3.539, 1.349} {
		at := time.Date(2026, 7, 19+i, 0, 0, 0, 0, foundation.AStockLocation)
		bars = append(bars, foundation.KLine{Time: at, Open: v, Close: v, High: v, Low: v})
	}
	actions := foundation.ETFActions{Symbol: "588200.SH", Items: []foundation.ETFAction{{Kind: "split", Date: "2026-07-20", Value: 3}}}
	adjusted, used := SplitAdjustedBars(actions.Symbol, bars, actions, now)
	if used[0].PriceEffectiveDate != "2026-07-21" || math.Abs(adjusted[1].Close-3.539/3) > 1e-10 || adjusted[2].Close != 1.349 {
		t.Fatal(adjusted, used)
	}
	alreadyAdjusted := append([]foundation.KLine(nil), adjusted...)
	again, used := SplitAdjustedBars(actions.Symbol, alreadyAdjusted, actions, now)
	if used[0].PriceEffectiveDate != "" || again[0].Close != alreadyAdjusted[0].Close {
		t.Fatal("double adjustment", again, used)
	}
}

func TestETFBenchmarkUsesMatchedDatesAndAvoidsStaleComparison(t *testing.T) {
	now := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	bars, index := []foundation.KLine{}, []foundation.KLine{}
	for i := 0; i < 7; i++ {
		at := now.AddDate(0, 0, i-7)
		bars = append(bars, foundation.KLine{Time: at, Open: 1, Close: 1, High: 1, Low: 1})
		index = append(index, foundation.KLine{Symbol: "000685.SH", Time: at, Open: 100, Close: 100, High: 100, Low: 100})
	}
	a := Build(foundation.ETFProfile{AssetClass: "equity"}, foundation.ETFNetValues{}, bars, now)
	a.AddBenchmark("000685.SH", index, now)
	found := false
	for _, m := range a.Metrics {
		if m.Label == "5日较基准价格超额" {
			found = true
			if m.Value == nil || *m.Value != 0 {
				t.Fatal(m)
			}
		}
	}
	if !found {
		t.Fatal("matched comparison missing")
	}
	b := Build(foundation.ETFProfile{AssetClass: "equity"}, foundation.ETFNetValues{}, bars, now)
	b.AddBenchmark("000685.SH", index[:len(index)-1], now)
	for _, m := range b.Metrics {
		if m.Label == "5日较基准价格超额" {
			t.Fatal("stale benchmark comparison emitted")
		}
	}
}
