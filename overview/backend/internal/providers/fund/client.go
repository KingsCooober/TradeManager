// Package fund reads public fund records without executing provider JavaScript.
package fund

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"easy-stock/backend/internal/foundation"
	"golang.org/x/net/html"
)

type Client struct {
	HTTP             *http.Client
	BaseURL          string
	ProfileURL       string
	NoticeURL        string
	NoticeContentURL string
	mu               sync.Mutex
	catalog          []foundation.Instrument
	catalogAt        time.Time
	profiles         map[string]foundation.ETFProfile
}

func NewClient() *Client {
	return &Client{HTTP: &http.Client{Timeout: 12 * time.Second}, BaseURL: "https://fund.eastmoney.com", ProfileURL: "https://fundf10.eastmoney.com", profiles: map[string]foundation.ETFProfile{}}
}

func (c *Client) read(ctx context.Context, address string) ([]byte, foundation.SourceMeta, error) {
	start := time.Now()
	meta := foundation.SourceMeta{Source: "eastmoney:fund", SourceURL: address, FetchedAt: start.UTC()}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, meta, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 easy-stock")
	req.Header.Set("Referer", c.ProfileURL+"/")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, meta, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, meta, fmt.Errorf("fund HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, (8<<20)+1))
	if len(body) > 8<<20 {
		return nil, meta, fmt.Errorf("fund response too large")
	}
	meta.LatencyMS = time.Since(start).Milliseconds()
	return body, meta, err
}

func (c *Client) ETFDirectory(ctx context.Context) ([]foundation.Instrument, error) {
	c.mu.Lock()
	cached, at := append([]foundation.Instrument(nil), c.catalog...), c.catalogAt
	c.mu.Unlock()
	if len(cached) > 0 && time.Since(at) < 6*time.Hour {
		return cached, nil
	}
	body, _, err := c.read(ctx, c.BaseURL+"/js/fundcode_search.js")
	if err != nil {
		return nil, err
	}
	items, err := parseDirectory(string(body))
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.catalog = items
	c.catalogAt = time.Now()
	c.mu.Unlock()
	return append([]foundation.Instrument(nil), items...), nil
}

func parseDirectory(body string) ([]foundation.Instrument, error) {
	start, end := strings.Index(body, "["), strings.LastIndex(body, "]")
	if start < 0 || end <= start {
		return nil, fmt.Errorf("fund directory array unavailable")
	}
	var rows [][]string
	if err := json.Unmarshal([]byte(body[start:end+1]), &rows); err != nil {
		return nil, err
	}
	items := []foundation.Instrument{}
	seen := map[string]bool{}
	for _, r := range rows {
		if len(r) < 4 || !strings.Contains(strings.ToUpper(r[2]), "ETF") || strings.Contains(r[2], "联接") || seen[r[0]] {
			continue
		}
		symbol, err := etfSymbol(r[0])
		if err != nil {
			continue
		}
		seen[r[0]] = true
		items = append(items, foundation.Instrument{Symbol: symbol, Code: r[0], Name: r[2], InstrumentType: "etf", FundType: r[3]})
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("fund directory contains no listed ETFs")
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Symbol < items[j].Symbol })
	return items, nil
}

// This narrows the lookup space only; the full fund profile verifies ETF identity.
func etfSymbol(value string) (string, error) {
	code := strings.Split(strings.ToUpper(strings.TrimSpace(value)), ".")[0]
	if !regexp.MustCompile(`^\d{6}$`).MatchString(code) {
		return "", fmt.Errorf("invalid ETF code")
	}
	market := ""
	if strings.HasPrefix(code, "5") {
		market = "SH"
	} else if strings.HasPrefix(code, "15") || strings.HasPrefix(code, "16") {
		market = "SZ"
	}
	if market == "" {
		return "", fmt.Errorf("not a supported listed fund code")
	}
	symbol := code + "." + market
	if strings.Contains(value, ".") && strings.ToUpper(value) != symbol {
		return "", fmt.Errorf("ETF code and exchange disagree")
	}
	return symbol, nil
}

func (c *Client) ETFProfile(ctx context.Context, value string) (foundation.ETFProfile, error) {
	symbol, err := etfSymbol(value)
	if err != nil {
		return foundation.ETFProfile{}, err
	}
	c.mu.Lock()
	cached, ok := c.profiles[symbol]
	c.mu.Unlock()
	if ok && time.Since(cached.Meta.FetchedAt) < 6*time.Hour {
		return cached, nil
	}
	code := strings.Split(symbol, ".")[0]
	body, meta, err := c.read(ctx, c.ProfileURL+"/jbgk_"+code+".html")
	if err != nil {
		return foundation.ETFProfile{}, err
	}
	profile, err := parseProfile(string(body), symbol)
	if err != nil {
		return profile, err
	}
	profile.Meta = meta
	c.mu.Lock()
	if c.profiles == nil {
		c.profiles = map[string]foundation.ETFProfile{}
	}
	c.profiles[symbol] = profile
	c.mu.Unlock()
	return profile, nil
}

func textOf(n *html.Node) string {
	if n.Type == html.TextNode {
		return n.Data
	}
	if n.Data == "script" || n.Data == "style" {
		return ""
	}
	var b strings.Builder
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		b.WriteString(textOf(ch))
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

func parseProfile(body, symbol string) (foundation.ETFProfile, error) {
	p := foundation.ETFProfile{Instrument: foundation.Instrument{Symbol: symbol, Code: strings.Split(symbol, ".")[0], InstrumentType: "etf"}, PricePrecision: 3}
	root, err := html.Parse(strings.NewReader(body))
	if err != nil {
		return p, err
	}
	fields := map[string]string{}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "tr" {
			label := ""
			for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
				if ch.Data == "th" {
					label = textOf(ch)
				}
				if ch.Data == "td" && label != "" {
					fields[label] = textOf(ch)
					label = ""
				}
			}
		}
		// Descriptive sections use h4 followed by a div inside the same box.
		if n.Type == html.ElementNode && n.Data == "h4" {
			label := textOf(n)
			for sib := n.NextSibling; sib != nil; sib = sib.NextSibling {
				if sib.Type == html.ElementNode {
					if sib.Data == "h4" {
						break
					}
					if content := textOf(sib); content != "" {
						fields[label] = content
						break
					}
				}
			}
		}
		for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
			walk(ch)
		}
	}
	walk(root)
	p.FullName = fields["基金全称"]
	p.Name = fields["基金简称"]
	p.FundType = fields["基金类型"]
	if !strings.HasPrefix(fields["基金代码"], p.Code) || p.Name == "" || strings.Contains(p.FullName, "联接") || !strings.Contains(p.FullName, "交易型") || (!strings.Contains(p.FullName, "开放式") && !(strings.Contains(p.FundType, "货币") && strings.Contains(p.Name, "ETF"))) {
		return p, fmt.Errorf("无法从基金档案确认 %s 是场内 ETF", symbol)
	}
	p.Manager = fields["基金管理人"]
	p.Benchmark = fields["业绩比较基准"]
	p.TrackingTarget = fields["跟踪标的"]
	p.InvestmentScope = fields["投资范围"]
	p.Strategy = fields["投资策略"]
	p.RiskDescription = fields["风险收益特征"]
	p.Distribution = fields["收益分配原则"]
	p.ManagementFee = fields["管理费率"]
	p.CustodyFee = fields["托管费率"]
	p.Size = fields["净资产规模"]
	p.Shares = fields["份额规模"]
	p.Inception = fields["成立日期/规模"]
	p.AssetClass = "unknown"
	switch {
	case strings.Contains(p.FundType, "货币"):
		p.AssetClass = "money"
	case strings.Contains(p.FundType, "股票"):
		p.AssetClass = "equity"
	case strings.Contains(p.FundType, "固收") || strings.Contains(p.FundType, "债券"):
		p.AssetClass = "bond"
	case strings.Contains(p.FullName, "黄金") || strings.Contains(p.InvestmentScope, "黄金") || strings.Contains(p.FullName, "商品") || strings.Contains(p.FullName, "期货"):
		p.AssetClass = "commodity"
	}
	p.CrossBorder = strings.Contains(p.FundType, "海外") || strings.Contains(p.FundType, "QDII") || strings.Contains(p.FullName, "QDII")
	return p, nil
}

func jsValue(body, key string) string {
	re := regexp.MustCompile(`(?s)\bvar\s+` + regexp.QuoteMeta(key) + `\s*=\s*([^;]+);`)
	m := re.FindStringSubmatch(body)
	if len(m) < 2 {
		return ""
	}
	return strings.TrimSpace(m[1])
}

func (c *Client) ETFNetValues(ctx context.Context, value string) (foundation.ETFNetValues, error) {
	symbol, err := etfSymbol(value)
	if err != nil {
		return foundation.ETFNetValues{}, err
	}
	body, meta, err := c.read(ctx, c.BaseURL+"/pingzhongdata/"+strings.Split(symbol, ".")[0]+".js")
	if err != nil {
		return foundation.ETFNetValues{}, err
	}
	data, err := parseNetValues(string(body), symbol)
	data.Meta = meta
	return data, err
}

func parseNetValues(body, symbol string) (foundation.ETFNetValues, error) {
	data := foundation.ETFNetValues{Symbol: symbol, Points: []foundation.ETFNAVPoint{}}
	var code string
	if json.Unmarshal([]byte(jsValue(body, "fS_code")), &code) != nil || code != strings.Split(symbol, ".")[0] {
		return data, fmt.Errorf("fund net value identity mismatch")
	}
	date := func(ms int64) string {
		return time.UnixMilli(ms).In(time.FixedZone("CST", 8*3600)).Format("2006-01-02")
	}
	var rows []struct {
		X         int64   `json:"x"`
		Y         float64 `json:"y"`
		UnitMoney string  `json:"unitMoney"`
	}
	if raw := jsValue(body, "Data_netWorthTrend"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &rows); err != nil {
			return data, err
		}
		sort.SliceStable(rows, func(i, j int) bool { return rows[i].X < rows[j].X })
		for _, r := range rows[max(0, len(rows)-300):] {
			if r.Y > 0 && r.X > 0 {
				data.Points = append(data.Points, foundation.ETFNAVPoint{Date: date(r.X), Value: r.Y, Distribution: r.UnitMoney})
			}
		}
	}
	for key, target := range map[string]*[]foundation.ETFNAVPoint{"Data_millionCopiesIncome": &data.IncomePerTenThousand, "Data_sevenDaysYearIncome": &data.SevenDayAnnualized} {
		if raw := jsValue(body, key); raw != "" {
			var values [][]float64
			if err := json.Unmarshal([]byte(raw), &values); err != nil {
				return data, err
			}
			sort.SliceStable(values, func(i, j int) bool {
				if len(values[i]) == 0 || len(values[j]) == 0 {
					return len(values[i]) < len(values[j])
				}
				return values[i][0] < values[j][0]
			})
			for _, r := range values[max(0, len(values)-90):] {
				if len(r) >= 2 && r[0] > 0 {
					*target = append(*target, foundation.ETFNAVPoint{Date: date(int64(r[0])), Value: r[1]})
				}
			}
		}
	}
	if len(data.Points)+len(data.IncomePerTenThousand)+len(data.SevenDayAnnualized) == 0 {
		return data, fmt.Errorf("fund returned no net value or income series")
	}
	return data, nil
}
