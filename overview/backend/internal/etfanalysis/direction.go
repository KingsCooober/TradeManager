package etfanalysis

import (
	"fmt"
	"math"
	"strings"
	"time"

	"easy-stock/backend/internal/foundation"
)

type DirectionTag struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}
type DirectionClassification struct {
	Primary       DirectionTag   `json:"primary"`
	Tags          []DirectionTag `json:"tags"`
	Focus         string         `json:"focus"`
	Basis         string         `json:"basis"`
	Status        string         `json:"status"`
	Sector        string         `json:"sector,omitempty"`
	Queries       []string       `json:"queries"`
	MatchTerms    []string       `json:"match_terms"`
	ResearchFocus []string       `json:"research_focus"`
}
type DirectionTechnical struct {
	Symbol       string             `json:"symbol"`
	Name         string             `json:"name"`
	Relationship string             `json:"relationship"`
	AsOf         string             `json:"as_of"`
	Trend        string             `json:"trend"`
	Metrics      []Metric           `json:"metrics"`
	Bars         []foundation.KLine `json:"bars"`
	Limitations  []string           `json:"limitations"`
}
type DirectionNews struct {
	SourceID     string              `json:"source_id"`
	Item         foundation.NewsItem `json:"item"`
	MatchedTerms []string            `json:"matched_terms"`
	Relevance    string              `json:"relevance"`
}
type DirectionNewsCoverage struct {
	Status        string    `json:"status"`
	From          time.Time `json:"from"`
	To            time.Time `json:"to"`
	Queries       []string  `json:"queries"`
	FailedQueries []string  `json:"failed_queries"`
	Count         int       `json:"count"`
}
type DirectionAnalysis struct {
	Classification DirectionClassification `json:"classification"`
	Technical      *DirectionTechnical     `json:"technical,omitempty"`
	News           []DirectionNews         `json:"news"`
	NewsCoverage   DirectionNewsCoverage   `json:"news_coverage"`
	Limitations    []string                `json:"limitations"`
}

func containsAny(s string, terms ...string) bool {
	for _, term := range terms {
		if strings.Contains(strings.ToLower(s), strings.ToLower(term)) {
			return true
		}
	}
	return false
}

// Classification uses the disclosed mandate, never the ETF ticker or the broad
// list of legally permitted investments. Tags describe overlapping exposures.
func ClassifyDirection(p foundation.ETFProfile) DirectionClassification {
	d := DirectionClassification{Primary: DirectionTag{"unknown", "投资方向待核实"}, Tags: []DirectionTag{}, Queries: []string{}, MatchTerms: []string{}, ResearchFocus: []string{}, Status: "unverified"}
	target := strings.TrimSpace(p.TrackingTarget)
	if target == "" || containsAny(target, "无跟踪", "--", "暂无") {
		target = ""
	}
	text := target
	if text != "" {
		d.Focus = text
		d.Basis = "依据基金档案披露的跟踪标的：" + text
		d.Status = "disclosed_target"
	} else {
		text = p.Name + " " + p.FullName
		d.Focus = p.Name
		d.Basis = "跟踪标的未明确，仅按基金名称初步归类；需以投资策略核实"
		d.Status = "provisional"
	}
	add := func(k, l string) {
		for _, t := range d.Tags {
			if t.Key == k {
				return
			}
		}
		d.Tags = append(d.Tags, DirectionTag{k, l})
	}
	sectors := []struct {
		name  string
		terms []string
		tech  bool
	}{
		{"半导体", []string{"半导体", "芯片", "集成电路"}, true},
		{"人工智能", []string{"人工智能", "AI指数"}, true},
		{"计算机", []string{"计算机", "软件", "云计算", "大数据", "信息技术"}, true},
		{"通信", []string{"通信", "5G", "6G"}, true},
		{"电子", []string{"电子", "消费电子"}, true},
		{"机器人", []string{"机器人"}, true},
		{"新能源", []string{"新能源", "光伏", "风电", "电池", "锂电"}, false},
		{"医药", []string{"医药", "医疗", "生物科技", "创新药"}, false},
		{"消费", []string{"消费", "食品", "饮料", "白酒"}, false},
		{"银行", []string{"银行"}, false}, {"证券", []string{"证券公司", "证券行业", "券商"}, false},
		{"军工", []string{"军工", "国防"}, false}, {"有色金属", []string{"有色", "稀土"}, false},
		{"煤炭", []string{"煤炭"}, false}, {"房地产", []string{"房地产", "地产"}, false},
		{"电力", []string{"电力", "公用事业"}, false}, {"传媒", []string{"传媒", "游戏"}, false},
	}
	tech := containsAny(text, "科技", "科创", "创业板", "纳斯达克100")
	sectorTerms := []string{}
	for _, s := range sectors {
		if containsAny(text, s.terms...) {
			if d.Sector == "" {
				d.Sector = s.name
			}
			add("sector_theme", "行业主题")
			if s.tech {
				tech = true
			}
			for _, term := range s.terms {
				if containsAny(text, term) {
					sectorTerms = append(sectorTerms, term)
				}
			}
		}
	}
	// The word “指数” alone does not make a fund broad-market.
	broad := map[string]bool{"沪深300指数": true, "上证50指数": true, "中证500指数": true, "中证1000指数": true, "中证2000指数": true, "中证A50指数": true, "中证A100指数": true, "中证A500指数": true, "创业板指数": true, "创业板指": true, "创业板指数(价格)": true, "上证科创板50成份指数": true, "上证科创板100指数": true, "纳斯达克100指数": true, "纳斯达克100指数(人民币)": true, "标普500指数": true, "恒生指数": true, "恒生中国企业指数": true}
	if broad[target] || target == "" && containsAny(text, "沪深300", "中证500", "中证1000", "中证A500", "上证50") {
		add("broad_index", "宽基指数")
	}
	if tech {
		add("growth_tech", "成长科技")
	}
	if containsAny(text, "红利", "股息") {
		add("dividend", "红利策略")
	}
	if containsAny(text, "低波", "低波动") {
		add("low_volatility", "低波策略")
	}
	if containsAny(text, "价值", "质量", "成长") && !tech {
		add("factor_style", "风格因子")
	}
	switch p.AssetClass {
	case "bond":
		d.Tags = []DirectionTag{{"bond", "债券"}}
		d.Primary = d.Tags[0]
		d.Sector = ""
		d.ResearchFocus = []string{"利率与债券价格趋势", "久期、信用与货币政策（以披露数据为准）"}
	case "commodity":
		d.Tags = []DirectionTag{{"commodity", "商品"}}
		d.Primary = d.Tags[0]
		d.Sector = ""
		d.ResearchFocus = []string{"底层商品价格趋势与供需消息", "现货或期货、展期与汇率影响"}
	case "money":
		d.Tags = []DirectionTag{{"money", "货币"}}
		d.Primary = d.Tags[0]
		d.Sector = ""
		d.ResearchFocus = []string{"短端利率与资金面", "万份收益、七日年化及流动性"}
	case "equity":
		for _, key := range []string{"dividend", "growth_tech", "sector_theme", "broad_index", "low_volatility", "factor_style"} {
			for _, tag := range d.Tags {
				if tag.Key == key && d.Primary.Key == "unknown" {
					d.Primary = tag
				}
			}
		}
		switch d.Primary.Key {
		case "dividend":
			d.ResearchFocus = []string{"红利指数趋势与防御风格表现", "分红可持续性、利率变化及行业集中度"}
		case "growth_tech":
			d.ResearchFocus = []string{"跟踪指数及科技行业量价趋势", "产业需求、业绩兑现、政策催化与估值压力"}
		case "sector_theme":
			d.ResearchFocus = []string{"行业指数趋势与量能", "行业景气、供需和政策变化"}
		case "broad_index":
			d.ResearchFocus = []string{"宽基指数中短期趋势", "宏观政策、盈利预期和市场风险偏好"}
		default:
			d.ResearchFocus = []string{"核实策略与跟踪范围", "对应指数趋势与风格驱动"}
		}
	default:
		d.Status = "unverified"
	}
	if d.Primary.Key == "unknown" {
		d.Status = "unverified"
		if target != "" {
			d.Status = "unclassified"
		}
	}
	if target == "" && (p.AssetClass == "money" || p.AssetClass == "bond" || p.AssetClass == "commodity") {
		d.Status = "asset_class"
		d.Basis = "依据基金档案披露的资产类别：" + d.Primary.Label + "；具体配置以策略与披露持仓为准"
	}
	if p.CrossBorder {
		add("cross_border", "跨境")
		d.ResearchFocus = append(d.ResearchFocus, "海外市场时点、汇率和当地政策")
	}
	query := func(q string) {
		if len([]rune(q)) < 2 {
			return
		}
		for _, old := range d.Queries {
			if old == q {
				return
			}
		}
		d.Queries = append(d.Queries, q)
		d.MatchTerms = append(d.MatchTerms, q)
	}
	if target != "" {
		query(target)
		short := PeerSearchKey(target)
		if len([]rune(short)) >= 3 && !containsAny(short, "人民币", "美元") {
			query(short)
		}
	}
	// Prefer narrow mandate terms; never search the generic word “指数”.
	for _, term := range sectorTerms {
		query(term)
	}
	if d.Sector != "" {
		query(d.Sector)
	}
	if d.Primary.Key == "dividend" {
		query("红利")
	}
	if p.AssetClass == "bond" {
		query("债市")
		query("国债收益率")
	}
	if p.AssetClass == "money" {
		d.Queries = nil
		d.MatchTerms = nil
		query("资金面")
		query("货币市场")
	}
	if p.AssetClass == "commodity" {
		for _, term := range []string{"黄金", "白银", "原油", "豆粕", "有色金属"} {
			if containsAny(text, term) {
				query(term)
			}
		}
	}
	// Reserve a query for the sector/style so exact-name ETF news cannot crowd it out.
	if len(d.Queries) > 3 {
		d.Queries = []string{d.Queries[0], d.Queries[2], d.Queries[len(d.Queries)-1]}
	}
	return d
}

func BuildDirectionTechnical(symbol, name, relationship string, lines []foundation.KLine, now time.Time) *DirectionTechnical {
	bars := CompletedBars(lines, now)
	// An index return must not silently include a different instrument's bars.
	filtered := bars[:0]
	for _, b := range bars {
		if b.Symbol == symbol {
			filtered = append(filtered, b)
		}
	}
	bars = filtered
	if len(bars) == 0 {
		return nil
	}
	d := &DirectionTechnical{Symbol: symbol, Name: name, Relationship: relationship, AsOf: bars[len(bars)-1].Time.In(foundation.AStockLocation).Format("2006-01-02"), Trend: "unknown", Metrics: []Metric{}, Bars: bars[max(0, len(bars)-65):], Limitations: []string{}}
	// Reuse the tested continuous-window math, but never fund split/NAV semantics.
	facts := Build(foundation.ETFProfile{AssetClass: "equity"}, foundation.ETFNetValues{}, bars, now)
	for _, m := range facts.Metrics {
		if strings.Contains(m.Label, "价格涨幅") {
			m.Method = "完整交易日指数收盘价格收益；不含分红"
		}
		if strings.HasPrefix(m.Label, "MA") {
			m.Unit = "点"
			m.Method = "完整交易日指数收盘均值"
		}
		if strings.Contains(m.Label, "回撤") {
			m.Method = "可用20至60个完整交易日的指数收盘最大回撤"
		}
		d.Metrics = append(d.Metrics, m)
	}
	close := bars[len(bars)-1].Close
	add := func(label string, v *float64, unit, method string) {
		d.Metrics = append(d.Metrics, Metric{label, v, unit, d.AsOf, method})
	}
	add("最近收盘", number(close), "点", "完整交易日收盘")
	ma := map[string]float64{}
	for _, m := range d.Metrics {
		if m.Value != nil {
			ma[m.Label] = *m.Value
		}
	}
	if ma["MA5"] > 0 && ma["MA20"] > 0 && ma["MA60"] > 0 {
		d.Trend = "mixed"
		if close > ma["MA5"] && ma["MA5"] > ma["MA20"] && ma["MA20"] > ma["MA60"] {
			d.Trend = "rising"
		}
		if close < ma["MA5"] && ma["MA5"] < ma["MA20"] && ma["MA20"] < ma["MA60"] {
			d.Trend = "falling"
		}
	}
	if len(bars) >= 20 && continuousBars(bars[len(bars)-20:]) {
		high, low := 0., math.MaxFloat64
		for _, b := range bars[len(bars)-20:] {
			high = math.Max(high, b.High)
			low = math.Min(low, b.Low)
		}
		add("20日区间高点", number(high), "点", "最近20个完整交易日最高价；非ETF入场价")
		add("20日区间低点", number(low), "点", "最近20个完整交易日最低价；非ETF止损价")
	}
	// Compare the last five sessions against the preceding twenty (non-overlapping).
	if len(bars) >= 25 {
		recent, previous, valid := 0., 0., true
		for i, b := range bars[len(bars)-25:] {
			if b.Amount <= 0 || math.IsNaN(b.Amount) || math.IsInf(b.Amount, 0) {
				valid = false
			}
			if i < 20 {
				previous += b.Amount
			} else {
				recent += b.Amount
			}
		}
		if valid {
			add("5日/此前20日成交额比", number((recent/5)/(previous/20)), "倍", "不重叠窗口平均成交额之比；成交额不等于资金净流入")
		}
	}
	expected := now.In(foundation.AStockLocation)
	if expected.Hour() < 15 {
		expected = expected.AddDate(0, 0, -1)
	}
	for !foundation.IsAStockTradingDay(expected) {
		expected = expected.AddDate(0, 0, -1)
	}
	if d.AsOf < expected.Format("2006-01-02") {
		d.Limitations = append(d.Limitations, "行情截至"+d.AsOf+"，落后于最近A股完整交易日；跨境须另核当地交易日")
	}
	if len(bars) < 60 {
		d.Limitations = append(d.Limitations, fmt.Sprintf("仅有%d个完整交易日，较长窗口指标按实际可用数据计算", len(bars)))
	}
	if relationship == "sector_reference" {
		d.Limitations = append(d.Limitations, "行业板块仅作相关方向参照，成分与基金跟踪指数不同，不计算跟踪质量")
	}
	if relationship == "etf_price_proxy" {
		for i := range d.Metrics {
			if d.Metrics[i].Unit == "点" {
				d.Metrics[i].Unit = "元"
			}
			d.Metrics[i].Method = strings.ReplaceAll(d.Metrics[i].Method, "指数", "ETF")
		}
		d.Limitations = append(d.Limitations, "未取得对应指数或板块日线；此处仅为ETF市价趋势，可能包含折溢价影响，不能当作指数走势")
	}
	return d
}
