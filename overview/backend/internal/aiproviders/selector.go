package aiproviders

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

// Selected 是一次请求选中的供应商 + 账号 + 明文凭据。Key 只在进程内流转，
// 绝不序列化到任何 API 响应。
type Selected struct {
	Provider Provider
	Account  *Account
	Key      string
	Ref      string
}

// ErrNoAccount 表示账号池里没有可用账号（全部停用、限流或已尝试）。
var ErrNoAccount = errors.New("该供应商没有可用的订阅账号或 API Key")

// Select 按「账号数组顺序」选号，对齐 Jet Hub 的
// pool.getAvailableAccount(id, modelId, tried)：
//  1. 跳过 enabled=false、已在 tried 里、modelRateLimits[model] 未到期的账号；
//  2. 取第一个可用账号，通过 CredentialRef 解析明文凭据；
//  3. 无账号池时回退到供应商级 CredentialRef（粘贴 Key 型供应商）；
//  4. 都不存在返回 ErrNoAccount。
//
// modelID 必须透传：传空串会让模型级限流过滤整体短路（Jet Hub 注释里的坑）。
func (s *Store) Select(providerID, modelID string, tried map[string]bool) (Selected, error) {
	p, ok := s.Get(providerID)
	if !ok {
		return Selected{}, fmt.Errorf("供应商不存在：%s", providerID)
	}
	now := s.Now()
	s.mu.RLock()
	defer s.mu.RUnlock()
	for i := range p.Accounts {
		a := p.Accounts[i]
		if !a.Enabled || (tried != nil && tried[a.ID]) {
			continue
		}
		if until, limited := a.ModelRateLimits[modelID]; limited && until > now {
			continue
		}
		key := s.credentials[a.CredentialRef]
		if strings.TrimSpace(key) == "" {
			continue
		}
		account := a
		return Selected{Provider: p, Account: &account, Key: key, Ref: a.CredentialRef}, nil
	}
	ref := p.CredentialRef
	key := s.credentials[ref]
	if strings.TrimSpace(key) != "" {
		return Selected{Provider: p, Key: key, Ref: ref}, nil
	}
	return Selected{}, fmt.Errorf("%w：%s", ErrNoAccount, providerID)
}

// MarkRateLimited 给账号的某个模型打限流截止时间戳（毫秒）。
// auth(401/403) / invalid_request(400/422) / server(5xx) 不写限流标记，
// 由调用方通过 tried 换号即可（对齐 Jet Hub qiniu-adapter 的轮换语义表）。
func (s *Store) MarkRateLimited(providerID, accountID, modelID string, until int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.providers {
		if s.providers[i].ID != providerID {
			continue
		}
		for j := range s.providers[i].Accounts {
			if s.providers[i].Accounts[j].ID != accountID {
				continue
			}
			if s.providers[i].Accounts[j].ModelRateLimits == nil {
				s.providers[i].Accounts[j].ModelRateLimits = map[string]int64{}
			}
			if until <= s.now().UnixMilli() {
				delete(s.providers[i].Accounts[j].ModelRateLimits, modelID)
			} else {
				s.providers[i].Accounts[j].ModelRateLimits[modelID] = until
			}
			return s.persistLocked()
		}
		return fmt.Errorf("账号不存在：%s", accountID)
	}
	return fmt.Errorf("供应商不存在：%s", providerID)
}

// ClearRateLimits 清空某账号（或全部账号）的模型级限流标记。
func (s *Store) ClearRateLimits(providerID, accountID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.providers {
		if s.providers[i].ID != providerID {
			continue
		}
		for j := range s.providers[i].Accounts {
			if accountID != "" && s.providers[i].Accounts[j].ID != accountID {
				continue
			}
			s.providers[i].Accounts[j].ModelRateLimits = nil
		}
		return s.persistLocked()
	}
	return fmt.Errorf("供应商不存在：%s", providerID)
}

// ClassifyStatus 把上游 HTTP 状态归一成轮换动作类别，语义表来自 Jet Hub
// qiniu-adapter.js：auth 换号不写限流、rate_limit 换号写限流、invalid_request 不换。
func ClassifyStatus(status int) string {
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return "auth"
	case status == http.StatusTooManyRequests:
		return "rate_limit"
	case status >= 400 && status < 500:
		return "invalid_request"
	case status >= 500:
		return "server"
	case status == 0:
		return "transport"
	default:
		return "ok"
	}
}

// ShouldRotate 决定是否换号重试用下一个账号。
func ShouldRotate(kind string) bool {
	switch kind {
	case "auth", "rate_limit", "server", "transport":
		return true
	default:
		return false
	}
}

// RecordUsage 按「日期 → provider|account|model」记账（对齐 Jet Hub token-ledger）。
func (s *Store) RecordUsage(providerID, accountID, modelID string, inputTokens, outputTokens int64, failed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	day := s.now().Format("2006-01-02")
	key := providerID + "|" + accountID + "|" + modelID
	if s.usage[day] == nil {
		s.usage[day] = map[string]*UsageEntry{}
	}
	e := s.usage[day][key]
	if e == nil {
		e = &UsageEntry{}
		s.usage[day][key] = e
	}
	e.Requests++
	if failed {
		e.Errors++
	}
	e.InputTokens += inputTokens
	e.OutputTokens += outputTokens
	_ = s.persistUsageLocked()
}

// UsageView 是给设置页看的用量聚合（不含凭据）。
type UsageView struct {
	Date    string       `json:"date"`
	Entries []UsageEntryView `json:"entries"`
}

// UsageEntryView 是单条用量记录。
type UsageEntryView struct {
	Key          string `json:"key"`
	Provider     string `json:"provider"`
	Account      string `json:"account"`
	Model        string `json:"model"`
	Requests     int64  `json:"requests"`
	Errors       int64  `json:"errors"`
	InputTokens  int64  `json:"input_tokens"`
	OutputTokens int64  `json:"output_tokens"`
}

// UsageSnapshot 返回最近 days 天的用量（默认 7）。
func (s *Store) UsageSnapshot(days int) []UsageView {
	if days <= 0 {
		days = 7
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	keys := make([]string, 0, len(s.usage))
	for k := range s.usage {
		keys = append(keys, k)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(keys)))
	if len(keys) > days {
		keys = keys[:days]
	}
	out := make([]UsageView, 0, len(keys))
	for _, day := range keys {
		v := UsageView{Date: day, Entries: []UsageEntryView{}}
		entryKeys := make([]string, 0, len(s.usage[day]))
		for k := range s.usage[day] {
			entryKeys = append(entryKeys, k)
		}
		sort.Strings(entryKeys)
		for _, k := range entryKeys {
			e := s.usage[day][k]
			parts := strings.SplitN(k, "|", 3)
			entry := UsageEntryView{Key: k, Requests: e.Requests, Errors: e.Errors, InputTokens: e.InputTokens, OutputTokens: e.OutputTokens}
			if len(parts) > 0 {
				entry.Provider = parts[0]
			}
			if len(parts) > 1 {
				entry.Account = parts[1]
			}
			if len(parts) > 2 {
				entry.Model = parts[2]
			}
			v.Entries = append(v.Entries, entry)
		}
		out = append(out, v)
	}
	return out
}
