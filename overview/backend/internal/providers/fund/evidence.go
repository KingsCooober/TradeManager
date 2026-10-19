package fund

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"easy-stock/backend/internal/foundation"
	"golang.org/x/net/html"
)

func (c *Client) ETFHoldings(ctx context.Context, value, asset string) (foundation.ETFHoldings, error) {
	symbol, err := etfSymbol(value)
	if err != nil {
		return foundation.ETFHoldings{}, err
	}
	kind := "jjcc"
	if asset == "bond" {
		kind = "zqcc"
	} else if asset != "equity" {
		return foundation.ETFHoldings{}, fmt.Errorf("unsupported holding type")
	}
	q := url.Values{"type": {kind}, "code": {strings.Split(symbol, ".")[0]}, "topline": {"10"}, "year": {""}, "month": {""}}
	body, meta, err := c.read(ctx, c.ProfileURL+"/FundArchivesDatas.aspx?"+q.Encode())
	if err != nil {
		return foundation.ETFHoldings{}, err
	}
	h, err := parseHoldings(string(body), symbol, asset)
	h.Meta = meta
	return h, err
}

var archiveContent = regexp.MustCompile(`(?s)\bcontent\s*:\s*("(?:[^"\\]|\\.)*")`)
var disclosureDate = regexp.MustCompile(`\d{4}-\d{2}-\d{2}`)

func parseHoldings(body, symbol, asset string) (foundation.ETFHoldings, error) {
	result := foundation.ETFHoldings{Symbol: symbol, AssetType: asset, Scope: "来源最近一期前十大披露持仓；非完整持仓、非实时申赎清单", Items: []foundation.ETFHolding{}}
	m := archiveContent.FindStringSubmatch(body)
	var content string
	if len(m) < 2 || json.Unmarshal([]byte(m[1]), &content) != nil {
		return result, fmt.Errorf("fund holdings content unavailable")
	}
	root, err := html.Parse(strings.NewReader(content))
	if err != nil {
		return result, err
	}
	type section struct {
		date  string
		items []foundation.ETFHolding
	}
	sections := []section{}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Data == "div" && strings.Contains(" "+attr(n, "class")+" ", " boxitem ") {
			// The archive endpoint is code scoped; additionally verify its product link.
			linked := false
			var verify func(*html.Node)
			verify = func(x *html.Node) {
				if x.Data == "a" && strings.Contains(attr(x, "href"), "/"+strings.Split(symbol, ".")[0]+".html") {
					linked = true
				}
				for ch := x.FirstChild; ch != nil; ch = ch.NextSibling {
					verify(ch)
				}
			}
			verify(n)
			if !linked {
				return
			}
			sec := section{}
			headers := []string{}
			var rows func(*html.Node)
			rows = func(x *html.Node) {
				if x.Data == "h4" {
					sec.date = disclosureDate.FindString(textOf(x))
				}
				if x.Data == "tr" {
					cells := []*html.Node{}
					for ch := x.FirstChild; ch != nil; ch = ch.NextSibling {
						if ch.Data == "th" || ch.Data == "td" {
							cells = append(cells, ch)
						}
					}
					if len(cells) > 0 && cells[0].Data == "th" {
						for _, ch := range cells {
							headers = append(headers, textOf(ch))
						}
					} else if len(cells) == len(headers) {
						h := foundation.ETFHolding{}
						validWeight := false
						for i, ch := range cells {
							label := headers[i]
							text := textOf(ch)
							switch {
							case strings.Contains(label, "代码"):
								h.Code = text
								var link func(*html.Node)
								link = func(a *html.Node) {
									href := attr(a, "href")
									re := regexp.MustCompile(`/unify/r/([01])\.(\d{6})(?:$|[?])`)
									if m := re.FindStringSubmatch(href); len(m) > 0 {
										market := "SZ"
										if m[1] == "1" {
											market = "SH"
										}
										h.Symbol = m[2] + "." + market
									}
									for child := a.FirstChild; child != nil; child = child.NextSibling {
										link(child)
									}
								}
								link(ch)
							case strings.Contains(label, "名称"):
								h.Name = text
							case strings.Contains(label, "占净值") || strings.Contains(label, "占净资产"):
								v, e := strconv.ParseFloat(strings.TrimSuffix(text, "%"), 64)
								if e == nil && strings.HasSuffix(text, "%") && v >= 0 && v <= 100 && !math.IsNaN(v) {
									h.WeightPercent = v
									validWeight = true
								}
							}
						}
						if h.Code != "" && h.Name != "" && validWeight {
							sec.items = append(sec.items, h)
						}
					}
				}
				for ch := x.FirstChild; ch != nil; ch = ch.NextSibling {
					rows(ch)
				}
			}
			rows(n)
			if _, e := time.Parse("2006-01-02", sec.date); e == nil && len(sec.items) > 0 {
				sections = append(sections, sec)
			}
			return
		}
		for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
			walk(ch)
		}
	}
	walk(root)
	if len(sections) == 0 {
		return result, fmt.Errorf("fund returned no dated holdings")
	}
	sort.Slice(sections, func(i, j int) bool { return sections[i].date > sections[j].date })
	result.ReportDate = sections[0].date
	seen := map[string]bool{}
	for _, h := range sections[0].items {
		if seen[h.Code] {
			continue
		}
		seen[h.Code] = true
		result.Items = append(result.Items, h)
		result.DisclosedWeightPercent += h.WeightPercent
		if len(result.Items) == 10 {
			break
		}
	}
	if result.DisclosedWeightPercent > 100.1 {
		return foundation.ETFHoldings{}, fmt.Errorf("invalid holdings weights")
	}
	result.DisclosedWeightPercent = math.Round(result.DisclosedWeightPercent*100) / 100
	return result, nil
}
func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func (c *Client) ETFAnnouncements(ctx context.Context, value string, limit int) ([]foundation.ETFAnnouncement, error) {
	symbol, err := etfSymbol(value)
	if err != nil {
		return nil, err
	}
	if limit < 1 || limit > 20 {
		limit = 10
	}
	code := strings.Split(symbol, ".")[0]
	base := c.NoticeURL
	if base == "" {
		base = "https://api.fund.eastmoney.com"
	}
	body, meta, err := c.read(ctx, base+"/f10/JJGG?"+url.Values{"fundcode": {code}, "pageIndex": {"1"}, "pageSize": {strconv.Itoa(limit)}, "type": {"0"}}.Encode())
	if err != nil {
		return nil, err
	}
	var raw struct {
		Data []struct {
			Code  string `json:"FUNDCODE"`
			ID    string `json:"ID"`
			Title string `json:"TITLE"`
			Date  string `json:"PUBLISHDATE"`
		} `json:"Data"`
	}
	if err = json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	items := []foundation.ETFAnnouncement{}
	seen := map[string]bool{}
	for _, r := range raw.Data {
		at, e := time.ParseInLocation("2006-01-02T15:04:05", r.Date, time.FixedZone("CST", 8*3600))
		if e != nil || r.Code != code || !regexp.MustCompile(`^AN\d+$`).MatchString(r.ID) || r.Title == "" || seen[r.ID] || at.After(time.Now()) {
			continue
		}
		seen[r.ID] = true
		items = append(items, foundation.ETFAnnouncement{ID: r.ID, Symbol: symbol, Title: r.Title, PublishedAt: at, URL: c.BaseURL + "/gonggao/" + code + "," + r.ID + ".html", ContentStatus: "title_only", Meta: meta})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].PublishedAt.After(items[j].PublishedAt) })
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (c *Client) ETFAnnouncementBody(ctx context.Context, item foundation.ETFAnnouncement) (foundation.ETFAnnouncement, error) {
	if !regexp.MustCompile(`^AN\d+$`).MatchString(item.ID) {
		return item, fmt.Errorf("invalid announcement id")
	}
	base := c.NoticeContentURL
	if base == "" {
		base = "https://np-cnotice-fund.eastmoney.com"
	}
	body, meta, err := c.read(ctx, base+"/api/content/ann?"+url.Values{"client_source": {"web_fund"}, "show_all": {"1"}, "art_code": {item.ID}}.Encode())
	if err != nil {
		return item, err
	}
	var raw struct {
		Success int `json:"success"`
		Data    struct {
			ID      string `json:"art_code"`
			Title   string `json:"notice_title"`
			Content string `json:"notice_content"`
		} `json:"data"`
	}
	if err = json.Unmarshal(body, &raw); err != nil {
		return item, err
	}
	if raw.Success != 1 || raw.Data.ID != item.ID || strings.TrimSpace(raw.Data.Content) == "" {
		return item, fmt.Errorf("announcement body unavailable or identity mismatch")
	}
	item.Content = raw.Data.Content
	item.ContentStatus = "fulltext"
	if len([]rune(item.Content)) > 20000 {
		item.Content = string([]rune(item.Content)[:20000])
		item.ContentStatus = "excerpt"
	}
	item.Meta = meta
	return item, nil
}

// A bounded recent sample, preserving title-only rows when body retrieval fails.
func (c *Client) ETFDisclosures(ctx context.Context, symbol string) ([]foundation.ETFAnnouncement, error) {
	items, err := c.ETFAnnouncements(ctx, symbol, 10)
	if err != nil {
		return nil, err
	}
	var wg sync.WaitGroup
	selected := selectedNoticeBodies(items)
	for i := range items {
		if !selected[i] {
			continue
		}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if item, e := c.ETFAnnouncementBody(ctx, items[i]); e == nil {
				items[i] = item
			}
		}(i)
	}
	wg.Wait()
	return items, nil
}

// Prioritize events that change interpretation, even when outside the newest
// three announcements. Retrieval remains bounded and individual failures isolate.
func selectedNoticeBodies(items []foundation.ETFAnnouncement) map[int]bool {
	selected := map[int]bool{}
	for _, keyword := range []string{"拆分", "折算", "分红", "中期报告", "年度报告", "季度报告", "申购", "赎回", "停牌", "复牌", "费率"} {
		for i, n := range items {
			if len(selected) >= 6 {
				return selected
			}
			if strings.Contains(n.Title, keyword) {
				selected[i] = true
				break
			}
		}
	}
	for i := range items {
		if len(selected) >= 6 {
			break
		}
		selected[i] = true
	}
	return selected
}
