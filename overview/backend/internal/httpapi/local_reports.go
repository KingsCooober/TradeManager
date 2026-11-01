package httpapi

import (
	"context"
	"database/sql"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"easy-stock/backend/internal/foundation"
	"easy-stock/backend/internal/sqliteutil"
)

// 本地研报库（research-hub）的只读接口。
//
// 背景：研报库界面 2026-10-20 下线，能力并入 easy-stock。
// 它每天仍在自动抓取约 20 篇机构研报（含正文），这些数据是全项目唯一
// 长期沉淀的研报语料，所以这里给它一个正式的读取通道，
// 前端表现为左侧「研究信号 → 行业研报」。
//
// 只读：DSN 走 mode=ro，不会写入 research.db（写操作归 Python 抓取服务）。

const defaultLocalReportsDB = "/var/www/trademanager/research-hub/data/research.db"

// 没有行业标注的研报（如 21财经脱水研报）统一归到这个桶
const localReportsOtherIndustry = "未分类"

func resolveLocalReportsDBPath(configured string) string {
	if path := strings.TrimSpace(configured); path != "" {
		return path
	}
	if path := strings.TrimSpace(os.Getenv("A_STOCK_LOCAL_REPORTS_DB")); path != "" {
		return path
	}
	return defaultLocalReportsDB
}

func (s *Server) openLocalReports() (*sql.DB, error) {
	path := s.localReportsDB
	if path == "" {
		path = resolveLocalReportsDBPath("")
	}
	if _, err := os.Stat(path); err != nil {
		return nil, err
	}
	dsn := "file:" + filepath.ToSlash(path) + "?mode=ro"
	return sqliteutil.Open(dsn)
}

// GET /api/v1/research/local-reports?q=&industry=&limit=&offset=
func (s *Server) localReportsHandler(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	industry := strings.TrimSpace(r.URL.Query().Get("industry"))
	limit, err := marketLimitQuery(r, 80, 200)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	offset := 0
	if raw := strings.TrimSpace(r.URL.Query().Get("offset")); raw != "" {
		if parsed, parseErr := strconv.Atoi(raw); parseErr == nil && parsed > 0 {
			offset = parsed
		}
	}

	db, err := s.openLocalReports()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "本地研报库暂不可用："+err.Error())
		return
	}
	defer db.Close()

	where := []string{"1=1"}
	args := []any{}
	if query != "" {
		where = append(where, "(title LIKE ? OR organization LIKE ? OR industry LIKE ? OR summary LIKE ? OR content LIKE ?)")
		like := "%" + query + "%"
		for i := 0; i < 5; i++ {
			args = append(args, like)
		}
	}
	if industry != "" {
		// 行业标签按「组」过滤：标签是去掉 Ⅱ/Ⅲ 后缀的显示名（如「IT服务」），
		// 库里存的是「IT服务Ⅱ」，所以用前缀匹配；空行业归到「未分类」。
		if industry == localReportsOtherIndustry {
			where = append(where, "(industry = '' OR industry IS NULL)")
		} else {
			where = append(where, "industry LIKE ?")
			args = append(args, industry+"%")
		}
	}
	args = append(args, limit, offset)

	statement := `SELECT id, title, org, industry, rating,
       COALESCE(CAST(NULLIF(target_price, '') AS REAL), 0) AS target_price,
       report_date, summary, source_url,
       COALESCE(stock_code, '') AS stock_code
FROM reports WHERE ` + strings.Join(where, " AND ") + `
ORDER BY report_date DESC, id DESC LIMIT ? OFFSET ?`

	rows, err := db.QueryContext(r.Context(), statement, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取本地研报失败："+err.Error())
		return
	}
	defer rows.Close()

	now := time.Now()
	items := make([]foundation.MarketResearchItem, 0, limit)
	for rows.Next() {
		var (
			id        int64
			title     string
			org       string
			industry  string
			rating    string
			target    float64
			reportDay string
			summary   string
			sourceURL string
			stockCode string
		)
		if scanErr := rows.Scan(&id, &title, &org, &industry, &rating, &target, &reportDay, &summary, &sourceURL, &stockCode); scanErr != nil {
			writeError(w, http.StatusInternalServerError, "解析本地研报失败："+scanErr.Error())
			return
		}
		// 个股研报的标题常常只有「三季度扣非利润同比增长22%」这种概括，
		// 看不出是哪只票；公司名藏在摘要开头（「中国巨石(600176) …」），抠出来做徽标。
		stockName := ""
		if stockCode != "" {
			stockName = stockNameFromSummary(summary, stockCode)
		}
		items = append(items, foundation.MarketResearchItem{
			Kind:         "local-report",
			ID:           strconv.FormatInt(id, 10),
			Title:        title,
			Symbol:       stockCode,
			StockName:    stockName,
			Organization: org,
			IndustryName: normalizeIndustryName(industry),
			Rating:       rating,
			TargetHigh:   target,
			PublishedAt:  parseReportDay(reportDay),
			URL:          sourceURL,
			Meta: foundation.SourceMeta{
				Source:    "研报库（本地沉淀）",
				SourceURL: sourceURL,
				FetchedAt: now,
			},
		})
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "读取本地研报失败："+err.Error())
		return
	}

	// 21财经脱水研报的标题写「这家……龙头」不点名，摘要里也没有「公司名(代码)」，
	// stockNameFromSummary 拿不到名字，只能拿代码去行情接口换成标的名。
	// 失败就保持空串，前端退回显示代码（不会让整个列表 500）。
	s.fillStockNames(r.Context(), items)

	// 分页需要总数：用同一套 where 再算一次 COUNT(*)，
	// 否则前端只能靠「本页条数」猜，翻到最后一页才发现到底有多少。
	total := 0
	countSQL := "SELECT COUNT(*) FROM reports WHERE " + strings.Join(where, " AND ")
	if countErr := db.QueryRowContext(r.Context(), countSQL, args[:len(args)-2]...).Scan(&total); countErr != nil {
		total = len(items)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"data":   items,
		"total":  total,
		"limit":  limit,
		"offset": offset,
		"meta":   foundation.SourceMeta{Source: "研报库（本地沉淀）", FetchedAt: now},
	})
}

// GET /api/v1/research/local-report?id=123
func (s *Server) localReportContentHandler(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "缺少 id")
		return
	}

	db, err := s.openLocalReports()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "本地研报库暂不可用："+err.Error())
		return
	}
	defer db.Close()

	var (
		title     string
		org       string
		industry  string
		rating    string
		summary   string
		content   string
		sourceURL string
	)
	row := db.QueryRowContext(r.Context(),
		"SELECT title, org, industry, rating, summary, content, source_url FROM reports WHERE id = ?", id)
	if scanErr := row.Scan(&title, &org, &industry, &rating, &summary, &content, &sourceURL); scanErr != nil {
		writeError(w, http.StatusNotFound, "没有找到这篇研报")
		return
	}

	body := strings.TrimSpace(content)
	if body == "" {
		body = strings.TrimSpace(summary)
	}
	body = cleanReportMarkdown(title, body)

	writeJSON(w, http.StatusOK, map[string]any{
		"data": foundation.MarketResearchDetail{
			Kind:    "local-report",
			ID:      id,
			Title:   title,
			Content: body,
			URL:     sourceURL,
			Meta:    foundation.SourceMeta{Source: "研报库（本地沉淀）", SourceURL: sourceURL, FetchedAt: time.Now()},
		},
		"meta": foundation.SourceMeta{Source: "研报库（本地沉淀）", FetchedAt: time.Now()},
	})
}

// GET /api/v1/research/local-report-industries
// 给前端做行业筛选标签：返回各行业的研报数量，按数量倒序。
//
// 研报库里的 industry 是带「Ⅱ/Ⅲ」后缀的申万二级名（如「IT服务Ⅱ」），
// 这里统一去掉后缀再合并计数，让标签读起来是干净的行业名；
// 空行业的（21财经脱水研报）归到「未分类」，单独一个桶。
func (s *Server) localReportIndustriesHandler(w http.ResponseWriter, r *http.Request) {
	db, err := s.openLocalReports()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "本地研报库暂不可用："+err.Error())
		return
	}
	defer db.Close()

	rows, err := db.QueryContext(r.Context(),
		"SELECT industry, COUNT(*) FROM reports GROUP BY industry")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取行业分布失败："+err.Error())
		return
	}
	defer rows.Close()

	type industryCount struct {
		Name  string `json:"name"`
		Count int    `json:"count"`
	}
	counts := map[string]int{}
	order := []string{}
	other := 0
	for rows.Next() {
		var raw string
		var count int
		if scanErr := rows.Scan(&raw, &count); scanErr != nil {
			writeError(w, http.StatusInternalServerError, "解析行业分布失败："+scanErr.Error())
			return
		}
		name := normalizeIndustryName(raw)
		if name == "" {
			other += count
			continue
		}
		if _, seen := counts[name]; !seen {
			order = append(order, name)
		}
		counts[name] += count
	}

	items := make([]industryCount, 0, len(order)+1)
	for _, name := range order {
		items = append(items, industryCount{Name: name, Count: counts[name]})
	}
	// 按数量倒序（同数量按名称），前端直接照顺序渲染
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Count != items[j].Count {
			return items[i].Count > items[j].Count
		}
		return items[i].Name < items[j].Name
	})
	if other > 0 {
		items = append(items, industryCount{Name: localReportsOtherIndustry, Count: other})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"data": items,
		"meta": foundation.SourceMeta{Source: "研报库（本地沉淀）", FetchedAt: time.Now()},
	})
}

// normalizeIndustryName 去掉申万二级的「Ⅱ/Ⅲ/Ⅰ」后缀，统一成可读的行业名。
func normalizeIndustryName(raw string) string {
	name := strings.TrimSpace(raw)
	if name == "" {
		return ""
	}
	name = strings.TrimRight(name, "ⅠⅡⅢⅣⅰⅱⅲⅳ")
	return strings.TrimSpace(name)
}

// cleanReportMarkdown 修掉研报库里几处「抓取时留下的 Markdown 噪音」：
//  1. 正文首行的 `# 标题` 与列表里已经展示的标题重复，去掉；
//  2. `- **原文页**：[url](url)` / `- **原文 PDF**：[url](url)` 这种链接在页脚已有，
//     而且链接文字本身就是一段裸 URL，渲染出来又长又难看，整行删掉；
//  3. 连续空行压成一个，避免详情面板出现大片空白。
func cleanReportMarkdown(title, body string) string {
	if strings.TrimSpace(body) == "" {
		return ""
	}
	lines := strings.Split(body, "\n")
	out := make([]string, 0, len(lines))
	blank := 0
	trimmedTitle := strings.TrimSpace(title)

	for index, line := range lines {
		trimmed := strings.TrimSpace(line)

		// 只有正文第一行是标题时才删，避免误删正文中间的小标题
		if index == 0 && strings.HasPrefix(trimmed, "# ") {
			heading := strings.TrimSpace(strings.TrimPrefix(trimmed, "# "))
			if trimmedTitle == "" || strings.Contains(heading, trimmedTitle) || strings.Contains(trimmedTitle, heading) {
				continue
			}
		}
		if strings.HasPrefix(trimmed, "- **原文页**") || strings.HasPrefix(trimmed, "- **原文 PDF**") || strings.HasPrefix(trimmed, "- **原文PDF**") {
			continue
		}
		if trimmed == "" {
			blank++
			if blank > 1 {
				continue
			}
		} else {
			blank = 0
		}
		out = append(out, line)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

// 代码 → 标的名 的短期缓存。研报翻页会反复问同一批代码，
// 不缓存的话每翻一页就打一次行情接口。
const localReportNameTTL = 6 * time.Hour

type localReportNameEntry struct {
	name string
	at   time.Time
}

var localReportNameCache = struct {
	sync.Mutex
	items map[string]localReportNameEntry
}{items: map[string]localReportNameEntry{}}

// stockCodeKey 把 002979.SZ / 002979 统一成 002979，
// 行情接口回来的代码格式不一定和库里一致，两边都归一化才能对上。
func stockCodeKey(symbol string) string {
	symbol = strings.TrimSpace(symbol)
	if index := strings.Index(symbol, "."); index > 0 {
		return symbol[:index]
	}
	return symbol
}

// fillStockNames 给缺公司名的研报补上标的名称（代码 → 名称）。
// 只补 StockName 为空的条目，从摘要抠出名字的（东财那批）保持原样。
// 行情接口失败时整批放弃，前端会退回显示代码，不影响列表本身。
func (s *Server) fillStockNames(ctx context.Context, items []foundation.MarketResearchItem) {
	if s.realtimeProvider == nil || len(items) == 0 {
		return
	}
	now := time.Now()
	pending := make([]string, 0, len(items))
	seen := map[string]bool{}

	localReportNameCache.Lock()
	for i := range items {
		key := stockCodeKey(items[i].Symbol)
		if key == "" || items[i].StockName != "" {
			continue
		}
		if entry, ok := localReportNameCache.items[key]; ok && now.Sub(entry.at) < localReportNameTTL {
			items[i].StockName = entry.name
			continue
		}
		if !seen[key] {
			seen[key] = true
			pending = append(pending, items[i].Symbol)
		}
	}
	localReportNameCache.Unlock()
	if len(pending) == 0 {
		return
	}

	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	quotes, err := s.realtimeProvider.Realtime(queryCtx, pending)
	if err != nil {
		return
	}

	// 行情返回空名（停牌/退市/代码不存在）不写缓存，下次还能再试
	names := make(map[string]string, len(quotes))
	localReportNameCache.Lock()
	for _, quote := range quotes {
		name := strings.TrimSpace(quote.Name)
		key := stockCodeKey(quote.Symbol)
		if name == "" || key == "" {
			continue
		}
		names[key] = name
		localReportNameCache.items[key] = localReportNameEntry{name: name, at: now}
	}
	localReportNameCache.Unlock()

	for i := range items {
		if items[i].StockName != "" {
			continue
		}
		if name, ok := names[stockCodeKey(items[i].Symbol)]; ok {
			items[i].StockName = name
		}
	}
}

// stockNameFromSummary 从摘要开头抠出「公司名(代码)」里的公司名。
// 东财个股研报的摘要几乎都以这种形式开头，标题里反而没有公司名。
func stockNameFromSummary(summary, code string) string {
	code = strings.TrimSpace(code)
	if code == "" || summary == "" {
		return ""
	}
	// 库里存的是 600066.SH 这种带后缀的形式，摘要里写的是「宇通客车(600066)」，只比对 6 位数字
	if index := strings.Index(code, "."); index > 0 {
		code = code[:index]
	}
	// 只取代码前的 10 个字符范围去找，避免正则扫全文
	head := summary
	if len(head) > 200 {
		head = head[:200]
	}
	pattern, err := regexp.Compile(`([\p{Han}A-Za-z0-9*Ａ-Ｚａ-ｚ]{2,10})\s*[（(]\s*` + regexp.QuoteMeta(code) + `(\.[A-Za-z]{2})?\s*[)）]`)
	if err != nil {
		return ""
	}
	if match := pattern.FindStringSubmatch(head); len(match) >= 2 {
		return strings.TrimSpace(match[1])
	}
	return ""
}

func parseReportDay(value string) time.Time {
	value = strings.TrimSpace(value)
	for _, layout := range []string{"2006-01-02", "2006-01-02 15:04:05", time.RFC3339} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed
		}
	}
	return time.Time{}
}
