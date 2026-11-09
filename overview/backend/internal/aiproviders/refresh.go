package aiproviders

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// 对齐 Jet Hub refresh.js：REFRESH_LEAD_MS 提前 1 小时、重试 10 分钟、
// 反常网络 1 分钟。refresh_token 失效是终态，需要用户重新登录。
const (
	RefreshRetryMs          = int64(600_000)
	RefreshAbnormalRetryMs  = int64(60_000)
	DefaultRateLimitCooldown = int64(60_000)
)

// RefreshPlan 描述一个订阅账号的续期状态，供设置页展示（不含任何明文凭据）。
type RefreshPlan struct {
	ProviderID  string `json:"provider_id"`
	AccountID   string `json:"account_id"`
	Nickname    string `json:"nickname"`
	ExpiresAt   int64  `json:"expires_at"`
	Due         bool   `json:"due"`
	Refreshable bool   `json:"refreshable"`
}

// RefreshPlans 返回所有账号的续期计划。Due=true 表示已进入提前 1 小时窗口。
func (s *Store) RefreshPlans() []RefreshPlan {
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := s.now().UnixMilli()
	var out []RefreshPlan
	for _, p := range s.providers {
		refreshURL := strings.TrimSpace(p.RefreshURL)
		for _, a := range p.Accounts {
			due := a.Enabled && a.Refreshable && refreshURL != "" && a.ExpiresAt > 0 && a.ExpiresAt-now <= RefreshLeadMs
			out = append(out, RefreshPlan{
				ProviderID:  p.ID,
				AccountID:   a.ID,
				Nickname:    a.Nickname,
				ExpiresAt:   a.ExpiresAt,
				Due:         due,
				Refreshable: a.Refreshable && refreshURL != "",
			})
		}
	}
	return out
}

// credentialBlob 是凭据库里可选的结构化订阅凭据。纯 API Key 时解析失败，
// 该账号就标记为不可自动续期，refresh 直接跳过。
type credentialBlob struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresAt    int64  `json:"expires_at"`
	ClientID     string `json:"client_id,omitempty"`
	Extra        map[string]any `json:"-"`
}

func decodeCredential(secret string) (credentialBlob, bool) {
	var b credentialBlob
	secret = strings.TrimSpace(secret)
	if !strings.HasPrefix(secret, "{") {
		return b, false
	}
	if err := json.Unmarshal([]byte(secret), &b); err != nil {
		return b, false
	}
	var raw map[string]any
	_ = json.Unmarshal([]byte(secret), &raw)
	delete(raw, "access_token")
	delete(raw, "refresh_token")
	delete(raw, "expires_at")
	b.Extra = raw
	return b, b.RefreshToken != ""
}

// RefreshResult 是一次续期的脱敏结果。
type RefreshResult struct {
	ProviderID string `json:"provider_id"`
	AccountID  string `json:"account_id"`
	OK         bool   `json:"ok"`
	Message    string `json:"message,omitempty"`
	ExpiresAt  int64  `json:"expires_at,omitempty"`
}

// RefreshAccount 用 RefreshURL 走标准 refresh_token 流程续期一个账号。
// 返回 (是否真的发了请求, error)，调用方据此决定重试节奏。
func (s *Store) RefreshAccount(ctx context.Context, client *http.Client, providerID, accountID string) (RefreshResult, bool, error) {
	result := RefreshResult{ProviderID: providerID, AccountID: accountID}
	p, ok := s.Get(providerID)
	if !ok {
		return result, false, fmt.Errorf("供应商不存在：%s", providerID)
	}
	refreshURL := strings.TrimSpace(p.RefreshURL)
	if refreshURL == "" {
		return result, false, errors.New("该供应商未配置刷新地址")
	}
	var account Account
	found := false
	for _, a := range p.Accounts {
		if a.ID == accountID {
			account = a
			found = true
			break
		}
	}
	if !found {
		return result, false, fmt.Errorf("账号不存在：%s", accountID)
	}
	secret, ok := s.Credential(account.CredentialRef)
	if !ok || secret == "" {
		return result, false, fmt.Errorf("凭据不存在：%s", account.CredentialRef)
	}
	blob, ok := decodeCredential(secret)
	if !ok {
		return result, false, errors.New("该凭据不是可续期的订阅凭据（缺少 refresh_token）")
	}

	body := map[string]any{"grant_type": "refresh_token", "refresh_token": blob.RefreshToken}
	for k, v := range blob.Extra {
		body[k] = v
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return result, false, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, refreshURL, bytes.NewReader(payload))
	if err != nil {
		return result, true, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if blob.AccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+blob.AccessToken)
	}
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return result, true, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return result, true, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		result.Message = fmt.Sprintf("刷新失败（HTTP %d）：%s", resp.StatusCode, strings.TrimSpace(string(raw)))
		return result, true, errors.New(result.Message)
	}
	var out struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
		ExpiresAt    int64  `json:"expires_at"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.AccessToken == "" {
		result.Message = "刷新响应缺少 access_token"
		return result, true, errors.New(result.Message)
	}
	next := credentialBlob{AccessToken: out.AccessToken, RefreshToken: blob.RefreshToken, ClientID: blob.ClientID, Extra: blob.Extra}
	if out.RefreshToken != "" {
		next.RefreshToken = out.RefreshToken
	}
	nowMs := s.Now()
	switch {
	case out.ExpiresAt > 0:
		next.ExpiresAt = out.ExpiresAt
	case out.ExpiresIn > 0:
		next.ExpiresAt = nowMs + out.ExpiresIn*1000
	default:
		next.ExpiresAt = nowMs + 24*3600*1000
	}
	encoded, err := json.Marshal(next)
	if err != nil {
		return result, true, err
	}
	if err := s.SetCredential(account.CredentialRef, string(encoded)); err != nil {
		return result, true, err
	}
	account.ExpiresAt = next.ExpiresAt
	if err := s.UpsertAccount(providerID, account); err != nil {
		return result, true, err
	}
	result.OK = true
	result.ExpiresAt = next.ExpiresAt
	result.Message = "续期成功"
	return result, true, nil
}

// RefreshDue 续期所有已进入提前窗口的账号，返回脱敏结果列表。
// 单个账号失败不影响其它账号；调用方可按 RefreshRetryMs 安排下一次。
func (s *Store) RefreshDue(ctx context.Context, client *http.Client) []RefreshResult {
	var out []RefreshResult
	for _, plan := range s.RefreshPlans() {
		if !plan.Due {
			continue
		}
		result, _, err := s.RefreshAccount(ctx, client, plan.ProviderID, plan.AccountID)
		if err != nil && result.Message == "" {
			result.Message = err.Error()
		}
		out = append(out, result)
	}
	return out
}

// StartRefreshLoop 后台每 5 分钟检查一次提前续期窗口。ctx 取消即退出。
func (s *Store) StartRefreshLoop(ctx context.Context, client *http.Client, onResult func([]RefreshResult)) {
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				results := s.RefreshDue(ctx, client)
				if onResult != nil && len(results) > 0 {
					onResult(results)
				}
			}
		}
	}()
}
