package fund

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"easy-stock/backend/internal/foundation"
	"golang.org/x/net/html"
)

// ETFActions reads disclosed split ratios and cash distributions. A missing
// response is not treated as confirmation that no corporate action occurred.
func (c *Client) ETFActions(ctx context.Context, value string) (foundation.ETFActions, error) {
	symbol, err := etfSymbol(value)
	if err != nil {
		return foundation.ETFActions{}, err
	}
	body, meta, err := c.read(ctx, c.ProfileURL+"/fhsp_"+strings.Split(symbol, ".")[0]+".html")
	if err != nil {
		return foundation.ETFActions{}, err
	}
	result, err := parseActions(string(body), symbol)
	result.Meta = meta
	return result, err
}

func parseActions(body, symbol string) (foundation.ETFActions, error) {
	result := foundation.ETFActions{Symbol: symbol, Items: []foundation.ETFAction{}}
	root, err := html.Parse(strings.NewReader(body))
	if err != nil {
		return result, err
	}
	identity, tables := false, 0
	invalid := false
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Data == "a" && strings.Contains(attr(n, "href"), "fhsp_"+strings.Split(symbol, ".")[0]+".html") {
			identity = true
		}
		if n.Data == "table" {
			text := textOf(n)
			kind := ""
			if strings.Contains(text, "拆分折算日") && strings.Contains(text, "拆分折算比例") {
				kind = "split"
			}
			if strings.Contains(text, "除息日") && strings.Contains(text, "每10份分红") {
				kind = "cash_dividend"
			}
			if kind != "" {
				tables++
				var rows func(*html.Node)
				rows = func(r *html.Node) {
					if r.Data == "tr" {
						cells := []string{}
						for ch := r.FirstChild; ch != nil; ch = ch.NextSibling {
							if ch.Data == "td" {
								cells = append(cells, textOf(ch))
							}
						}
						date, value := "", 0.
						if kind == "split" && len(cells) == 4 {
							date = cells[1]
							parts := strings.Split(strings.ReplaceAll(cells[3], "：", ":"), ":")
							if len(parts) == 2 {
								before, e1 := strconv.ParseFloat(parts[0], 64)
								after, e2 := strconv.ParseFloat(parts[1], 64)
								if e1 == nil && e2 == nil && before > 0 {
									value = after / before
								}
							}
						}
						if kind == "cash_dividend" && len(cells) == 5 {
							date = cells[2]
							v, e := strconv.ParseFloat(strings.TrimSuffix(strings.TrimPrefix(cells[3], "每10份派现金"), "元"), 64)
							if e == nil {
								value = v / 10
							}
						}
						if _, e := time.Parse("2006-01-02", date); e == nil && value > 0 && !math.IsInf(value, 0) && !math.IsNaN(value) {
							result.Items = append(result.Items, foundation.ETFAction{Kind: kind, Date: date, Value: value})
						} else if len(cells) > 1 {
							invalid = true
						}
					}
					for ch := r.FirstChild; ch != nil; ch = ch.NextSibling {
						rows(ch)
					}
				}
				rows(n)
			}
		}
		for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
			walk(ch)
		}
	}
	walk(root)
	if !identity || tables != 2 || invalid {
		return result, fmt.Errorf("fund split/distribution identity or tables unavailable")
	}
	return result, nil
}
