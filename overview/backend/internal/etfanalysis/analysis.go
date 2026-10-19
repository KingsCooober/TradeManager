// Package etfanalysis computes ETF facts without applying stock ratings.
package etfanalysis

import (
	"math"
	"sort"
	"strings"
	"time"

	"easy-stock/backend/internal/foundation"
)

type Metric struct {
	Label  string   `json:"label"`
	Value  *float64 `json:"value"`
	Unit   string   `json:"unit"`
	AsOf   string   `json:"as_of"`
	Method string   `json:"method"`
}

type Peer struct {
	Profile foundation.ETFProfile `json:"profile"`
	Quote   *foundation.Quote     `json:"quote,omitempty"`
}

type Analysis struct {
	Direction           *DirectionAnalysis    `json:"direction,omitempty"`
	Actions             foundation.ETFActions `json:"actions"`
	TrendBars           []foundation.KLine    `json:"trend_bars,omitempty"`
	Underlying          []UnderlyingEvidence  `json:"underlying,omitempty"`
	evidenceLimitations []string
	Holdings            []foundation.ETFHoldings     `json:"holdings"`
	Announcements       []foundation.ETFAnnouncement `json:"announcements"`
	Execution           ExecutionAssessment          `json:"execution"`
	Profile             foundation.ETFProfile        `json:"profile"`
	NetValues           foundation.ETFNetValues      `json:"net_values"`
	Metrics             []Metric                     `json:"metrics"`
	Peers               []Peer                       `json:"peers"`
	PeerScope           string                       `json:"peer_scope"`
	PriceBasis          string                       `json:"price_basis"`
	Limitations         []string                     `json:"limitations"`
	ExecutionBlockers   []string                     `json:"execution_blockers"`
	Bars                []foundation.KLine           `json:"bars"`
	BenchmarkSymbol     string                       `json:"benchmark_symbol,omitempty"`
	BenchmarkBars       []foundation.KLine           `json:"benchmark_bars,omitempty"`
}

type Judgment struct {
	Status        string   `json:"status"`
	Text          string   `json:"text"`
	EvidenceLevel string   `json:"evidence_level"`
	SourceIDs     []string `json:"source_ids"`
}

type Judgments struct {
	Technical  *Judgment `json:"technical,omitempty"`
	News       *Judgment `json:"news,omitempty"`
	Underlying Judgment  `json:"underlying"`
	Product    Judgment  `json:"product"`
	Entry      Judgment  `json:"entry"`
}

func Build(profile foundation.ETFProfile, nav foundation.ETFNetValues, lines []foundation.KLine, now time.Time) Analysis {
	return BuildWithActions(profile, nav, lines, foundation.ETFActions{}, now)
}
func BuildWithActions(profile foundation.ETFProfile, nav foundation.ETFNetValues, lines []foundation.KLine, actions foundation.ETFActions, now time.Time) Analysis {
	nav.Points = datedNAV(nav.Points, now)
	nav.IncomePerTenThousand = datedNAV(nav.IncomePerTenThousand, now)
	nav.SevenDayAnnualized = datedNAV(nav.SevenDayAnnualized, now)
	a := Analysis{Profile: profile, NetValues: nav, Metrics: []Metric{}, Peers: []Peer{}, Bars: []foundation.KLine{}, PriceBasis: "未复权市场价格；价格收益不含分红，不等于净值总回报", Limitations: []string{
		"档案中的规模、份额与费率按来源日期解释，抓取时间不是生效日期",
		"未取得分红调整后的可比净值与基准总回报，不计算跟踪误差或历史估值分位",
	}, ExecutionBlockers: []string{"尚未核实当前交易状态、逐产品交易规则与实时参考估值，暂不形成入场价格计划"}}
	loc := time.FixedZone("CST", 8*3600)
	a.Bars = CompletedBars(lines, now)
	a.TrendBars, actions.Items = SplitAdjustedBars(profile.Symbol, a.Bars, actions, now)
	if actions.Symbol == profile.Symbol {
		a.Actions = actions
	}
	trend := a.TrendBars
	a.PriceBasis = "市价与交易锚点保留未复权价格；趋势按已披露拆分调整为当前份额，现金分红不计入价格收益"
	if !continuousBars(trend) {
		a.Limitations = append(a.Limitations, "部分历史价格存在未解释的大幅断点；跨断点涨幅、均线和回撤暂不计算，近期连续窗口仍可研究")
	}
	if actions.Meta.Source == "" {
		a.Limitations = append(a.Limitations, "分红拆分资料暂不可用；未核实事件不作推算，历史价格断点会单独检查")
	}
	date := ""
	n := len(a.Bars)
	if n > 0 {
		date = a.Bars[n-1].Time.In(loc).Format("2006-01-02")
	}
	add := func(label string, value *float64, unit, method string) {
		a.Metrics = append(a.Metrics, Metric{label, value, unit, date, method})
	}
	for _, w := range []int{5, 20, 60} {
		var ret, ma, amount *float64
		if n > w && continuousBars(trend[n-w-1:]) {
			ret = number((trend[n-1].Close/trend[n-w-1].Close - 1) * 100)
		}
		if n >= w {
			sum, total := 0., 0.
			valid := true
			for _, b := range trend[n-w:] {
				sum += b.Close
				total += b.Amount
				if b.Amount <= 0 {
					valid = false
				}
			}
			if continuousBars(trend[n-w:]) {
				ma = number(sum / float64(w))
			}
			if valid {
				amount = number(total / float64(w))
			}
		}
		label := map[int]string{5: "5", 20: "20", 60: "60"}[w]
		if profile.AssetClass != "money" {
			add(label+"日价格涨幅", ret, "%", "拆分调整后N日收盘/此前第N日收盘-1，需要N+1个收盘；不含现金分红")
			add("MA"+label, ma, "元", "拆分调整后的完整交易日收盘均值")
		}
		add(label+"日平均成交额", amount, "元", "仅在窗口成交额全部可用时计算")
	}
	if profile.AssetClass != "money" {
		var dd *float64
		if n >= 20 && continuousBars(trend[max(0, n-60):]) {
			peak, maxDD := 0., 0.
			for _, b := range trend[max(0, n-60):] {
				peak = math.Max(peak, b.Close)
				maxDD = math.Max(maxDD, (1-b.Close/peak)*100)
			}
			dd = number(maxDD)
		}
		add("近60日窗口最大回撤", dd, "%", "可用窗口20至60个交易日，按拆分调整收盘计算，现金分红可能影响价格回撤")
	}
	if n < 20 {
		a.Limitations = append(a.Limitations, "完整价格日线不足20日，不形成趋势交易计划")
	}
	if profile.AssetClass == "money" {
		a.Limitations = append(a.Limitations, "货币ETF收益分配与交易价格分开解读；七日年化是历史指标，不是保证收益")
		if len(nav.IncomePerTenThousand) == 0 && len(nav.SevenDayAnnualized) == 0 {
			a.Limitations = append(a.Limitations, "货币收益资料缺失，不能仅凭价格判断收益")
		}
	}
	if profile.CrossBorder {
		a.Limitations = append(a.Limitations, "跨境标的存在汇率、海外休市和净值披露滞后；不能把旧净值偏离当实时套利")
	}
	if profile.AssetClass == "unknown" {
		a.Limitations = append(a.Limitations, "底层资产分类尚未核实，仅作有限档案研究")
	}
	a.Enrich(nil, nil, foundation.ETFExecution{}, now)
	return a
}

func number(v float64) *float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return nil
	}
	return &v
}

// A small, explicit name mapping is a code lookup, never an inferred substitute.
func BenchmarkSymbol(profile foundation.ETFProfile) string {
	return map[string]string{"沪深300指数": "000300.SH", "上证50指数": "000016.SH", "中证500指数": "000905.SH", "中证1000指数": "000852.SH", "创业板指数": "399006.SZ", "创业板指数(价格)": "399006.SZ", "创业板指": "399006.SZ", "上证科创板50成份指数": "000688.SH", "上证科创板芯片指数": "000685.SH"}[strings.TrimSpace(profile.TrackingTarget)]
}

// CompletedBars freezes only valid, finished market sessions, retaining raw precision.
func CompletedBars(lines []foundation.KLine, now time.Time) []foundation.KLine {
	loc := time.FixedZone("CST", 8*3600)
	today := now.In(loc).Format("2006-01-02")
	byDate := map[string]foundation.KLine{}
	for _, b := range lines {
		d := b.Time.In(loc).Format("2006-01-02")
		valid := !b.Time.IsZero()
		for _, v := range []float64{b.Open, b.High, b.Low, b.Close} {
			valid = valid && !math.IsNaN(v) && !math.IsInf(v, 0)
		}
		if !valid {
			continue
		}
		if math.IsNaN(b.Amount) || math.IsInf(b.Amount, 0) || b.Amount < 0 {
			b.Amount = 0
		}
		if math.IsNaN(b.Volume) || math.IsInf(b.Volume, 0) || b.Volume < 0 {
			b.Volume = 0
		}
		if b.Close > 0 && b.Open > 0 && b.Low > 0 && b.High >= math.Max(b.Open, b.Close) && b.Low <= math.Min(b.Open, b.Close) && d <= today && !(d == today && now.In(loc).Hour() < 15) {
			byDate[d] = b
		}
	}
	result := make([]foundation.KLine, 0, len(byDate))
	for _, b := range byDate {
		result = append(result, b)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Time.Before(result[j].Time) })
	return result
}
func datedNAV(points []foundation.ETFNAVPoint, now time.Time) []foundation.ETFNAVPoint {
	date := now.In(time.FixedZone("CST", 8*3600)).Format("2006-01-02")
	values := map[string]foundation.ETFNAVPoint{}
	for _, p := range points {
		if _, err := time.Parse("2006-01-02", p.Date); err == nil && p.Date <= date && !math.IsNaN(p.Value) && !math.IsInf(p.Value, 0) {
			values[p.Date] = p
		}
	}
	result := make([]foundation.ETFNAVPoint, 0, len(values))
	for _, p := range values {
		result = append(result, p)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Date < result[j].Date })
	return result
}
