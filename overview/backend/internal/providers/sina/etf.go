package sina

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"easy-stock/backend/internal/foundation"
)

func (c *Client) ETFExecution(ctx context.Context, symbol string) (foundation.ETFExecution, error) {
	n, err := foundation.NormalizeSymbol(symbol)
	if err != nil {
		return foundation.ETFExecution{}, err
	}
	address := c.requestURL(url.Values{"list": {n.Sina + "," + n.Sina + "_iopv"}, "rn": {strconv.FormatInt(time.Now().UnixMilli(), 10)}})
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return foundation.ETFExecution{}, err
	}
	req.Header.Set("Referer", "https://finance.sina.com.cn/")
	req.Header.Set("User-Agent", "Mozilla/5.0 easy-stock")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return foundation.ETFExecution{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return foundation.ETFExecution{}, fmt.Errorf("ETF execution HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return foundation.ETFExecution{}, err
	}
	return parseETFExecution(decodeSinaBody(body, resp.Header.Get("Content-Type")), n, foundation.SourceMeta{Source: "sina:etf-book-iopv", SourceURL: address, FetchedAt: time.Now().UTC()})
}
func parseETFExecution(body string, n foundation.Symbol, meta foundation.SourceMeta) (foundation.ETFExecution, error) {
	e := foundation.ETFExecution{Symbol: n.Canonical, QuoteStatus: "unknown", Meta: meta}
	positive := func(s string) *float64 {
		v, err := strconv.ParseFloat(s, 64)
		if err != nil || v <= 0 || math.IsNaN(v) || math.IsInf(v, 0) {
			return nil
		}
		return &v
	}
	stamp := func(date, clock string) time.Time {
		v, _ := time.ParseInLocation("2006-01-02 15:04:05", date+" "+clock, time.FixedZone("CST", 8*3600))
		return v
	}
	for _, line := range strings.Split(body, ";") {
		left, payload, ok := strings.Cut(strings.TrimSpace(line), "\"")
		if !ok {
			continue
		}
		payload, _, _ = strings.Cut(payload, "\"")
		key := strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(left), "var hq_str_"), "=")
		f := strings.Split(payload, ",")
		if key == n.Sina && len(f) >= 33 && f[0] != "" {
			e.Price = positive(f[3])
			e.Bid = positive(f[11])
			e.Ask = positive(f[21])
			e.BidUnits = positive(f[10])
			e.AskUnits = positive(f[20])
			e.QuoteAt = stamp(f[30], f[31])
			e.RawStatus = f[32]
			if f[32] == "00" {
				e.QuoteStatus = "normal_quote"
			}
		}
		if key == n.Sina+"_iopv" && len(f) == 3 {
			e.IOPV = positive(f[2])
			e.IOPVAt = stamp(f[0], f[1])
		}
	}
	if e.Price == nil || e.QuoteAt.IsZero() {
		return e, fmt.Errorf("ETF quote unavailable")
	}
	return e, nil
}
