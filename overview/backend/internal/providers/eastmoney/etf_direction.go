package eastmoney

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"easy-stock/backend/internal/foundation"
)

// These aliases map disclosed full names to provider index short names. They do
// not collapse total-return, low-volatility, currency or other strategy variants.
var etfIndexAliases = map[string]string{
	"上证红利指数": "红利指数", "上证科创板芯片指数": "科创芯片", "上证科创板50成份指数": "科创50",
	"中证全指半导体产品与设备指数": "半导体", "国证半导体芯片指数": "半导体芯片",
	"中证红利低波动指数": "红利低波", "中证红利低波动100指数": "红利低波100",
	"上证科创板100指数": "科创100", "中证全指证券公司指数": "证券公司",
}

func indexNameKey(s string) string {
	return strings.TrimSuffix(strings.Join(strings.Fields(strings.ToLower(s)), ""), "指数")
}

func (c *Client) ETFIndexSeries(ctx context.Context, target string, limit int) (foundation.ETFMarketSeries, error) {
	name := strings.TrimSpace(target)
	if alias := etfIndexAliases[name]; alias != "" {
		name = alias
	}
	if name == "" || strings.Contains(name, "无跟踪") {
		return foundation.ETFMarketSeries{}, fmt.Errorf("missing tracking index")
	}
	base := c.indexSearchBaseURL
	if base == "" {
		base = "https://searchapi.eastmoney.com"
	}
	address := base + "/api/suggest/get?" + url.Values{"input": {name}, "type": {"14"}, "count": {"50"}}.Encode()
	var payload struct {
		Table struct {
			Data []struct {
				Name             string `json:"Name"`
				QuoteID          string `json:"QuoteID"`
				SecurityTypeName string `json:"SecurityTypeName"`
			}
			Status int
		} `json:"QuotationCodeTable"`
	}
	if err := c.getJSONWithRetry(ctx, address, &payload); err != nil {
		return foundation.ETFMarketSeries{}, err
	}
	id, actual := "", ""
	for _, item := range payload.Table.Data {
		if item.SecurityTypeName != "指数" || indexNameKey(item.Name) != indexNameKey(name) || !etfIndexQuoteID.MatchString(item.QuoteID) {
			continue
		}
		if id != "" && id != item.QuoteID {
			return foundation.ETFMarketSeries{}, fmt.Errorf("ambiguous tracking index: %s", target)
		}
		id, actual = item.QuoteID, item.Name
	}
	if payload.Table.Status != 0 || id == "" {
		return foundation.ETFMarketSeries{}, fmt.Errorf("no exact tracking index match: %s", target)
	}
	return c.etfIndexBars(ctx, id, actual, limit)
}

var etfIndexQuoteID = regexp.MustCompile(`^[0-9]{1,3}\.[A-Za-z0-9]{1,16}$`)

func (c *Client) etfIndexBars(ctx context.Context, id, name string, limit int) (foundation.ETFMarketSeries, error) {
	params := url.Values{"secid": {id}, "fields1": {"f1,f2,f3,f4,f5,f6"}, "fields2": {"f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"}, "klt": {"101"}, "fqt": {"0"}, "end": {"20500101"}, "lmt": {strconv.Itoa(min(max(limit, 1), 300))}}
	address := c.baseURL + "/api/qt/stock/kline/get?" + params.Encode()
	var payload struct {
		RC   int `json:"rc"`
		Data struct {
			Code   string   `json:"code"`
			KLines []string `json:"klines"`
		} `json:"data"`
	}
	if err := c.getJSONWithRetry(ctx, address, &payload); err != nil {
		return foundation.ETFMarketSeries{}, err
	}
	parts := strings.SplitN(id, ".", 2)
	if payload.RC != 0 || payload.Data.Code != parts[1] || len(payload.Data.KLines) == 0 {
		return foundation.ETFMarketSeries{}, fmt.Errorf("tracking index series unavailable or identity differs")
	}
	symbol := id
	if len(parts[1]) == 6 {
		if parts[0] == "1" {
			symbol = parts[1] + ".SH"
		}
		if parts[0] == "0" {
			symbol = parts[1] + ".SZ"
		}
	}
	meta := foundation.SourceMeta{Source: "eastmoney:etf-tracking-index", SourceURL: address, FetchedAt: time.Now().UTC()}
	result := foundation.ETFMarketSeries{Symbol: symbol, Name: name, Relationship: "tracking_index", Meta: meta, Bars: []foundation.KLine{}}
	for _, raw := range payload.Data.KLines {
		b, err := parseKLine(raw, symbol, meta)
		if err != nil {
			return foundation.ETFMarketSeries{}, err
		}
		result.Bars = append(result.Bars, b)
	}
	return result, nil
}

func (c *Client) ETFSectorSeries(ctx context.Context, name string, limit int) (foundation.ETFMarketSeries, error) {
	boards, err := c.Boards(ctx, name, 30)
	if err != nil {
		return foundation.ETFMarketSeries{}, err
	}
	var matched foundation.Board
	for _, b := range boards {
		if strings.TrimSpace(b.Name) != name {
			continue
		}
		if matched.Code != "" && matched.Code != b.Code {
			return foundation.ETFMarketSeries{}, fmt.Errorf("ambiguous sector")
		}
		matched = b
	}
	if matched.Code == "" {
		return foundation.ETFMarketSeries{}, fmt.Errorf("no exact related sector")
	}
	bars, err := c.BoardKLine(ctx, matched.Code, limit)
	if err != nil {
		return foundation.ETFMarketSeries{}, err
	}
	result := foundation.ETFMarketSeries{Symbol: matched.Code, Name: matched.Name, Relationship: "sector_reference", Bars: bars}
	if len(bars) > 0 {
		result.Meta = bars[len(bars)-1].Meta
	}
	return result, nil
}
