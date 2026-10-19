package stockanalysis

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"easy-stock/backend/internal/etfanalysis"
	"easy-stock/backend/internal/foundation"
)

func etfResearchFixture(t *testing.T) (Analysis, ResearchSnapshot, ResearchCoreSynthesis, ResearchTradeConditions) {
	t.Helper()
	a, s := researchFixture(t)
	a.InstrumentType = "etf"
	a.Symbol = "510300.SH"
	a.Name = "样本ETF"
	data := etfanalysis.Build(foundation.ETFProfile{Instrument: foundation.Instrument{Symbol: a.Symbol, Name: a.Name, InstrumentType: "etf"}, AssetClass: "equity", PricePrecision: 3}, foundation.ETFNetValues{}, nil, s.CutoffAt)
	a.ETF = &data
	s.ETF = &data
	s.InstrumentType = "etf"
	s.Symbol = a.Symbol
	s.Name = a.Name
	s.Sources = []ResearchSource{{ID: "e-profile", Kind: "fund_profile", Content: "基金档案", CapturedAt: s.CutoffAt}, {ID: "m-price", Kind: "calculation", Content: "真实未复权价格", CapturedAt: s.CutoffAt}, {ID: "e-quality", Kind: "calculation", Content: "缺少IOPV", CapturedAt: s.CutoffAt}}
	s.Anchors = []PriceAnchor{{ID: "etf-close", Price: 1.237, Label: "完整日收盘", SourceID: "m-price"}}
	s.Limitations = data.Limitations
	core := ResearchCoreSynthesis{Headline: "方向与执行条件分开判断", Thesis: ResearchClaim{Text: "档案确认投资对象，执行条件待核实", Kind: "inference", SourceIDs: []string{"e-profile"}}, EvidenceLevel: "limited", MainConflict: "缺少实时估值", ETFJudgments: &etfanalysis.Judgments{
		Underlying: etfanalysis.Judgment{Status: "mixed", Text: "跟踪方向已知，缺少当前基本面证据", EvidenceLevel: "limited", SourceIDs: []string{"e-profile"}},
		Product:    etfanalysis.Judgment{Status: "limited", Text: "档案可核实，跟踪质量缺失", EvidenceLevel: "limited", SourceIDs: []string{"e-profile"}},
		Entry:      etfanalysis.Judgment{Status: "conditional", Text: "需要核实执行条件", EvidenceLevel: "limited", SourceIDs: []string{"e-quality"}},
	}}
	trade := ResearchTradeConditions{Conditions: []ResearchCondition{{ID: "c1", Text: "收盘观察", Metric: "close", Operator: "lte", Window: "next_close", AnchorID: "etf-close", SourceIDs: []string{"m-price"}}}, InvalidationIDs: []string{"c1"}, Decision: ResearchDecision{Status: "conditional", NewPosition: "等待核实", ExistingPosition: "复核持有逻辑", Reason: "资料有限"}}
	return a, s, core, trade
}
func etfJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func TestETFResearchLevelsAndCleanSerialization(t *testing.T) {
	for _, level := range []ResearchLevel{ResearchLevelQuick, ResearchLevelStandard, ResearchLevelDeep} {
		t.Run(string(level), func(t *testing.T) {
			a, s, core, trade := etfResearchFixture(t)
			p := &researchTestPrompter{respond: func(_ int, prompt string) (string, error) {
				if strings.Contains(prompt, `"rule_baseline"`) {
					t.Fatal("stock score leaked into ETF prompt")
				}
				if strings.Contains(prompt, "最多提出3个") {
					return `{"questions":[]}`, nil
				}
				if strings.Contains(prompt, "基于已形成判断") {
					return etfJSON(trade), nil
				}
				return etfJSON(core), nil
			}}
			request := ResearchRequest{Symbol: a.Symbol, InstrumentType: "etf", Purpose: "observe", Horizon: "swing", AnalysisLevel: level}
			if err := RunETFResearch(context.Background(), p, &s, &a, request, "fixture", nil, nil); err != nil {
				t.Fatal(err)
			}
			want := map[ResearchLevel]int{ResearchLevelQuick: 1, ResearchLevelStandard: 2, ResearchLevelDeep: 3}[level]
			if p.calls != want {
				t.Fatalf("calls %d want %d", p.calls, want)
			}
			for _, o := range p.options {
				if !o.DisableTools {
					t.Fatal("ETF model can invoke unbound tools")
				}
			}
			r := a.ResearchReport
			if r == nil || r.ETFJudgments == nil || r.Decision.Status != "no_plan" || r.Decision.PricePlan != nil || r.ETFJudgments.Entry.Status == "conditional" {
				t.Fatalf("unsafe report %+v", r)
			}
			if level != ResearchLevelQuick && (*r.Conditions[0].Threshold != 1.237 || !strings.Contains(r.Conditions[0].Text, "1.237")) {
				t.Fatal("ETF price was rounded")
			}
			for _, v := range []any{a, s, ResearchJob{Request: request, Analysis: &a}.Summary()} {
				b := etfJSON(v)
				for _, field := range []string{`"scorecard"`, `"rule_baseline"`, `"score"`, `"short_term"`, `"action_plan"`} {
					if strings.Contains(b, field) {
						t.Fatalf("stock field %s leaked", field)
					}
				}
			}
			var restored Analysis
			if err := json.Unmarshal([]byte(etfJSON(a)), &restored); err != nil || restored.ETF == nil || restored.ResearchReport.ETFJudgments == nil {
				t.Fatal("ETF report failed roundtrip", err)
			}
		})
	}
}

func TestETFResearchOneRepairBudgetAndCheckpointResume(t *testing.T) {
	a, s, core, trade := etfResearchFixture(t)
	request := ResearchRequest{Symbol: a.Symbol, InstrumentType: "etf", Purpose: "observe", Horizon: "swing", AnalysisLevel: ResearchLevelStandard}
	p := &researchTestPrompter{respond: func(n int, _ string) (string, error) {
		if n == 1 || n == 3 {
			return `{}`, nil
		}
		return etfJSON(core), nil
	}}
	if err := RunETFResearch(context.Background(), p, &s, &a, request, "fixture", nil, nil); err == nil || p.calls != 3 {
		t.Fatalf("shared repair budget: calls=%d err=%v", p.calls, err)
	}
	a, s, _, _ = etfResearchFixture(t)
	execution := &researchExecution{identity: "fixture"}
	ctx := context.WithValue(context.Background(), researchExecutionKey{}, execution)
	p = &researchTestPrompter{respond: func(n int, _ string) (string, error) {
		if n == 2 {
			return "", errors.New("temporary interruption")
		}
		return etfJSON(core), nil
	}}
	if err := RunETFResearch(ctx, p, &s, &a, request, "fixture", nil, nil); err == nil || a.ResearchReport != nil || !execution.checkpoint.resumable() {
		t.Fatalf("lost incomplete stage: %v", err)
	}
	var cp ResearchCheckpoint
	if err := json.Unmarshal([]byte(etfJSON(execution.checkpoint)), &cp); err != nil {
		t.Fatal(err)
	}
	execution.checkpoint = &cp
	p = &researchTestPrompter{respond: func(_ int, prompt string) (string, error) {
		if !strings.Contains(prompt, "基于已形成判断") {
			t.Fatal("successful core repeated")
		}
		return etfJSON(trade), nil
	}}
	if err := RunETFResearch(ctx, p, &s, &a, request, "fixture", nil, nil); err != nil || p.calls != 1 {
		t.Fatalf("resume: %v calls=%d", err, p.calls)
	}
}

func TestETFMoneyRejectsPriceSignalsAndUnknownCitations(t *testing.T) {
	_, s, core, trade := etfResearchFixture(t)
	s.ETF.Profile.AssetClass = "money"
	result := ResearchSynthesis{ETFJudgments: core.ETFJudgments, Conditions: trade.Conditions}
	if _, err := validateETFResearch(&result, s, ResearchRequest{}); err == nil {
		t.Fatal("money price signal accepted")
	}
	core.ETFJudgments.Product.SourceIDs = []string{"invented"}
	if err := validateETFJudgments(core.ETFJudgments, s); err == nil {
		t.Fatal("invented card citation accepted")
	}
}

func TestETFVerificationDetectsOneTickHistoryRevision(t *testing.T) {
	cutoff := time.Date(2026, 10, 8, 16, 0, 0, 0, time.FixedZone("CST", 8*3600))
	snapshot := ResearchSnapshot{InstrumentType: "etf", CutoffAt: cutoff, DailyBars: []AIDailyBar{{Date: "2026-10-08", Close: 1.237}}}
	bar := func(day int, close float64) foundation.KLine {
		return foundation.KLine{Time: time.Date(2026, 10, day, 0, 0, 0, 0, cutoff.Location()), Open: close, Close: close, High: close, Low: close}
	}
	report := ResearchReport{ResearchSynthesis: ResearchSynthesis{Conditions: []ResearchCondition{{ID: "c1", Metric: "close", Threshold: floatPtr(1.237), Operator: "gte", Window: "next_close"}}}}
	lines := []foundation.KLine{bar(8, 1.238), bar(9, 1.239)}
	result := VerifyResearch(snapshot, report, lines, cutoff.Add(24*time.Hour), lines)
	if result.Checks[0].Status != "unavailable" {
		t.Fatal("one ETF tick revision ignored")
	}
	lines[0] = bar(8, 1.237)
	result = VerifyResearch(snapshot, report, lines, cutoff.Add(24*time.Hour), lines)
	if result.Checks[0].Status != "met" || *result.Checks[0].Observed != 1.239 {
		t.Fatal("raw precise verification failed")
	}
}

func TestETFPortfolioReuseRequiresIdentityAndStockCandidatesStaySeparate(t *testing.T) {
	a, s, core, _ := etfResearchFixture(t)
	a.AI.Status = "ready"
	a.ResearchReport = &ResearchReport{ResearchSynthesis: ResearchSynthesis{ETFJudgments: core.ETFJudgments, Headline: core.Headline, Thesis: core.Thesis}, Validation: "references_checked", GeneratedAt: time.Now()}
	now := time.Now()
	job := ResearchJob{ID: "etf-reuse", Request: ResearchRequest{Symbol: a.Symbol, InstrumentType: "etf"}, Status: "succeeded", Analysis: &a, Snapshot: &s, CompletedAt: &now}
	if !SuccessfulResearch(job) || SuccessfulStockResearch(job) {
		t.Fatal("ETF/stock completion boundary failed")
	}
	store, err := OpenResearchStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err = store.Save(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	reused, err := store.FindReusable(context.Background(), a.Symbol, time.Now())
	if err != nil || reused.ID != job.ID || !SuccessfulInstrumentResearch(reused) {
		t.Fatalf("ETF report was not reusable: %v", err)
	}
	if _, err = store.db.Exec("UPDATE stock_research_reuse_index SET valid=0 WHERE id=?", job.ID); err != nil {
		t.Fatal(err)
	}
	if err = store.migrateReuseIndex(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err = store.FindReusable(context.Background(), a.Symbol, time.Now()); err != nil {
		t.Fatalf("phase-one ETF index was not migrated: %v", err)
	}
	candidates, err := store.RecentReusable(context.Background(), time.Now(), 20)
	if err != nil || len(candidates) != 0 {
		t.Fatal("ETF became portfolio candidate", err)
	}
	for _, symbol := range []string{"510300", "510300.SH", "sh510300", " SH510300 "} {
		if !foundation.IsListedFundCandidate(symbol) {
			t.Errorf("fund escaped prefix guard: %s", symbol)
		}
		var service *ResearchService
		if _, _, err = service.ResolveForPortfolio(context.Background(), ResearchRequest{Symbol: symbol}, now, false, ""); err == nil || !strings.Contains(err.Error(), "ETF身份") {
			t.Errorf("fund escaped portfolio guard %s %v", symbol, err)
		}
	}
}

func TestETFPromptPreservesLatestValuesInValidJSON(t *testing.T) {
	_, s, _, _ := etfResearchFixture(t)
	s.ETF.NetValues.Points = []foundation.ETFNAVPoint{{Date: "2026-10-01", Value: 1.231}, {Date: "2026-10-09", Value: 1.237}}
	s.ETF.Profile.InvestmentScope = strings.Repeat("投资范围", 1000)
	s.Sources = append(s.Sources, ResearchSource{ID: "e-nav"})
	for _, source := range etfPromptSources(s, ResearchLevelQuick) {
		if source.ID == "e-nav" && !strings.Contains(source.Content, "1.237") {
			t.Fatal("latest NAV missing")
		}
		if source.ID == "e-nav" || source.ID == "e-profile" || source.ID == "m-price" {
			if !json.Valid([]byte(source.Content)) {
				t.Fatal("structured evidence cut mid-JSON")
			}
		}
	}
}

func TestETFResearchSufficiencySeparateFromExecution(t *testing.T) {
	a, s, core, trade := etfResearchFixture(t)
	core.EvidenceLevel = "sufficient"
	core.ETFJudgments.Underlying.EvidenceLevel = "sufficient"
	core.ETFJudgments.Product.EvidenceLevel = "sufficient"
	core.Support = []ResearchClaim{{Text: "档案已确认研究对象", Kind: "fact", SourceIDs: []string{"e-profile"}}}
	p := &researchTestPrompter{respond: func(_ int, prompt string) (string, error) {
		if !strings.Contains(prompt, "研究充分度与交易许可分开") || !strings.Contains(prompt, "不能冒充整个指数财务") {
			t.Fatal("research scope policy missing")
		}
		if strings.Contains(prompt, "基于已形成判断") {
			return etfJSON(trade), nil
		}
		return etfJSON(core), nil
	}}
	err := RunETFResearch(context.Background(), p, &s, &a, ResearchRequest{Symbol: a.Symbol, InstrumentType: "etf", Purpose: "observe", Horizon: "swing", AnalysisLevel: ResearchLevelStandard}, "fixture", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if a.ResearchReport.EvidenceLevel != "sufficient" || a.ResearchReport.Decision.Status != "no_plan" || len(a.ResearchReport.Decision.Blockers) == 0 {
		t.Fatalf("research and execution conflated: %+v", a.ResearchReport)
	}
}

func TestETFDirectionPromptAndValidationRequireTechnicalNewsEvidence(t *testing.T) {
	a, s, core, trade := etfResearchFixture(t)
	a.ETF.Profile.TrackingTarget = "上证科创板芯片指数"
	a.ETF.Direction = &etfanalysis.DirectionAnalysis{Classification: etfanalysis.ClassifyDirection(a.ETF.Profile), Technical: &etfanalysis.DirectionTechnical{Symbol: "000685.SH", Name: "科创芯片", Relationship: "tracking_index", AsOf: "2026-10-09"}}
	for _, id := range []string{"e-direction", "e-direction-technical", "e-direction-news-coverage"} {
		s.Sources = append(s.Sources, ResearchSource{ID: id, Kind: "fund_data", Content: `{"test":true}`, CapturedAt: s.CutoffAt})
	}
	if err := validateETFJudgments(core.ETFJudgments, s); err == nil {
		t.Fatal("direction research omitted")
	}
	core.ETFJudgments.Technical = &etfanalysis.Judgment{Status: "falling", Text: "截至10月9日真实指数趋势走弱", EvidenceLevel: "sufficient", SourceIDs: []string{"e-direction-technical"}}
	core.ETFJudgments.News = &etfanalysis.Judgment{Status: "insufficient", Text: "方向消息检索未取得相关资料", EvidenceLevel: "limited", SourceIDs: []string{"e-direction-news-coverage"}}
	core.ETFJudgments.Underlying.SourceIDs = []string{"e-profile", "e-direction-technical"}
	if err := validateETFJudgments(core.ETFJudgments, s); err != nil {
		t.Fatal(err)
	}
	core.ETFJudgments.Technical.SourceIDs = []string{"e-profile"}
	if err := validateETFJudgments(core.ETFJudgments, s); err == nil {
		t.Fatal("profile alone cannot support technical claim")
	}
	core.ETFJudgments.Technical.SourceIDs = []string{"e-direction-technical"}
	p := &researchTestPrompter{respond: func(_ int, prompt string) (string, error) {
		for _, text := range []string{"投资类型 → 对应指数/板块近期技术面", "sector_reference", "etf_price_proxy", "消息缺失只限制催化解释", "e-direction-news-coverage"} {
			if !strings.Contains(prompt, text) {
				t.Fatalf("prompt lost %s", text)
			}
		}
		if strings.Contains(prompt, "基于已形成判断") {
			return etfJSON(trade), nil
		}
		return etfJSON(core), nil
	}}
	request := ResearchRequest{InstrumentType: "etf", Symbol: a.Symbol, AnalysisLevel: ResearchLevelStandard, Purpose: "observe", Horizon: "swing"}
	if err := RunETFResearch(context.Background(), p, &s, &a, request, "fixture", nil, nil); err != nil {
		t.Fatal(err)
	}
	if a.ResearchReport.ETFJudgments.Technical == nil || a.ResearchReport.ETFJudgments.News == nil || a.ResearchReport.PromptVersion != "etf-research-v4" {
		t.Fatal(a.ResearchReport)
	}
}

func TestETFDirectionMoneyUsesIncomeInsteadOfPriceTrend(t *testing.T) {
	_, s, core, _ := etfResearchFixture(t)
	s.ETF.Profile.AssetClass = "money"
	s.ETF.Direction = &etfanalysis.DirectionAnalysis{Classification: etfanalysis.ClassifyDirection(s.ETF.Profile)}
	for _, id := range []string{"e-nav", "e-direction-news-coverage"} {
		s.Sources = append(s.Sources, ResearchSource{ID: id, Kind: "fund_data"})
	}
	core.ETFJudgments.Technical = &etfanalysis.Judgment{Status: "not_applicable", Text: "货币ETF侧重收益与资金面", EvidenceLevel: "limited", SourceIDs: []string{"e-nav"}}
	core.ETFJudgments.News = &etfanalysis.Judgment{Status: "insufficient", Text: "未取得资金面消息", EvidenceLevel: "limited", SourceIDs: []string{"e-direction-news-coverage"}}
	if err := validateETFJudgments(core.ETFJudgments, s); err != nil {
		t.Fatal(err)
	}
	core.ETFJudgments.News.Status = "supported"
	if err := validateETFJudgments(core.ETFJudgments, s); err == nil {
		t.Fatal("coverage metadata fabricated positive news")
	}
}
