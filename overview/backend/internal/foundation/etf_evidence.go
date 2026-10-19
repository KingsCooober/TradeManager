package foundation

import "time"

// Holdings are dated disclosures, never the live basket or a full index replica.
type ETFHolding struct {
	Code          string  `json:"code"`
	Symbol        string  `json:"symbol,omitempty"`
	Name          string  `json:"name"`
	WeightPercent float64 `json:"weight_percent"`
}
type ETFHoldings struct {
	Symbol                 string       `json:"symbol"`
	AssetType              string       `json:"asset_type"`
	ReportDate             string       `json:"report_date"`
	Scope                  string       `json:"scope"`
	Items                  []ETFHolding `json:"items"`
	DisclosedWeightPercent float64      `json:"disclosed_weight_percent"`
	Meta                   SourceMeta   `json:"meta"`
}
type ETFAnnouncement struct {
	ID            string     `json:"id"`
	Symbol        string     `json:"symbol"`
	Title         string     `json:"title"`
	PublishedAt   time.Time  `json:"published_at"`
	URL           string     `json:"url"`
	Content       string     `json:"content,omitempty"`
	ContentStatus string     `json:"content_status"`
	Meta          SourceMeta `json:"meta"`
}

// Source flags describe the quote feed, not exchange permission or creation/redemption.
type ETFExecution struct {
	Symbol      string     `json:"symbol"`
	Price       *float64   `json:"price"`
	Bid         *float64   `json:"bid"`
	Ask         *float64   `json:"ask"`
	BidUnits    *float64   `json:"bid_units"`
	AskUnits    *float64   `json:"ask_units"`
	QuoteAt     time.Time  `json:"quote_at"`
	IOPV        *float64   `json:"iopv"`
	IOPVAt      time.Time  `json:"iopv_at"`
	QuoteStatus string     `json:"quote_status"`
	RawStatus   string     `json:"raw_status"`
	Meta        SourceMeta `json:"meta"`
}

// Value is new units per old unit for splits, or cash per unit for dividends.
type ETFAction struct {
	// PriceEffectiveDate is a calculation confirmed against adjacent raw prices, not the disclosure date.
	PriceEffectiveDate string  `json:"price_effective_date,omitempty"`
	Kind               string  `json:"kind"`
	Date               string  `json:"date"`
	Value              float64 `json:"value"`
}
type ETFActions struct {
	Symbol string      `json:"symbol"`
	Items  []ETFAction `json:"items"`
	Meta   SourceMeta  `json:"meta"`
}
