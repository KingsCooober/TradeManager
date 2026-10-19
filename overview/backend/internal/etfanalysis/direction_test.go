package etfanalysis

import (
	"easy-stock/backend/internal/foundation"
	"math"
	"strings"
	"testing"
	"time"
)

func TestETFDirectionClassificationUsesMandateAndOverlappingStyles(t *testing.T) {
	for _, tc := range []struct {
		target, asset, primary, sector string
		tags                           []string
		cross                          bool
	}{
		{"沪深300指数", "equity", "broad_index", "", []string{"broad_index"}, false},
		{"上证科创板芯片指数", "equity", "growth_tech", "半导体", []string{"growth_tech", "sector_theme"}, false},
		{"创业板指数", "equity", "growth_tech", "", []string{"growth_tech", "broad_index"}, false},
		{"中证红利低波动指数", "equity", "dividend", "", []string{"dividend", "low_volatility"}, false},
		{"中证银行指数", "equity", "sector_theme", "银行", []string{"sector_theme"}, false},
		{"中证消费指数", "equity", "sector_theme", "消费", []string{"sector_theme"}, false},
		{"恒生科技指数", "equity", "growth_tech", "", []string{"growth_tech", "cross_border"}, true},
		{"上证5年期国债指数", "bond", "bond", "", []string{"bond"}, false},
		{"黄金价格", "commodity", "commodity", "", []string{"commodity"}, false},
		{"该基金无跟踪标的", "money", "money", "", []string{"money"}, false},
		{"中证未知策略指数", "equity", "unknown", "", nil, false},
	} {
		t.Run(tc.target, func(t *testing.T) {
			p := foundation.ETFProfile{AssetClass: tc.asset, TrackingTarget: tc.target, CrossBorder: tc.cross, Instrument: foundation.Instrument{Name: "红利科技基金营销名称"}, InvestmentScope: "可投资科技、银行、红利、债券等"}
			d := ClassifyDirection(p)
			if d.Primary.Key != tc.primary || d.Sector != tc.sector {
				t.Fatalf("%+v", d)
			}
			for _, key := range tc.tags {
				found := false
				for _, tag := range d.Tags {
					found = found || tag.Key == key
				}
				if !found {
					t.Fatal("missing tag", key, d)
				}
			}
			for _, q := range d.Queries {
				if q == "指数" || q == "基金" {
					t.Fatal("generic query", d)
				}
			}
		})
	}
	p := foundation.ETFProfile{AssetClass: "equity", Instrument: foundation.Instrument{Name: "科技ETF"}}
	if d := ClassifyDirection(p); d.Status != "provisional" || d.Primary.Key != "growth_tech" {
		t.Fatal(d)
	}
	// No sector inferred from the legal investment menu or risk text.
	p = foundation.ETFProfile{AssetClass: "equity", TrackingTarget: "沪深300指数", InvestmentScope: "可投资科技、银行、红利及债券", RiskDescription: "科技股风险"}
	if d := ClassifyDirection(p); d.Primary.Key != "broad_index" || d.Sector != "" {
		t.Fatal(d)
	}
}

func directionTestBars(symbol string, n int) []foundation.KLine {
	result := []foundation.KLine{}
	start := time.Date(2026, 5, 1, 0, 0, 0, 0, foundation.AStockLocation)
	for i := 0; i < n; i++ {
		p := 100. + float64(i)
		amount := 100.
		if i >= n-5 {
			amount = 200
		}
		result = append(result, foundation.KLine{Symbol: symbol, Time: start.AddDate(0, 0, i), Open: p, Close: p, High: p + 1, Low: p - 1, Amount: amount})
	}
	return result
}
func TestETFDirectionTechnicalWindowsUnitsAndMissingAmount(t *testing.T) {
	now := time.Date(2026, 10, 12, 16, 0, 0, 0, foundation.AStockLocation)
	bars := directionTestBars("000685.SH", 65)
	d := BuildDirectionTechnical("000685.SH", "科创芯片", "tracking_index", bars, now)
	if d == nil || d.Trend != "rising" || d.AsOf != "2026-07-04" || len(d.Limitations) == 0 {
		t.Fatal(d)
	}
	values := map[string]Metric{}
	for _, m := range d.Metrics {
		values[m.Label] = m
	}
	if math.Abs(*values["5日价格涨幅"].Value-(164./159-1)*100) > 1e-8 || *values["MA20"].Value != 154.5 || values["MA20"].Unit != "点" || *values["5日/此前20日成交额比"].Value != 2 {
		t.Fatal(values)
	}
	bars[len(bars)-1].Amount = 0
	d = BuildDirectionTechnical("000685.SH", "半导体", "sector_reference", bars, now)
	for _, m := range d.Metrics {
		if m.Label == "5日/此前20日成交额比" && m.Value != nil {
			t.Fatal("manufactured volume signal")
		}
	}
	if d = BuildDirectionTechnical("wrong", "wrong", "tracking_index", bars, now); d != nil {
		t.Fatal("accepted different identity")
	}
	d = BuildDirectionTechnical("000685.SH", "ETF", "etf_price_proxy", bars, now)
	if d.Metrics[1].Unit != "元" || len(d.Limitations) < 2 {
		t.Fatal(d)
	}
}

func TestETFDirectionRejectsNonfiniteOrFuturePricesAndStaleIndexIdentity(t *testing.T) {
	now := time.Date(2026, 10, 12, 16, 0, 0, 0, foundation.AStockLocation)
	bars := directionTestBars("000685.SH", 30)
	bars[29].Close = math.Inf(1)
	bars[29].High = math.Inf(1)
	bars[28].Time = now.AddDate(0, 0, 1)
	bars[27].Amount = math.NaN()
	d := BuildDirectionTechnical("000685.SH", "芯片", "tracking_index", bars, now)
	if d == nil || len(d.Bars) != 28 || d.Bars[27].Amount != 0 {
		t.Fatal(d)
	}
	a := Build(foundation.ETFProfile{AssetClass: "equity"}, foundation.ETFNetValues{}, bars, now)
	a.AddBenchmark("wrong", bars, now)
	if len(a.BenchmarkBars) != 0 {
		t.Fatal("accepted wrong index")
	}
	a.Profile.CrossBorder = true
	a.AddBenchmark("000685.SH", bars, now)
	for _, m := range a.Metrics {
		if strings.Contains(m.Label, "超额") {
			t.Fatal("cross-border currencies compared", m)
		}
	}
}
