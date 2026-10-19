package httpapi

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"easy-stock/backend/internal/etfanalysis"
	"easy-stock/backend/internal/foundation"
	"easy-stock/backend/internal/stockanalysis"
)

func (s *Server) collectETFDirectionMarket(ctx context.Context, p foundation.ETFProfile, c etfanalysis.DirectionClassification) foundation.ETFMarketSeries {
	if p.AssetClass == "money" {
		return foundation.ETFMarketSeries{}
	}
	ctx, cancel := context.WithTimeout(ctx, 18*time.Second)
	defer cancel()
	if symbol := etfanalysis.BenchmarkSymbol(p); symbol != "" {
		sub, stop := context.WithTimeout(ctx, 10*time.Second)
		bars, _ := s.loadKLine(sub, symbol, "day", 120)
		stop()
		if len(bars) > 0 {
			return foundation.ETFMarketSeries{Symbol: symbol, Name: p.TrackingTarget, Relationship: "tracking_index", Bars: bars, Meta: bars[len(bars)-1].Meta}
		}
	}
	if s.etfDirectionMarket == nil {
		return foundation.ETFMarketSeries{}
	}
	if c.Status == "disclosed_target" || c.Status == "unclassified" {
		sub, stop := context.WithTimeout(ctx, 10*time.Second)
		series, err := s.etfDirectionMarket.ETFIndexSeries(sub, p.TrackingTarget, 120)
		stop()
		if err == nil && len(series.Bars) > 0 && series.Relationship == "tracking_index" {
			// Overseas daily bars have different close times. Exclude the current
			// calendar day unless completion can be independently verified.
			if p.CrossBorder {
				today := time.Now().In(foundation.AStockLocation).Format("2006-01-02")
				filtered := []foundation.KLine{}
				for _, b := range series.Bars {
					if b.Time.In(foundation.AStockLocation).Format("2006-01-02") < today {
						filtered = append(filtered, b)
					}
				}
				series.Bars = filtered
			}
			return series
		}
	}
	// Mainland sector quotes cannot substitute for an overseas investment universe.
	if c.Sector != "" && !p.CrossBorder && c.Status == "disclosed_target" {
		if series, err := s.etfDirectionMarket.ETFSectorSeries(ctx, c.Sector, 120); err == nil && series.Relationship == "sector_reference" {
			return series
		}
	}
	return foundation.ETFMarketSeries{}
}

func selectETFDirectionNews(items []foundation.NewsItem, c etfanalysis.DirectionClassification, cutoff time.Time, limit int) []etfanalysis.DirectionNews {
	result := []etfanalysis.DirectionNews{}
	seen := map[string]bool{}
	for _, item := range items {
		if strings.TrimSpace(item.Title) == "" || item.PublishedAt.IsZero() || item.PublishedAt.After(cutoff) || item.PublishedAt.Before(cutoff.AddDate(0, 0, -30)) {
			continue
		}
		title, text := strings.ToLower(item.Title), strings.ToLower(item.Title+" "+item.Content)
		terms := []string{}
		headline := false
		for _, term := range c.MatchTerms {
			if len([]rune(term)) >= 2 && strings.Contains(text, strings.ToLower(term)) {
				terms = append(terms, term)
				headline = headline || strings.Contains(title, strings.ToLower(term))
			}
		}
		if len(terms) == 0 || (!headline && len(terms) < 2) {
			continue
		}
		// “人口红利”等语言碰撞不构成股息策略证据。
		if c.Primary.Key == "dividend" && containsETFText(title, "人口红利", "流量红利", "数字红利") && !containsETFText(text, "股息", "分红", "红利指数", "红利低波") {
			continue
		}
		titleKey := strings.Join(strings.Fields(title), "")
		if seen[titleKey] || item.URL != "" && seen[item.URL] {
			continue
		}
		seen[titleKey] = true
		if item.URL != "" {
			seen[item.URL] = true
		}
		relevance := "direction"
		crossBorder := false
		for _, tag := range c.Tags {
			crossBorder = crossBorder || tag.Key == "cross_border"
		}
		if !crossBorder && containsETFText(title, "美股", "费城", "海外", "港股", "美联储") {
			relevance = "market_context"
		}
		if containsETFText(title, "etf", "基金") {
			relevance = "product_context"
		}
		source := stockanalysis.NewResearchSource("news", item.Title, item.Content, item.Meta.Source, item.URL, item.PublishedAt, cutoff)
		result = append(result, etfanalysis.DirectionNews{SourceID: source.ID, Item: item, MatchedTerms: terms, Relevance: relevance})
	}
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].Relevance != result[j].Relevance {
			rank := map[string]int{"direction": 0, "market_context": 1, "product_context": 2}
			return rank[result[i].Relevance] < rank[result[j].Relevance]
		}
		return result[i].Item.PublishedAt.After(result[j].Item.PublishedAt)
	})
	return result[:min(max(limit, 0), len(result))]
}
func containsETFText(s string, terms ...string) bool {
	for _, term := range terms {
		if strings.Contains(s, term) {
			return true
		}
	}
	return false
}

func (s *Server) collectETFDirectionNews(ctx context.Context, symbol string, c etfanalysis.DirectionClassification, cutoff time.Time) ([]etfanalysis.DirectionNews, etfanalysis.DirectionNewsCoverage) {
	coverage := etfanalysis.DirectionNewsCoverage{Status: "unavailable", From: cutoff.AddDate(0, 0, -30), To: cutoff, Queries: append([]string{}, c.Queries...), FailedQueries: []string{}}
	empty := []etfanalysis.DirectionNews{}
	if s.stockNewsSearch == nil || len(c.Queries) == 0 {
		return empty, coverage
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	rows := make([][]foundation.NewsItem, len(c.Queries))
	errs := make([]error, len(c.Queries))
	var wg sync.WaitGroup
	for i, q := range c.Queries {
		wg.Add(1)
		go func(i int, q string) {
			defer wg.Done()
			rows[i], errs[i] = s.stockNewsSearch.SearchStockNews(ctx, symbol, q, 30)
		}(i, q)
	}
	wg.Wait()
	items := []foundation.NewsItem{}
	for i, row := range rows {
		if errs[i] != nil {
			coverage.FailedQueries = append(coverage.FailedQueries, c.Queries[i])
		} else {
			items = append(items, row...)
		}
	}
	news := selectETFDirectionNews(items, c, cutoff, 10)
	coverage.Count = len(news)
	coverage.Status = "retrieved"
	if len(news) == 0 {
		coverage.Status = "no_match"
	}
	if len(coverage.FailedQueries) > 0 {
		coverage.Status = "partial"
	}
	if len(coverage.FailedQueries) == len(c.Queries) {
		coverage.Status = "unavailable"
	}
	return news, coverage
}

func etfDirectionNewsSources(items []etfanalysis.DirectionNews, captured time.Time) []stockanalysis.ResearchSource {
	sources := []stockanalysis.ResearchSource{}
	for _, v := range items {
		content := "匹配投资方向关键词：" + strings.Join(v.MatchedTerms, "、") + "；相关性：" + v.Relevance + "（market_context为外围市场背景，product_context为产品相关消息，均不能单独证明跟踪指数或行业景气）。\n" + v.Item.Content
		src := stockanalysis.NewResearchSource("news", v.Item.Title, content, v.Item.Meta.Source, v.Item.URL, v.Item.PublishedAt, captured)
		src.ID = v.SourceID
		src.ContentStatus = "excerpt"
		sources = append(sources, src)
	}
	return sources
}
