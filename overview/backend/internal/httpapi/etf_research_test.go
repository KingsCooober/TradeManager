package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"easy-stock/backend/internal/agent"
	"easy-stock/backend/internal/etfanalysis"
	"easy-stock/backend/internal/foundation"
	"easy-stock/backend/internal/portfolioinspection"
	"easy-stock/backend/internal/providers/eastmoney"
	"easy-stock/backend/internal/providers/sina"
	"easy-stock/backend/internal/stockanalysis"
)

type etfDataFixture struct{ failNAV bool }

func (etfDataFixture) ETFDirectory(context.Context) ([]foundation.Instrument, error) {
	return []foundation.Instrument{{Symbol: "510300.SH", Code: "510300", Name: "样本ETF", InstrumentType: "etf"}}, nil
}
func (etfDataFixture) ETFProfile(_ context.Context, symbol string) (foundation.ETFProfile, error) {
	if symbol != "510300.SH" {
		return foundation.ETFProfile{}, errors.New("非ETF或基金档案不可用")
	}
	return foundation.ETFProfile{Instrument: foundation.Instrument{Symbol: symbol, Code: "510300", Name: "样本ETF", InstrumentType: "etf"}, AssetClass: "equity", TrackingTarget: "样本指数", PricePrecision: 3, Meta: foundation.SourceMeta{Source: "fixture", FetchedAt: time.Now()}}, nil
}
func (p etfDataFixture) ETFNetValues(_ context.Context, symbol string) (foundation.ETFNetValues, error) {
	if p.failNAV {
		return foundation.ETFNetValues{}, errors.New("unavailable")
	}
	return foundation.ETFNetValues{Symbol: symbol, Points: []foundation.ETFNAVPoint{{Date: "2026-01-02", Value: 1.2345}}, Meta: foundation.SourceMeta{Source: "fixture", FetchedAt: time.Now()}}, nil
}

type etfRawFixture struct{ fail bool }

func (p etfRawFixture) RawKLine(_ context.Context, symbol, period string, limit int) ([]foundation.KLine, error) {
	if p.fail {
		return nil, errors.New("primary unavailable")
	}
	now := time.Now().AddDate(0, 0, -1)
	return []foundation.KLine{{Symbol: symbol, Time: now, Open: 1.231, Close: 1.237, High: 1.239, Low: 1.230, Volume: 1000, Meta: foundation.SourceMeta{Source: "eastmoney"}}}, nil
}

func TestETFGenericAPICreationPersistenceAndStockIsolation(t *testing.T) {
	server := NewServer(Config{ETF: etfDataFixture{}, ETFKLinePrimary: etfRawFixture{fail: true}, ETFKLineFallback: etfRawFixture{}, Realtime: stockAnalysisRealtime{}, KLinePrimary: stockAnalysisKLines{}, KLineFallback: stockAnalysisKLines{}, ReviewDBPath: ":memory:"})
	defer server.Close()
	call := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		w := httptest.NewRecorder()
		server.ServeHTTP(w, r)
		return w
	}
	for _, bad := range []struct{ path, body string }{{"/api/v1/stocks/research", `{"symbol":"510300"}`}, {"/api/v1/instruments/research", `{"symbol":"160000"}`}, {"/api/v1/instruments/research", `{"symbol":"600519","instrument_type":"etf"}`}} {
		if w := call("POST", bad.path, bad.body); w.Code != 400 {
			t.Fatalf("invalid request accepted %d %s", w.Code, w.Body.String())
		}
	}
	w := call("POST", "/api/v1/instruments/research", `{"symbol":"510300","analysis_level":"quantitative"}`)
	if w.Code != 202 {
		t.Fatalf("create %d %s", w.Code, w.Body.String())
	}
	var response struct {
		Data stockanalysis.ResearchJob `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	job, err := server.stockResearch.Wait(ctx, response.Data.ID)
	if err != nil || job.Status != "succeeded" || job.Analysis == nil || job.Analysis.ETF == nil || job.Request.InstrumentType != "etf" {
		t.Fatalf("job %+v %v", job, err)
	}
	if job.Analysis.Scorecard.Overall != 0 || job.Snapshot.DailyBars[0].Close != 1.237 {
		t.Fatal("ETF inherited stock score or lost price precision")
	}
	restored, err := server.stockResearchStore.Get(ctx, job.ID)
	if err != nil || restored.Snapshot.ETF == nil || restored.Analysis.ETF.Profile.Name != "样本ETF" {
		t.Fatal("ETF persistence lost", err)
	}
	for _, path := range []string{"/api/v1/instruments/research", "/api/v1/instruments/research/" + job.ID, "/api/v1/instruments/research/" + job.ID + "/snapshot"} {
		w = call("GET", path, "")
		if w.Code != 200 {
			t.Fatalf("read %s", w.Body.String())
		}
		for _, field := range []string{`"scorecard"`, `"rule_baseline"`, `"score"`, `"action_plan"`} {
			if strings.Contains(w.Body.String(), field) {
				t.Fatalf("stock field leaked: %s", field)
			}
		}
	}
	if w = call("GET", "/api/v1/stocks/research/"+job.ID, ""); w.Code != 404 {
		t.Fatal("stock API read ETF")
	}
	if w = call("GET", "/api/v1/stocks/research", ""); strings.Contains(w.Body.String(), job.ID) {
		t.Fatal("stock-only history includes ETF")
	}
	text, err := server.stockResearchChatContext(ctx, job.ID)
	if err != nil || !strings.Contains(text, `"etf"`) || strings.Contains(text, `"rule_baseline"`) {
		t.Fatal("ETF chat context incorrect", err)
	}
	w = call("DELETE", "/api/v1/instruments/research/"+job.ID, "")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
}

func TestETFMissingSourcesRemainExplicit(t *testing.T) {
	s := &Server{etfProvider: etfDataFixture{failNAV: true}, etfKLinePrimary: etfRawFixture{fail: true}, etfKLineFallback: etfRawFixture{fail: true}, realtimeProvider: stockAnalysisRealtime{}}
	a, snapshot, err := s.collectETFResearch(context.Background(), stockanalysis.ResearchRequest{Symbol: "510300.SH", InstrumentType: "etf", AnalysisLevel: stockanalysis.ResearchLevelQuick})
	if err != nil || a.ETF == nil || len(snapshot.DailyBars) != 0 || a.Quote.Price != 0 || !strings.Contains(strings.Join(a.ETF.Limitations, " "), "净值或收益资料暂不可用") {
		t.Fatalf("missing data fabricated %+v %v", a, err)
	}
	for _, m := range a.ETF.Metrics {
		if m.Value != nil {
			t.Fatal("metric fabricated without bars")
		}
	}
}

func TestETFLiveRawPriceCoverage(t *testing.T) {
	if os.Getenv("EASY_STOCK_LIVE_ETF") != "1" {
		t.Skip("opt-in live public-source verification")
	}
	s := &Server{etfKLinePrimary: eastmoney.NewClient(), etfKLineFallback: sina.NewClient()}
	for _, symbol := range []string{"510300.SH", "159915.SZ", "511010.SH", "518880.SH", "513100.SH", "511990.SH"} {
		t.Run(symbol, func(t *testing.T) {
			t.Parallel()
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			bars, err := s.loadETFKLine(ctx, symbol, 60)
			if err != nil || len(bars) == 0 {
				t.Fatalf("%s: %v", symbol, err)
			}
			last := bars[len(bars)-1]
			t.Logf("%s %s bars=%d close=%.3f volume=%.0f amount=%.2f", symbol, last.Meta.Source, len(bars), last.Close, last.Volume, last.Amount)
		})
	}
}

type etfStockDirectoryFixture struct{}

func (etfStockDirectoryFixture) StockCatalog(context.Context) ([]foundation.StockCatalogEntry, error) {
	return []foundation.StockCatalogEntry{{BoardStock: foundation.BoardStock{Symbol: "600519.SH", Name: "测试股票"}}}, nil
}

func TestETFDirectoryAndAIReportThroughGenericAPI(t *testing.T) {
	gateway := &fakeAgentGateway{status: agent.Status{Available: true, Configured: true}, promptFunc: func(_ context.Context, prompt string) (agent.PromptResult, error) {
		content := `{"headline":"ETF研究完成","thesis":{"text":"基金资料可核实，执行条件不足","kind":"inference","source_ids":["e-profile"]},"evidence_level":"limited","etf_judgments":{"technical":{"status":"insufficient","text":"仅ETF价格代理且日线不足","evidence_level":"limited","source_ids":["e-direction-technical"]},"news":{"status":"insufficient","text":"方向消息未取得","evidence_level":"limited","source_ids":["e-direction-news-coverage"]},"underlying":{"status":"mixed","text":"ETF价格代理尚不足以确定底层趋势","evidence_level":"limited","source_ids":["e-profile","e-direction-technical"]},"product":{"status":"limited","text":"缺少跟踪质量","evidence_level":"limited","source_ids":["e-profile"]},"entry":{"status":"unknown","text":"IOPV未取得","evidence_level":"insufficient","source_ids":["e-quality"]}}}`
		if strings.Contains(prompt, "基于已形成判断") {
			content = `{"conditions":[],"invalidation_ids":[],"scenarios":[],"decision":{"status":"no_plan","new_position":"等待资料","existing_position":"复核风险","reason":"执行数据不足"}}`
		}
		return agent.PromptResult{Content: content}, nil
	}}
	server := NewServer(Config{ETF: etfEvidenceFixture{}, ETFKLinePrimary: etfRawFixture{}, ETFKLineFallback: etfRawFixture{}, StockDirectory: etfStockDirectoryFixture{}, Realtime: stockAnalysisRealtime{}, AgentGateway: gateway, ReviewDBPath: ":memory:"})
	defer server.Close()
	w := httptest.NewRecorder()
	server.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/instruments", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"instrument_type":"etf"`) || !strings.Contains(w.Body.String(), `"instrument_type":"stock"`) {
		t.Fatalf("directory %s", w.Body.String())
	}
	w = httptest.NewRecorder()
	server.ServeHTTP(w, httptest.NewRequest("POST", "/api/v1/instruments/research", strings.NewReader(`{"symbol":"510300","purpose":"holding","cost_price":1.237}`)))
	var response struct {
		Data stockanalysis.ResearchJob `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || w.Code != 202 {
		t.Fatalf("create %s %v", w.Body.String(), err)
	}
	if response.Data.Request.AnalysisLevel != stockanalysis.ResearchLevelStandard {
		t.Fatal("ETF default level is not standard")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	job, err := server.stockResearch.Wait(ctx, response.Data.ID)
	if err != nil || job.Analysis == nil || job.Analysis.ResearchReport == nil || job.Status != "succeeded" {
		t.Fatalf("AI flow %+v %v", job, err)
	}
	if job.Analysis.ResearchReport.ETFJudgments == nil || *job.Analysis.ResearchReport.Request.CostPrice != 1.237 {
		t.Fatal("ETF cards or cost lost")
	}
	if len(job.Analysis.ETF.Holdings) != 1 || len(job.Analysis.ETF.Announcements) != 1 {
		t.Fatal("fund evidence not persisted in AI report")
	}
	result, originErr := server.resolvePortfolioResearch(ctx, portfolioinspection.Holding{Symbol: "510300.SH", Weight: 30}, portfolioinspection.Request{Horizon: "swing", ResearchLevel: stockanalysis.ResearchLevelStandard}, time.Now(), false, "", nil)
	if originErr != nil || result.ResearchOrigin != "reused" || result.AnalysisID != job.ID || result.Analysis.ETF == nil {
		t.Fatalf("portfolio failed to reuse typed ETF: %+v %v", result, originErr)
	}
	if !strings.Contains(stockanalysis.NotificationMarkdown(job), "底层资产") {
		t.Fatal("ETF notification lost cards")
	}
}

type etfEvidenceFixture struct{ etfDataFixture }

func (etfEvidenceFixture) ETFHoldings(_ context.Context, symbol, asset string) (foundation.ETFHoldings, error) {
	return foundation.ETFHoldings{Symbol: symbol, AssetType: asset, ReportDate: "2026-06-30", Items: []foundation.ETFHolding{{Code: "600519", Symbol: "600519.SH", Name: "样本持仓", WeightPercent: 3.5}}, DisclosedWeightPercent: 3.5}, nil
}
func (etfEvidenceFixture) ETFDisclosures(_ context.Context, symbol string) ([]foundation.ETFAnnouncement, error) {
	return []foundation.ETFAnnouncement{{ID: "AN123", Symbol: symbol, Title: "申赎业务公告", PublishedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), URL: "https://fund.eastmoney.com/gonggao/510300,AN123.html", ContentStatus: "title_only"}}, nil
}
func (etfEvidenceFixture) ETFAnnouncementBody(_ context.Context, n foundation.ETFAnnouncement) (foundation.ETFAnnouncement, error) {
	n.Content = "基金申赎业务具体安排正文"
	n.ContentStatus = "fulltext"
	return n, nil
}
func TestETFDisclosureSupplementRetainsNewBodyEvidence(t *testing.T) {
	s := &Server{etfProvider: etfEvidenceFixture{}}
	notices, _ := s.etfProvider.(ETFEvidenceProvider).ETFDisclosures(context.Background(), "510300.SH")
	snapshot := stockanalysis.ResearchSnapshot{InstrumentType: "etf", Symbol: "510300.SH", CutoffAt: time.Now(), ETF: &etfanalysis.Analysis{Announcements: notices}, Sources: []stockanalysis.ResearchSource{etfAnnouncementSource(notices[0])}}
	sources, err := s.supplementStockResearch(context.Background(), snapshot, stockanalysis.ResearchQuestion{Tool: "announcements", Query: "申赎"})
	if err != nil || len(sources) != 1 || sources[0].ContentStatus != "fulltext" || sources[0].ID == snapshot.Sources[0].ID {
		t.Fatal(sources, err)
	}
	if n := stockanalysis.AppendResearchSources(&snapshot, sources); n != 1 {
		t.Fatal("new body was dropped as duplicate")
	}
	snapshot.CutoffAt = notices[0].PublishedAt.Add(-time.Hour)
	if sources, err = s.supplementStockResearch(context.Background(), snapshot, stockanalysis.ResearchQuestion{Tool: "announcements", Query: "申赎"}); err != nil || len(sources) != 0 {
		t.Fatal("future disclosure leaked", sources, err)
	}
}
