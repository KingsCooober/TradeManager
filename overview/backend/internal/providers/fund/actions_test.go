package fund

import (
	"context"
	"easy-stock/backend/internal/foundation"
	"os"
	"strings"
	"testing"
	"time"
)

func TestETFActionsRatioAndIdentity(t *testing.T) {
	body := `<a href="fhsp_588200.html">分红送配</a><table><tr><th>拆分折算日</th><th>拆分折算比例</th></tr><tr><td>2026年</td><td>2026-07-20</td><td>份额分拆</td><td>1:3.0000</td></tr></table><table><tr><th>除息日</th><th>每10份分红</th></tr><tr><td>2026年</td><td>2026-06-01</td><td>2026-06-02</td><td>每10份派现金0.5元</td><td>2026-06-03</td></tr></table>`
	a, err := parseActions(body, "588200.SH")
	if err != nil || len(a.Items) != 2 || a.Items[0].Value != 3 || a.Items[1].Value != .05 {
		t.Fatal(a, err)
	}
	if _, err = parseActions(strings.Replace(body, "1:3.0000", "unknown", 1), "588200.SH"); err == nil {
		t.Fatal("invalid action silently accepted")
	}
	if _, err = parseActions(body, "510300.SH"); err == nil {
		t.Fatal("wrong fund accepted")
	}
}
func TestETFMaterialNoticePrioritization(t *testing.T) {
	items := []foundation.ETFAnnouncement{{Title: "普通公告1"}, {Title: "普通公告2"}, {Title: "普通公告3"}, {Title: "普通公告4"}, {Title: "中期报告"}, {Title: "份额拆分公告"}, {Title: "暂停申购赎回公告"}, {Title: "普通公告8"}}
	selected := selectedNoticeBodies(items)
	if len(selected) != 6 || !selected[4] || !selected[5] || !selected[6] {
		t.Fatal(selected)
	}
}
func TestETFLiveChipActions(t *testing.T) {
	if os.Getenv("EASY_STOCK_LIVE_ETF") != "1" {
		t.Skip("opt-in public source")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	a, err := NewClient().ETFActions(ctx, "588200.SH")
	if err != nil || len(a.Items) == 0 {
		t.Fatal(a, err)
	}
	t.Log(a.Items)
}
