package etfanalysis

import "easy-stock/backend/internal/foundation"

// A disclosed holding sample is not the ETF's own financial statement, an
// index aggregate or proof that the holding is still owned at the cutoff.
type UnderlyingEvidence struct {
	Holding           foundation.ETFHolding               `json:"holding"`
	HoldingReportDate string                              `json:"holding_report_date"`
	Financials        []foundation.StockFinancialEvidence `json:"financials"`
	Valuation         *foundation.StockValuation          `json:"valuation,omitempty"`
}
