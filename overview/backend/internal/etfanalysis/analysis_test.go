package etfanalysis

import (
	"easy-stock/backend/internal/foundation"
	"testing"
	"time"
)

func TestETFPrecisionIncompleteSessionAndMoneyIncome(t *testing.T) {
	now := time.Date(2026, 10, 9, 4, 0, 0, 0, time.UTC)
	lines := []foundation.KLine{{Time: now.AddDate(0, 0, -1), Open: 1.233, High: 1.235, Low: 1.231, Close: 1.234}, {Time: now, Open: 1.235, High: 1.239, Low: 1.231, Close: 1.238}}
	a := Build(foundation.ETFProfile{AssetClass: "equity"}, foundation.ETFNetValues{}, lines, now)
	if len(a.Bars) != 1 || a.Bars[0].Close != 1.234 {
		t.Fatalf("precision or incomplete session: %+v", a.Bars)
	}
	for _, m := range a.Metrics {
		if m.Value != nil {
			t.Fatalf("fabricated short-sample metric: %+v", m)
		}
	}
	m := Build(foundation.ETFProfile{AssetClass: "money"}, foundation.ETFNetValues{}, lines, now)
	for _, v := range m.Metrics {
		if v.Unit == "%" {
			t.Fatal("money ETF price return presented as income")
		}
	}
}

func TestETFFutureAndDuplicateObservationsExcluded(t *testing.T) {
	now := time.Date(2026, 10, 9, 8, 0, 0, 0, time.UTC)
	nav := foundation.ETFNetValues{Points: []foundation.ETFNAVPoint{{Date: "2026-10-12", Value: 2}, {Date: "2026-10-08", Value: 1.23}, {Date: "2026-10-08", Value: 1.2345}}}
	a := Build(foundation.ETFProfile{}, nav, nil, now)
	if len(a.NetValues.Points) != 1 || a.NetValues.Points[0].Value != 1.2345 {
		t.Fatalf("future or duplicate NAV included %+v", a.NetValues)
	}
}
