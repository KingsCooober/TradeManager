package stockanalysis

import (
	"encoding/json"

	"easy-stock/backend/internal/etfanalysis"
	"easy-stock/backend/internal/foundation"
)

// Compact structured ETF sources without cutting JSON midway or dropping the
// newest observations. Full originals remain available in the saved report.
func etfPromptSources(snapshot ResearchSnapshot, level ResearchLevel) []ResearchSource {
	sources := append([]ResearchSource(nil), snapshot.Sources...)
	window, description := 20, 650
	if level == ResearchLevelQuick {
		window, description = 5, 300
	}
	if level == ResearchLevelDeep {
		window, description = 60, 1400
	}
	data := snapshot.ETF
	profile := func(p foundation.ETFProfile) any {
		return map[string]any{
			"symbol": p.Symbol, "name": p.Name, "full_name": p.FullName, "asset_class": p.AssetClass, "cross_border": p.CrossBorder, "fund_type": p.FundType,
			"tracking_target": p.TrackingTarget, "benchmark": p.Benchmark, "manager": p.Manager, "size": p.Size, "shares": p.Shares, "inception": p.Inception,
			"management_fee": p.ManagementFee, "custody_fee": p.CustodyFee,
			"investment_scope_excerpt": truncateExactText(p.InvestmentScope, description), "strategy_excerpt": truncateExactText(p.Strategy, description), "risk_excerpt": truncateExactText(p.RiskDescription, description), "distribution_excerpt": truncateExactText(p.Distribution, description),
		}
	}
	bars := func(lines []foundation.KLine) []AIDailyBar {
		result := []AIDailyBar{}
		for _, b := range lines[max(0, len(lines)-window):] {
			result = append(result, AIDailyBar{Date: b.Time.Format("2006-01-02"), Open: b.Open, High: b.High, Low: b.Low, Close: b.Close, Volume: b.Volume, Amount: b.Amount})
		}
		return result
	}
	tail := func(points []foundation.ETFNAVPoint) []foundation.ETFNAVPoint {
		return points[max(0, len(points)-window):]
	}
	for i := range sources {
		var value any
		switch sources[i].ID {
		case "e-profile":
			value = profile(data.Profile)
		case "e-nav":
			value = map[string]any{"points": tail(data.NetValues.Points), "income_per_ten_thousand": tail(data.NetValues.IncomePerTenThousand), "seven_day_annualized": tail(data.NetValues.SevenDayAnnualized), "basis": "估值日，非发布时点；无分红总回报调整；非实时IOPV"}
		case "m-price":
			metrics := make([]etfanalysis.Metric, len(data.Metrics))
			copy(metrics, data.Metrics)
			for j := range metrics {
				metrics[j].Method = ""
			}
			value = map[string]any{"metrics": metrics, "recent_bars": bars(data.TrendBars), "raw_recent_bars": bars(data.Bars), "price_basis": data.PriceBasis, "volume_unit": "份"}
		case "e-direction-technical":
			if data.Direction != nil && data.Direction.Technical != nil {
				d := data.Direction.Technical
				value = map[string]any{"symbol": d.Symbol, "name": d.Name, "relationship": d.Relationship, "as_of": d.AsOf, "trend": d.Trend, "metrics": d.Metrics, "recent_bars": bars(d.Bars), "limitations": d.Limitations}
			}
		case "e-benchmark":
			value = map[string]any{"symbol": data.BenchmarkSymbol, "name": data.Profile.TrackingTarget, "recent_bars": bars(data.BenchmarkBars), "basis": "指数价格，非总回报"}
		case "e-peers":
			peers := []any{}
			for _, p := range data.Peers {
				peers = append(peers, map[string]any{"profile": profile(p.Profile), "quote": p.Quote})
			}
			value = map[string]any{"scope": data.PeerScope, "peers": peers}
		case "e-execution", "e-quality":
			// These are small structured records; do not truncate JSON or its restrictions.
		default:
			if sources[i].Kind == "fund_data" {
				continue
			}
			if len([]rune(sources[i].Content)) > description*3 && sources[i].Kind == "announcement" {
				sources[i].ContentStatus = "excerpt"
			}
			sources[i].Content = truncateExactText(sources[i].Content, description*3)
		}
		if value != nil {
			b, _ := json.Marshal(value)
			sources[i].Content = string(b)
		}
	}
	return sources
}
