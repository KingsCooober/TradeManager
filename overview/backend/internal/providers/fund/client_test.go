package fund

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestETFDirectoryExcludesLinkedAndOffExchangeFunds(t *testing.T) {
	body := `var r=[["510300","A","沪深300ETF","指数型-股票"],["159915","B","创业板ETF","指数型-股票"],["000051","C","300ETF联接","指数型-股票"],["160000","D","普通LOF","指数型-股票"],["000999","E","场外ETF策略","股票型"]];`
	items, err := parseDirectory(body)
	if err != nil || len(items) != 2 {
		t.Fatalf("%+v %v", items, err)
	}
	if items[0].Symbol != "159915.SZ" || items[1].Symbol != "510300.SH" {
		t.Fatal(items)
	}
	if _, err := etfSymbol("510300.SZ"); err == nil {
		t.Fatal("wrong exchange accepted")
	}
}

func TestETFProfileIdentityAndStructuredFields(t *testing.T) {
	body := `<table><tr><th>基金全称</th><td>样本交易型开放式指数证券投资基金</td><th>基金简称</th><td>样本ETF</td></tr><tr><th>基金代码</th><td>510300（主代码）<th>基金类型</th><td>指数型-股票</td></tr><tr><th>管理费率</th><td>0.15%（每年）</td><th>跟踪标的</th><td>样本指数</td></tr></table><h4><label>投资范围</label></h4><div class="space0"></div><p>指数成份股</p>`
	p, err := parseProfile(body, "510300.SH")
	if err != nil {
		t.Fatal(err)
	}
	if p.AssetClass != "equity" || p.TrackingTarget != "样本指数" || p.InvestmentScope != "指数成份股" || p.PricePrecision != 3 {
		t.Fatalf("%+v", p)
	}
	if _, err := parseProfile(strings.Replace(body, "样本交易型开放式指数证券投资基金", "样本ETF联接基金", 1), "510300.SH"); err == nil {
		t.Fatal("linked fund accepted")
	}
	if _, err := parseProfile(body, "510500.SH"); err == nil {
		t.Fatal("wrong fund accepted")
	}
}

func TestETFNetValueParsesDataWithoutExecutingScript(t *testing.T) {
	body := `var fS_code="510300";var Data_netWorthTrend=[{"x":1791504000000,"y":1.2345,"unitMoney":"分红"}];throw new Error("not executable");`
	v, err := parseNetValues(body, "510300.SH")
	if err != nil || len(v.Points) != 1 || v.Points[0].Value != 1.2345 || v.Points[0].Distribution != "分红" {
		t.Fatalf("%+v %v", v, err)
	}
	money, err := parseNetValues(`var fS_code="511990";var Data_millionCopiesIncome=[[1791504000000,0.3]];var Data_sevenDaysYearIncome=[[1791504000000,1.2]];`, "511990.SH")
	if err != nil || len(money.Points) != 0 || len(money.SevenDayAnnualized) != 1 {
		t.Fatalf("%+v %v", money, err)
	}
}

func TestETFLiveFundCoverage(t *testing.T) {
	if os.Getenv("EASY_STOCK_LIVE_ETF") != "1" {
		t.Skip("set EASY_STOCK_LIVE_ETF=1 to verify public sources")
	}
	c := NewClient()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
	defer cancel()
	items, err := c.ETFDirectory(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("ETF directory: %d", len(items))
	for symbol, class := range map[string]string{"510300.SH": "equity", "159915.SZ": "equity", "511010.SH": "bond", "518880.SH": "commodity", "513100.SH": "equity", "511990.SH": "money"} {
		t.Run(symbol, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			p, err := c.ETFProfile(ctx, symbol)
			if err != nil {
				t.Fatal(err)
			}
			if p.AssetClass != class || p.InvestmentScope == "" {
				t.Fatalf("profile incomplete: %+v", p)
			}
			v, err := c.ETFNetValues(ctx, symbol)
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("%s %s cross_border=%t NAV=%d income=%d yield=%d target=%s", symbol, p.AssetClass, p.CrossBorder, len(v.Points), len(v.IncomePerTenThousand), len(v.SevenDayAnnualized), p.TrackingTarget)
		})
	}
}
