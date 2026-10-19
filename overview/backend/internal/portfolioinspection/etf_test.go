package portfolioinspection

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"easy-stock/backend/internal/etfanalysis"
	"easy-stock/backend/internal/foundation"
	"easy-stock/backend/internal/stockanalysis"
)

func TestETFMixedPortfolioDoesNotAverageMissingStockScores(t *testing.T) {
	request := Request{TraderProfile: ProfileBalanced, Holdings: []Holding{{Symbol: "600519.SH", Weight: 30}, {Symbol: "510300.SH", Weight: 30}}}
	stock := successfulHolding(request.Holdings[0], "股票", 80, 40, "消费", 5, 100)
	at := time.Now()
	data := etfanalysis.Build(foundation.ETFProfile{Instrument: foundation.Instrument{Symbol: "510300.SH"}, AssetClass: "equity", TrackingTarget: "沪深300指数"}, foundation.ETFNetValues{}, nil, at)
	data.Holdings = []foundation.ETFHoldings{{Symbol: "510300.SH", AssetType: "equity", ReportDate: "2026-06-30", DisclosedWeightPercent: 10, Items: []foundation.ETFHolding{{Code: "600519", Symbol: "600519.SH", Name: "股票", WeightPercent: 10}}}}
	fund := HoldingResult{Holding: request.Holdings[1], Status: "succeeded", AnalysisID: "etf-report", Analysis: &stockanalysis.Analysis{InstrumentType: "etf", Symbol: "510300.SH", ETF: &data, AI: stockanalysis.AISynthesisStatus{Status: "ready"}, ResearchReport: &stockanalysis.ResearchReport{Validation: "references_checked", ResearchSynthesis: stockanalysis.ResearchSynthesis{ETFJudgments: &etfanalysis.Judgments{}}}}}
	stock.Analysis.AI.Status = "ready"
	results := []HoldingResult{stock, fund}
	rules, _ := RulesFor(ProfileBalanced)
	metrics := CalculateMetrics(request, results, rules)
	if metrics.WeightedScore != 80 || metrics.WeightedRisk != 40 || metrics.StockScoreCoveragePercent != 50 || metrics.CoveragePercent != 100 || metrics.HealthScoreAvailable {
		t.Fatalf("ETF was treated as a zero-score stock: %+v", metrics)
	}
	facts := portfolioFacts(request, results, metrics)
	if f := facts["disclosed_overlap.600519.SH"]; !f.Available || f.Value.(float64) != 55 {
		t.Fatal(f)
	}
	if f := facts["510300.SH.etf.asset_class"]; !f.Available || f.Value != "equity" {
		t.Fatal(f)
	}
	if len(InvestmentFinancialFacts(fund)) != 0 || len(InvestmentValuationFacts(fund)) != 0 {
		t.Fatal("ETF acquired company financial facts")
	}
	prompt, err := buildScoringPrompt(request, results, metrics, rules)
	if err != nil || !strings.Contains(prompt, "ETF不套用公司ROE") || !strings.Contains(prompt, "disclosed_overlap") {
		t.Fatal(err, prompt)
	}
}
func TestETFCorrelationUsesRawHistoryAndMoneyRemainsUnknown(t *testing.T) {
	a := stockanalysis.Analysis{InstrumentType: "etf", ETF: &etfanalysis.Analysis{Profile: foundation.ETFProfile{AssetClass: "equity"}}}
	b := stockanalysis.Analysis{}
	for i := 0; i < 25; i++ {
		at := time.Date(2026, 8, i+1, 0, 0, 0, 0, time.UTC)
		price := 1 + float64(i%7)/100 + float64(i)/50
		a.ETF.Bars = append(a.ETF.Bars, foundation.KLine{Time: at, Close: price})
		b.Chart = append(b.Chart, stockanalysis.TrendPoint{Date: at.Format("2006-01-02"), Close: price * 3})
	}
	if c, ok := chartCorrelation(&a, &b); !ok || c < .99 {
		t.Fatal(c, ok)
	}
	if etfVolatility(&a) <= 0 {
		t.Fatal("ETF risk omitted available history")
	}
	a.ETF.Profile.AssetClass = "money"
	if _, ok := chartCorrelation(&a, &b); ok {
		t.Fatal("money ETF got price correlation")
	}
}
func TestETFSourceFactsRetainReportDates(t *testing.T) {
	_, results, metrics, _ := scoreFixture()
	data := etfanalysis.Analysis{Profile: foundation.ETFProfile{AssetClass: "bond"}, ExecutionBlockers: []string{"需核验交易规则"}}
	results[0].Analysis.InstrumentType = "etf"
	results[0].Analysis.ETF = &data
	facts := etfPortfolioFacts(results, metrics)
	encoded, _ := json.Marshal(facts)
	if !strings.Contains(string(encoded), "需核验交易规则") {
		t.Fatal(string(encoded))
	}
}
