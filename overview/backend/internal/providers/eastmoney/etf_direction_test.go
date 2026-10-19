package eastmoney

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestETFTrackingIndexLookupRejectsFundAndStrategySubstitution(t *testing.T) {
	for _, tc := range []struct {
		name, rows string
		ok         bool
	}{
		{"exact", `{"Name":"红利指数","QuoteID":"1.000015","SecurityTypeName":"指数"}`, true},
		{"fund", `{"Name":"红利指数","QuoteID":"1.510880","SecurityTypeName":"基金"}`, false},
		{"variant", `{"Name":"红利低波指数","QuoteID":"2.H30269","SecurityTypeName":"指数"}`, false},
		{"ambiguous", `{"Name":"红利指数","QuoteID":"1.000015","SecurityTypeName":"指数"},{"Name":"红利指数","QuoteID":"0.399015","SecurityTypeName":"指数"}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/suggest/get":
					if r.URL.Query().Get("input") != "红利指数" {
						t.Error(r.URL)
					}
					fmt.Fprintf(w, `{"QuotationCodeTable":{"Status":0,"Data":[%s]}}`, tc.rows)
				case "/api/qt/stock/kline/get":
					if r.URL.Query().Get("secid") != "1.000015" || r.URL.Query().Get("fqt") != "0" {
						t.Error(r.URL)
					}
					fmt.Fprint(w, `{"rc":0,"data":{"code":"000015","klines":["2026-10-09,100,101,102,99,123,456,3,1,1,1"]}}`)
				default:
					t.Error("unexpected request", r.URL.Path)
				}
			}))
			defer api.Close()
			client := NewClient(WithBaseURL(api.URL))
			client.indexSearchBaseURL = api.URL
			series, err := client.ETFIndexSeries(context.Background(), "上证红利指数", 120)
			if !tc.ok {
				if err == nil {
					t.Fatal("accepted wrong identity", series)
				}
				return
			}
			if err != nil || series.Symbol != "000015.SH" || series.Relationship != "tracking_index" || len(series.Bars) != 1 || series.Bars[0].Close != 101 {
				t.Fatal(series, err)
			}
		})
	}
}
