package etfanalysis

import (
	"easy-stock/backend/internal/foundation"
	"testing"
	"time"
)

func TestETFExecutionComparability(t *testing.T) {
	at := time.Date(2026, 10, 9, 2, 0, 0, 0, time.UTC)
	p := foundation.ETFProfile{Instrument: foundation.Instrument{Symbol: "510300.SH"}, AssetClass: "equity"}
	e := foundation.ETFExecution{Symbol: p.Symbol, Price: number(1.237), Bid: number(1.236), Ask: number(1.237), BidUnits: number(100), AskUnits: number(100), IOPV: number(1.23), QuoteAt: at, IOPVAt: at, QuoteStatus: "normal_quote"}
	if a := AssessExecution(p, e, at); !a.Comparable || a.PremiumPercent == nil || a.SpreadPercent == nil {
		t.Fatal(a)
	}
	for _, tc := range []struct {
		name   string
		change func(*foundation.ETFProfile, *foundation.ETFExecution)
		now    time.Time
	}{{"stale", func(_ *foundation.ETFProfile, e *foundation.ETFExecution) { e.IOPVAt = at.Add(-2 * time.Minute) }, at}, {"cross-border", func(p *foundation.ETFProfile, _ *foundation.ETFExecution) { p.CrossBorder = true }, at}, {"skew", func(_ *foundation.ETFProfile, e *foundation.ETFExecution) { e.IOPVAt = at.Add(-40 * time.Second) }, at}, {"bad book", func(_ *foundation.ETFProfile, e *foundation.ETFExecution) { e.Ask = number(1.1) }, at}, {"missing size", func(_ *foundation.ETFProfile, e *foundation.ETFExecution) { e.BidUnits = nil }, at}, {"money", func(p *foundation.ETFProfile, _ *foundation.ETFExecution) { p.AssetClass = "money" }, at}, {"future", func(_ *foundation.ETFProfile, e *foundation.ETFExecution) { e.QuoteAt = at.Add(time.Second) }, at}, {"weekend", func(_ *foundation.ETFProfile, _ *foundation.ETFExecution) {}, at.AddDate(0, 0, 1)}} {
		t.Run(tc.name, func(t *testing.T) {
			p, e := p, e
			tc.change(&p, &e)
			a := AssessExecution(p, e, tc.now)
			if a.Comparable || a.PremiumPercent != nil {
				t.Fatal(a)
			}
		})
	}
	a := Build(p, foundation.ETFNetValues{}, nil, at)
	a.Enrich(nil, nil, e, at)
	if len(a.ExecutionBlockers) == 0 {
		t.Fatal("quotes incorrectly certified product trading rules")
	}
	count := len(a.Limitations)
	a.Enrich(nil, nil, e, at)
	if len(a.Limitations) != count {
		t.Fatal("duplicate enrichment limitations")
	}
}
