package fund

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestETFHoldingsDatesCoverageAndIdentity(t *testing.T) {
	section := func(date, weight string) string {
		return `<div class='boxitem w790'><h4><a href='https://fund.eastmoney.com/510300.html'>样本ETF</a>截止至：` + date + `</h4><table><tr><th>股票代码</th><th>股票名称</th><th>占净值<br/>比例</th></tr><tr><td><a href='//quote.eastmoney.com/unify/r/0.300750'>300750</a></td><td>样本持仓</td><td>` + weight + `</td></tr></table></div>`
	}
	html := section("2026-03-31", "6.5%") + section("2026-06-30", "7.25%")
	encoded, _ := json.Marshal(html)
	body := "var apidata={ content:" + string(encoded) + ",arryear:[2026]};throw Error('do not execute')"
	h, err := parseHoldings(body, "510300.SH", "equity")
	if err != nil || h.ReportDate != "2026-06-30" || h.DisclosedWeightPercent != 7.25 || len(h.Items) != 1 || h.Items[0].Symbol != "300750.SZ" {
		t.Fatalf("%+v %v", h, err)
	}
	if _, err = parseHoldings(body, "510500.SH", "equity"); err == nil {
		t.Fatal("wrong identity accepted")
	}
	if _, err = parseHoldings(strings.Replace(body, "7.25%", "--", 1), "510300.SH", "equity"); err != nil {
		t.Fatal(err)
	}
}
func TestETFNoticesPartialBodyFailureAndIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/f10/JJGG":
			fmt.Fprint(w, `{"Data":[{"FUNDCODE":"510300","ID":"AN20260101001","TITLE":"产品公告","PUBLISHDATE":"2026-01-01T00:00:00"},{"FUNDCODE":"510300","ID":"AN20260101002","TITLE":"正文不可用","PUBLISHDATE":"2026-01-01T00:00:00"},{"FUNDCODE":"510500","ID":"AN20260101003","TITLE":"错误基金","PUBLISHDATE":"2026-01-01T00:00:00"}]}`)
		case "/api/content/ann":
			if r.URL.Query().Get("show_all") != "1" || r.URL.Query().Get("client_source") != "web_fund" {
				t.Error("missing required public API parameters")
			}
			if r.URL.Query().Get("art_code") == "AN20260101001" {
				fmt.Fprint(w, `{"success":1,"data":{"art_code":"AN20260101001","notice_content":"基金实际公告正文"}}`)
			} else {
				fmt.Fprint(w, `{"success":1,"data":{"art_code":"WRONG","notice_content":"错误正文"}}`)
			}
		}
	}))
	defer server.Close()
	c := NewClient()
	c.NoticeURL = server.URL
	c.NoticeContentURL = server.URL
	items, err := c.ETFDisclosures(context.Background(), "510300.SH")
	if err != nil || len(items) != 2 {
		t.Fatal(items, err)
	}
	for _, item := range items {
		if item.ID == "AN20260101001" && item.ContentStatus != "fulltext" {
			t.Fatal(item)
		}
		if item.ID == "AN20260101002" && (item.Content != "" || item.ContentStatus != "title_only") {
			t.Fatal(item)
		}
	}
}
func TestETFLiveEvidence(t *testing.T) {
	if os.Getenv("EASY_STOCK_LIVE_ETF") != "1" {
		t.Skip("opt-in public-source check")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
	defer cancel()
	c := NewClient()
	for _, row := range []struct{ symbol, asset string }{{"510300.SH", "equity"}, {"511010.SH", "bond"}, {"513100.SH", "equity"}} {
		h, err := c.ETFHoldings(ctx, row.symbol, row.asset)
		if err != nil || len(h.Items) == 0 {
			t.Fatal(row, err)
		}
		t.Log(row.symbol, h.ReportDate, h.DisclosedWeightPercent)
	}
	notices, err := c.ETFDisclosures(ctx, "510300.SH")
	if err != nil || len(notices) == 0 {
		t.Fatal(err)
	}
	body := false
	for _, n := range notices {
		body = body || n.ContentStatus == "fulltext"
	}
	if !body {
		t.Fatal("no notice body retrieved")
	}
	t.Log("notices", len(notices))
}
