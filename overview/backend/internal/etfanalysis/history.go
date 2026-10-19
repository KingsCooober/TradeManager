package etfanalysis

import (
	"easy-stock/backend/internal/foundation"
	"math"
	"strings"
	"time"
)

// SplitAdjustedBars preserves raw transaction anchors in Bars. TrendBars use
// current-share units; cash dividends are deliberately not called total return.
func SplitAdjustedBars(symbol string, bars []foundation.KLine, actions foundation.ETFActions, now time.Time) ([]foundation.KLine, []foundation.ETFAction) {
	adjusted := append([]foundation.KLine(nil), bars...)
	accepted := []foundation.ETFAction{}
	today := now.In(foundation.AStockLocation).Format("2006-01-02")
	seen := map[string]bool{}
	if actions.Symbol != symbol {
		return adjusted, accepted
	}
	for _, a := range actions.Items {
		if _, err := time.Parse("2006-01-02", a.Date); err != nil || a.Date > today || a.Value <= 0 || math.IsNaN(a.Value) || math.IsInf(a.Value, 0) || seen[a.Kind+a.Date] {
			continue
		}
		seen[a.Kind+a.Date] = true
		a.PriceEffectiveDate = ""
		if a.Kind == "split" {
			// Fund registers may name the NAV conversion/record date, while market
			// prices switch on the next trading day. Check both neighboring sessions
			// against the disclosed ratio before adjusting; do not invent a ratio.
			score := 1.
			checked := 0
			for i := 1; i < len(bars); i++ {
				date := bars[i].Time.In(foundation.AStockLocation).Format("2006-01-02")
				if date < a.Date {
					continue
				}
				day, _ := time.Parse("2006-01-02", a.Date)
				if bars[i].Time.Sub(day) > 7*24*time.Hour || checked >= 2 {
					break
				}
				checked++
				raw := bars[i].Close / bars[i-1].Close
				corrected := math.Abs(raw*a.Value - 1)
				if corrected <= .25 && corrected+.05 < math.Abs(raw-1) && corrected < score {
					score = corrected
					a.PriceEffectiveDate = date
				}
			}
			if a.PriceEffectiveDate != "" {
				for i := range adjusted {
					b := &adjusted[i]
					if b.Time.In(foundation.AStockLocation).Format("2006-01-02") < a.PriceEffectiveDate {
						b.Open /= a.Value
						b.Close /= a.Value
						b.High /= a.Value
						b.Low /= a.Value
						b.Volume *= a.Value
					}
				}
			}
		}
		accepted = append(accepted, a)
	}
	return adjusted, accepted
}

// A large unresolved discontinuity must not become a fabricated crash. Only
// metrics crossing it are omitted; recent windows remain independently usable.
func continuousBars(bars []foundation.KLine) bool {
	for i := 1; i < len(bars); i++ {
		if bars[i-1].Close <= 0 || math.Abs(bars[i].Close/bars[i-1].Close-1) > .4 {
			return false
		}
	}
	return true
}

func (a *Analysis) AddBenchmark(symbol string, bars []foundation.KLine, now time.Time) {
	a.BenchmarkSymbol = symbol
	a.BenchmarkBars = []foundation.KLine{}
	for _, b := range CompletedBars(bars, now) {
		if b.Symbol == symbol {
			a.BenchmarkBars = append(a.BenchmarkBars, b)
		}
	}
	if len(a.BenchmarkBars) == 0 || a.Profile.CrossBorder {
		return
	}
	lookup := map[string]float64{}
	for _, b := range a.BenchmarkBars {
		lookup[b.Time.In(foundation.AStockLocation).Format("2006-01-02")] = b.Close
	}
	type pair struct {
		date        string
		fund, index float64
	}
	pairs := []pair{}
	for _, b := range a.TrendBars {
		date := b.Time.In(foundation.AStockLocation).Format("2006-01-02")
		if v := lookup[date]; v > 0 {
			pairs = append(pairs, pair{date, b.Close, v})
		}
	}
	if len(pairs) == 0 || len(a.TrendBars) == 0 {
		return
	}
	// Do not compare an old intersection against the latest ETF observation.
	if pairs[len(pairs)-1].date != a.TrendBars[len(a.TrendBars)-1].Time.In(foundation.AStockLocation).Format("2006-01-02") {
		return
	}
	for _, w := range []int{5, 20, 60} {
		if len(pairs) <= w {
			continue
		}
		window := pairs[len(pairs)-w-1:]
		valid := true
		for i := 1; i < len(window); i++ {
			if math.Abs(window[i].fund/window[i-1].fund-1) > .4 {
				valid = false
			}
		}
		if !valid {
			continue
		}
		first, last := window[0], window[len(window)-1]
		a.Metrics = append(a.Metrics, Metric{Label: fmtWindow(w) + "日较基准价格超额", Value: number((last.fund/first.fund - last.index/first.index) * 100), Unit: "百分点", AsOf: last.date, Method: "ETF拆分调整价格与真实跟踪指数在相同日期的价格收益差；不含现金分红，不是跟踪误差"})
	}
}
func fmtWindow(w int) string { return map[int]string{5: "5", 20: "20", 60: "60"}[w] }

// Normalize only issuer prefixes and known lexical aliases. Never collapse
// different strategy terms such as enhanced, total-return, hedged or currency.
func IndexIdentity(value string) string {
	value = strings.Join(strings.Fields(strings.ToLower(value)), "")
	value = strings.ReplaceAll(value, "（", "(")
	value = strings.ReplaceAll(value, "）", ")")
	if value == "创业板指" || value == "创业板指数(价格)" {
		return "创业板指数"
	}
	return value
}
func SameIndex(a, b foundation.ETFProfile) bool {
	return a.AssetClass == b.AssetClass && a.CrossBorder == b.CrossBorder && IndexIdentity(a.TrackingTarget) != "" && IndexIdentity(a.TrackingTarget) == IndexIdentity(b.TrackingTarget)
}

// This relaxed key selects candidates only; SameIndex verifies their profiles.
func PeerSearchKey(target string) string {
	target = IndexIdentity(target)
	for _, prefix := range []string{"上证", "中证", "深证", "国证"} {
		target = strings.TrimPrefix(target, prefix)
	}
	target = strings.TrimSuffix(target, "指数")
	target = strings.ReplaceAll(target, "科创板", "科创")
	return target
}

// ContinuousHistory limits correlations and volatility to the latest comparable
// segment when an unresolved action or source discontinuity remains.
func ContinuousHistory(bars []foundation.KLine) []foundation.KLine {
	start := 0
	for i := 1; i < len(bars); i++ {
		if !continuousBars(bars[i-1 : i+1]) {
			start = i
		}
	}
	return bars[start:]
}
