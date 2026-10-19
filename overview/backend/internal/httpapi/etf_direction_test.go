package httpapi

import (
	"context"
	"easy-stock/backend/internal/etfanalysis"
	"easy-stock/backend/internal/foundation"
	"easy-stock/backend/internal/stockanalysis"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestETFDirectionNewsDatesRelevanceDedupAndProductContext(t *testing.T) {
	now := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	c := etfanalysis.ClassifyDirection(foundation.ETFProfile{TrackingTarget: "上证科创板芯片指数", AssetClass: "equity"})
	item := func(title string, date time.Time, url string) foundation.NewsItem {
		return foundation.NewsItem{Title: title, PublishedAt: date, URL: url, Content: "新闻摘要", Meta: foundation.SourceMeta{Source: "test"}}
	}
	rows := []foundation.NewsItem{
		item("半导体出口限制加剧", now.Add(-time.Hour), "https://test/1"),
		item("半导体需求改善", now.Add(-48*time.Hour), "https://test/2"),
		item("科创芯片ETF表现", now, "https://test/3"),
		item("基金经理评沪深300", now, "https://test/4"),
		item("半导体未来新闻", now.Add(time.Hour), "https://test/5"),
		item("半导体过时消息", now.AddDate(0, 0, -31), "https://test/6"),
		item("半导体没有时间", time.Time{}, "https://test/7"),
		item("半导体出口限制加剧", now, "https://test/8"),
	}
	got := selectETFDirectionNews(rows, c, now, 10)
	if len(got) != 3 || got[0].Item.Title != "半导体出口限制加剧" || got[2].Relevance != "product_context" {
		t.Fatal(got)
	}
	sources := etfDirectionNewsSources(got, now)
	if len(sources) != 3 || sources[0].ID != got[0].SourceID || sources[0].ContentStatus != "excerpt" || !strings.Contains(sources[0].Content, "半导体") {
		t.Fatal(sources)
	}
}

type etfDirectionNewsStub struct{}

func (etfDirectionNewsStub) SearchStockNews(_ context.Context, _ string, q string, _ int) ([]foundation.NewsItem, error) {
	if q == "失败" {
		return nil, errors.New("unavailable")
	}
	return []foundation.NewsItem{{Title: "半导体需求改善", PublishedAt: time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)}}, nil
}
func TestETFDirectionNewsPartialFailureKeepsEvidence(t *testing.T) {
	now := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	s := &Server{stockNewsSearch: etfDirectionNewsStub{}}
	c := etfanalysis.DirectionClassification{Queries: []string{"半导体", "失败"}, MatchTerms: []string{"半导体"}}
	news, coverage := s.collectETFDirectionNews(context.Background(), "588200.SH", c, now)
	if len(news) != 1 || coverage.Status != "partial" || len(coverage.FailedQueries) != 1 {
		t.Fatal(news, coverage)
	}
	c.Queries = []string{"失败"}
	_, coverage = s.collectETFDirectionNews(context.Background(), "588200.SH", c, now)
	if coverage.Status != "unavailable" {
		t.Fatal(coverage)
	}
}

type etfDirectionMarketStub struct{ sectorCalls int }

func (*etfDirectionMarketStub) ETFIndexSeries(context.Context, string, int) (foundation.ETFMarketSeries, error) {
	return foundation.ETFMarketSeries{}, errors.New("unavailable")
}
func (s *etfDirectionMarketStub) ETFSectorSeries(context.Context, string, int) (foundation.ETFMarketSeries, error) {
	s.sectorCalls++
	return foundation.ETFMarketSeries{Symbol: "BK001", Name: "半导体", Relationship: "sector_reference"}, nil
}
func TestETFDirectionNeverSubstitutesMainlandSectorForCrossBorder(t *testing.T) {
	provider := &etfDirectionMarketStub{}
	s := &Server{etfDirectionMarket: provider}
	p := foundation.ETFProfile{AssetClass: "equity", TrackingTarget: "海外半导体指数", CrossBorder: true}
	series := s.collectETFDirectionMarket(context.Background(), p, etfanalysis.ClassifyDirection(p))
	if provider.sectorCalls != 0 || series.Symbol != "" {
		t.Fatal(provider, series)
	}
	p.CrossBorder = false
	series = s.collectETFDirectionMarket(context.Background(), p, etfanalysis.ClassifyDirection(p))
	if provider.sectorCalls != 1 || series.Relationship != "sector_reference" {
		t.Fatal(provider, series)
	}
}

func TestETFDirectionNewsSupplementKeepsOriginalCutoff(t *testing.T) {
	s := &Server{stockNewsSearch: etfDirectionNewsStub{}}
	cutoff := time.Date(2026, 10, 12, 7, 0, 0, 0, time.UTC)
	snapshot := stockanalysis.ResearchSnapshot{InstrumentType: "etf", Symbol: "588200.SH", CutoffAt: cutoff, ETF: &etfanalysis.Analysis{Direction: &etfanalysis.DirectionAnalysis{Classification: etfanalysis.DirectionClassification{Focus: "科创芯片", Sector: "半导体", MatchTerms: []string{"半导体"}}}}}
	sources, err := s.supplementStockResearch(context.Background(), snapshot, stockanalysis.ResearchQuestion{Tool: "news", Query: "需求变化"})
	if err != nil || len(sources) != 0 {
		t.Fatal("future news entered frozen research", sources, err)
	}
	snapshot.CutoffAt = cutoff.Add(2 * time.Hour)
	sources, err = s.supplementStockResearch(context.Background(), snapshot, stockanalysis.ResearchQuestion{Tool: "news", Query: "需求变化"})
	if err != nil || len(sources) != 1 || sources[0].Kind != "news" {
		t.Fatal(sources, err)
	}
}
