package sina

import (
	"context"
	"easy-stock/backend/internal/foundation"
	"os"
	"strings"
	"testing"
	"time"
)

func TestETFExecutionSourceFieldsAndMissingIOPV(t *testing.T) {
	n, _ := foundation.NormalizeSymbol("510300.SH")
	f := make([]string, 34)
	for i := range f {
		f[i] = "0"
	}
	f[0] = "样本ETF"
	f[3] = "1.237"
	f[10] = "1000"
	f[11] = "1.236"
	f[20] = "2000"
	f[21] = "1.237"
	f[30] = "2026-10-09"
	f[31] = "10:01:00"
	f[32] = "00"
	body := `var hq_str_sh510300="` + strings.Join(f, ",") + `";var hq_str_sh510300_iopv="2026-10-09,10:00:59,1.2369";`
	e, err := parseETFExecution(body, n, foundation.SourceMeta{})
	if err != nil || *e.Bid != 1.236 || *e.IOPV != 1.2369 || e.QuoteStatus != "normal_quote" || e.QuoteAt.Sub(e.IOPVAt) != time.Second {
		t.Fatal(e, err)
	}
	e, err = parseETFExecution(strings.Replace(body, ",1.2369", ",0.0000", 1), n, foundation.SourceMeta{})
	if err != nil || e.IOPV != nil {
		t.Fatal("zero IOPV is missing", e, err)
	}
}
func TestETFLiveExecution(t *testing.T) {
	if os.Getenv("EASY_STOCK_LIVE_ETF") != "1" {
		t.Skip("opt-in")
	}
	c := NewClient()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for _, symbol := range []string{"510300.SH", "159915.SZ", "513100.SH", "518880.SH", "511010.SH", "511990.SH"} {
		e, err := c.ETFExecution(ctx, symbol)
		if err != nil || e.Price == nil {
			t.Fatal(symbol, err)
		}
		t.Log(symbol, e.QuoteAt, e.IOPVAt, e.IOPV != nil)
	}
}
