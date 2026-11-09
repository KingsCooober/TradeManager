// Package aiproviders 维护运行时可自定义的 AI 供应商注册表、每家供应商的订阅
// 账号池，以及与注册表分离的凭据库。设计参照 DSH 的 dsh-providers-hub（Jet Hub）：
// 供应商可增删改（不再硬编码白名单）、账号按数组顺序选号、凭据用 credentialRef
// 间接引用，明文 token / API Key 单独落 0600 文件，绝不出现在任何对外 API 响应里。
package aiproviders

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const stateVersion = 1

// RefreshLeadMs 提前 1 小时刷新，对齐 Jet Hub 的 REFRESH_LEAD_MS。
const RefreshLeadMs = int64(3_600_000)

// 出站请求携带凭据的方式。
const (
	AuthBearer = "bearer"
	AuthAPIKey = "x-api-key"
	AuthNone   = "none"
)

// Provider 是一家可配置的模型供应商。内置供应商 Builtin=true 不可删除（但可停用、
// 可改 BaseURL），用户新增的 Builtin=false。子路径追加到 BaseURL 末尾，供模型发现
// 与本机 hub 反向代理拼装真实请求地址。CredentialRef 是「单 Key 型」供应商的凭据
// 引用；有订阅账号池时用 Accounts（优先），单 Key 作为兜底。
type Provider struct {
	ID            string    `json:"id"`
	Label         string    `json:"label"`
	BaseURL       string    `json:"base_url"`
	ChatPath      string    `json:"chat_path,omitempty"`
	ResponsesPath string    `json:"responses_path,omitempty"`
	MessagesPath  string    `json:"messages_path,omitempty"`
	ModelsPath    string    `json:"models_path,omitempty"`
	RefreshURL    string    `json:"refresh_url,omitempty"`
	AuthScheme    string    `json:"auth_scheme,omitempty"`
	APIMode       string    `json:"api_mode,omitempty"`
	DefaultModel  string    `json:"default_model,omitempty"`
	CredentialRef string    `json:"credential_ref,omitempty"`
	CachedModels  []string  `json:"cached_models,omitempty"`
	Enabled       bool      `json:"enabled"`
	Builtin       bool      `json:"builtin"`
	Accounts      []Account `json:"accounts,omitempty"`
}

// Account 是该供应商下的一个订阅账号 / 凭据槽位。CredentialRef 只保存引用名，
// 真正的 token / API Key 存凭据库。ExpiresAt 与 ModelRateLimits 的值都是毫秒
// 时间戳（与 Jet Hub 的 state.json 一致）。
type Account struct {
	ID              string           `json:"id"`
	Nickname        string           `json:"nickname"`
	Enabled         bool             `json:"enabled"`
	CredentialRef   string           `json:"credential_ref"`
	Refreshable     bool             `json:"refreshable"`
	CreatedAt       int64            `json:"created_at"`
	ExpiresAt       int64            `json:"expires_at,omitempty"`
	ModelRateLimits map[string]int64 `json:"model_rate_limits,omitempty"`
}

// UsageEntry 是「某天 → 某 provider|account|model」的用量计数。
type UsageEntry struct {
	Requests     int64 `json:"requests"`
	Errors       int64 `json:"errors"`
	InputTokens  int64 `json:"input_tokens,omitempty"`
	OutputTokens int64 `json:"output_tokens,omitempty"`
}

type providerState struct {
	Version   int        `json:"version"`
	Providers []Provider `json:"providers"`
}

type credentialState struct {
	Version     int               `json:"version"`
	Credentials map[string]string `json:"credentials"`
}

type usageState struct {
	Version int                             `json:"version"`
	Days    map[string]map[string]*UsageEntry `json:"days"`
}

// Store 是注册表 + 凭据库 + 用量账本的进程内权威副本。所有导出方法都加锁；
// 写操作成功后原子落盘（tmp + rename，权限 0600）。statePath 为空时纯内存（单测用）。
type Store struct {
	mu          sync.RWMutex
	statePath   string
	credPath    string
	usagePath   string
	now         func() time.Time
	providers   []Provider
	credentials map[string]string
	usage       map[string]map[string]*UsageEntry
}

var providerIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var credentialRefPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Open 打开（或初始化）注册表。statePath 为空时纯内存。任一文件缺失时写种子。
func Open(statePath, credPath string) (*Store, error) {
	s := &Store{
		statePath:   statePath,
		credPath:    credPath,
		now:         time.Now,
		credentials: map[string]string{},
		usage:       map[string]map[string]*UsageEntry{},
	}
	if statePath != "" {
		s.usagePath = filepath.Join(filepath.Dir(statePath), "ai-usage.json")
	}
	if err := s.loadProviders(); err != nil {
		return nil, err
	}
	if err := s.loadCredentials(); err != nil {
		return nil, err
	}
	if err := s.loadUsage(); err != nil {
		return nil, err
	}
	if statePath != "" {
		missing := false
		for _, p := range []string{statePath, credPath, s.usagePath} {
			if _, err := os.Stat(p); errors.Is(err, os.ErrNotExist) {
				missing = true
				break
			}
		}
		if missing {
			if err := s.persistLocked(); err != nil {
				return nil, err
			}
		}
	}
	return s, nil
}

// Now 返回当前毫秒时间戳，单测可替换时间源。
func (s *Store) Now() int64 { return s.now().UnixMilli() }

// SetNow 替换时间源（仅单测使用）。
func (s *Store) SetNow(fn func() time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.now = fn
}

func (s *Store) loadProviders() error {
	s.providers = seedProviders()
	if s.statePath == "" {
		return nil
	}
	data, err := os.ReadFile(s.statePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read ai providers: %w", err)
	}
	var st providerState
	if err := json.Unmarshal(data, &st); err != nil {
		return fmt.Errorf("parse ai providers: %w", err)
	}
	if len(st.Providers) > 0 {
		s.providers = mergeSeed(st.Providers)
	}
	_ = os.Chmod(s.statePath, 0o600)
	return nil
}

func (s *Store) loadCredentials() error {
	if s.credPath == "" {
		return nil
	}
	data, err := os.ReadFile(s.credPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read ai credentials: %w", err)
	}
	var st credentialState
	if err := json.Unmarshal(data, &st); err != nil {
		return fmt.Errorf("parse ai credentials: %w", err)
	}
	if st.Credentials != nil {
		s.credentials = st.Credentials
	}
	_ = os.Chmod(s.credPath, 0o600)
	return nil
}

func (s *Store) loadUsage() error {
	if s.usagePath == "" {
		return nil
	}
	data, err := os.ReadFile(s.usagePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read ai usage: %w", err)
	}
	var st usageState
	if err := json.Unmarshal(data, &st); err != nil {
		return fmt.Errorf("parse ai usage: %w", err)
	}
	if st.Days != nil {
		s.usage = st.Days
	}
	_ = os.Chmod(s.usagePath, 0o600)
	return nil
}

// mergeSeed 以已保存的注册表为准，只把文件里缺失的内置供应商补进去，
// 这样升级后新内置项会出现，而用户自定义项与对内置项的改动都保留。
func mergeSeed(saved []Provider) []Provider {
	seen := make(map[string]bool, len(saved))
	for _, p := range saved {
		seen[p.ID] = true
	}
	out := cloneProviders(saved)
	for _, b := range seedProviders() {
		if !seen[b.ID] {
			out = append(out, b)
		}
	}
	return out
}

// persistLocked 假设调用方已持有写锁（或处于 Open 构造期，此时无并发）。
func (s *Store) persistLocked() error {
	if s.statePath == "" {
		return nil
	}
	if err := writeAtomic(s.statePath, providerState{Version: stateVersion, Providers: cloneProviders(s.providers)}); err != nil {
		return fmt.Errorf("persist ai providers: %w", err)
	}
	creds := make(map[string]string, len(s.credentials))
	for k, v := range s.credentials {
		creds[k] = v
	}
	if err := writeAtomic(s.credPath, credentialState{Version: stateVersion, Credentials: creds}); err != nil {
		return fmt.Errorf("persist ai credentials: %w", err)
	}
	return s.persistUsageLocked()
}

func (s *Store) persistUsageLocked() error {
	if s.usagePath == "" {
		return nil
	}
	days := make(map[string]map[string]*UsageEntry, len(s.usage))
	for day, entries := range s.usage {
		cp := make(map[string]*UsageEntry, len(entries))
		for k, v := range entries {
			e := *v
			cp[k] = &e
		}
		days[day] = cp
	}
	if err := writeAtomic(s.usagePath, usageState{Version: stateVersion, Days: days}); err != nil {
		return fmt.Errorf("persist ai usage: %w", err)
	}
	return nil
}

func writeAtomic(path string, value any) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".ai-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func cloneProviders(in []Provider) []Provider {
	out := make([]Provider, len(in))
	for i := range in {
		out[i] = in[i]
		if in[i].CachedModels != nil {
			out[i].CachedModels = append([]string(nil), in[i].CachedModels...)
		}
		if in[i].Accounts != nil {
			out[i].Accounts = make([]Account, len(in[i].Accounts))
			for j := range in[i].Accounts {
				out[i].Accounts[j] = in[i].Accounts[j]
				if m := in[i].Accounts[j].ModelRateLimits; m != nil {
					cp := make(map[string]int64, len(m))
					for k, v := range m {
						cp[k] = v
					}
					out[i].Accounts[j].ModelRateLimits = cp
				}
			}
		}
	}
	return out
}

// ---------- 读 ----------

// List 返回给前端 / settingsView 的注册表深拷贝。凭据永远不在这里出现。
func (s *Store) List() []Provider {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneProviders(s.providers)
}

func (s *Store) Get(id string) (Provider, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.providers {
		if p.ID == id {
			return cloneProviders([]Provider{p})[0], true
		}
	}
	return Provider{}, false
}

// Exists 用于 settings 的 provider 白名单：注册表里存在即合法（含被临时停用的，
// 避免已保存的旧 profile 因供应商停用而校验失败）。
func (s *Store) Exists(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.providers {
		if p.ID == id {
			return true
		}
	}
	return false
}

func (s *Store) ModelsPath(id string) string {
	p, ok := s.Get(id)
	if !ok {
		return "/models"
	}
	return childPath(p.ModelsPath, "/models")
}

func (s *Store) ChatPath(id string) string {
	p, ok := s.Get(id)
	if !ok {
		return "/chat/completions"
	}
	return childPath(p.ChatPath, "/chat/completions")
}

func (s *Store) ResponsesPath(id string) string {
	p, ok := s.Get(id)
	if !ok {
		return "/responses"
	}
	return childPath(p.ResponsesPath, "/responses")
}

func (s *Store) MessagesPath(id string) string {
	p, ok := s.Get(id)
	if !ok {
		return "/v1/messages"
	}
	return childPath(p.MessagesPath, "/v1/messages")
}

func (s *Store) AuthScheme(id string) string {
	p, ok := s.Get(id)
	if !ok || p.AuthScheme == "" {
		return AuthBearer
	}
	return p.AuthScheme
}

func childPath(value, fallback string) string {
	v := strings.TrimSpace(value)
	if v == "" {
		return fallback
	}
	if !strings.HasPrefix(v, "/") {
		v = "/" + v
	}
	return v
}

// AuthHeaders 按供应商的鉴权方式生成出站请求头。key 为空时不加任何凭据头。
func (s *Store) AuthHeaders(id, key string) map[string]string {
	headers := map[string]string{}
	if strings.TrimSpace(key) == "" {
		return headers
	}
	switch s.AuthScheme(id) {
	case AuthNone:
		return headers
	case AuthAPIKey:
		headers["x-api-key"] = key
		headers["anthropic-version"] = "2023-06-01"
	default:
		headers["Authorization"] = "Bearer " + key
	}
	return headers
}

func (s *Store) BaseURL(id string) string {
	p, ok := s.Get(id)
	if !ok {
		return ""
	}
	return strings.TrimRight(p.BaseURL, "/")
}

// ---------- 写 ----------

// UpsertProvider 新增或更新供应商。输入里的 Accounts / Builtin 被忽略（账号池单独
// 管理、Builtin 以存储现有值为准），防止前端伪造。
func (s *Store) UpsertProvider(input Provider) error {
	normalizeProvider(&input)
	if err := validateProvider(input); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.providers {
		if s.providers[i].ID == input.ID {
			input.Builtin = s.providers[i].Builtin
			input.Accounts = cloneProviders([]Provider{s.providers[i]})[0].Accounts
			s.providers[i] = input
			return s.persistLocked()
		}
	}
	input.Builtin = false
	input.Accounts = nil
	s.providers = append(s.providers, input)
	return s.persistLocked()
}

func (s *Store) DeleteProvider(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.providers {
		if s.providers[i].ID == id {
			if s.providers[i].Builtin {
				return fmt.Errorf("内置供应商不可删除：%s", id)
			}
			s.providers = append(s.providers[:i], s.providers[i+1:]...)
			return s.persistLocked()
		}
	}
	return fmt.Errorf("供应商不存在：%s", id)
}

// SetProviderEnabled 停用/启用供应商（停用只影响 hub 选号，不影响已有 profile）。
func (s *Store) SetProviderEnabled(id string, enabled bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.providers {
		if s.providers[i].ID == id {
			s.providers[i].Enabled = enabled
			return s.persistLocked()
		}
	}
	return fmt.Errorf("供应商不存在：%s", id)
}

// UpsertAccount 新增或更新某供应商下的订阅账号。
func (s *Store) UpsertAccount(providerID string, input Account) error {
	normalizeAccount(&input)
	if err := validateAccount(input); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.providers {
		if s.providers[i].ID != providerID {
			continue
		}
		for j := range s.providers[i].Accounts {
			if s.providers[i].Accounts[j].ID == input.ID {
				s.providers[i].Accounts[j] = input
				return s.persistLocked()
			}
		}
		s.providers[i].Accounts = append(s.providers[i].Accounts, input)
		return s.persistLocked()
	}
	return fmt.Errorf("供应商不存在：%s", providerID)
}

func (s *Store) DeleteAccount(providerID, accountID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.providers {
		if s.providers[i].ID != providerID {
			continue
		}
		for j := range s.providers[i].Accounts {
			if s.providers[i].Accounts[j].ID == accountID {
				s.providers[i].Accounts = append(s.providers[i].Accounts[:j], s.providers[i].Accounts[j+1:]...)
				return s.persistLocked()
			}
		}
		return fmt.Errorf("账号不存在：%s", accountID)
	}
	return fmt.Errorf("供应商不存在：%s", providerID)
}

// MoveAccount 调整账号优先级。数组顺序即选号优先级（与 Jet Hub 拖拽排序一致）。
func (s *Store) MoveAccount(providerID, accountID string, delta int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.providers {
		if s.providers[i].ID != providerID {
			continue
		}
		accounts := s.providers[i].Accounts
		for j := range accounts {
			if accounts[j].ID != accountID {
				continue
			}
			target := j + delta
			if target < 0 || target >= len(accounts) {
				return nil
			}
			accounts[j], accounts[target] = accounts[target], accounts[j]
			return s.persistLocked()
		}
		return fmt.Errorf("账号不存在：%s", accountID)
	}
	return fmt.Errorf("供应商不存在：%s", providerID)
}

// SetCredential 写入或删除（secret 为空时）一条凭据。ref 是间接引用名。
func (s *Store) SetCredential(ref, secret string) error {
	ref = strings.TrimSpace(ref)
	if !credentialRefPattern.MatchString(ref) {
		return errors.New("凭据引用名只能包含字母、数字和下划线，且以字母或下划线开头")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if strings.TrimSpace(secret) == "" {
		delete(s.credentials, ref)
	} else {
		s.credentials[ref] = secret
	}
	return s.persistLocked()
}

func (s *Store) Credential(ref string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	value, ok := s.credentials[ref]
	return value, ok
}

// CredentialRefs 返回所有已配置凭据的引用名（供 UI 展示，不含明文）。
func (s *Store) CredentialRefs() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	refs := make([]string, 0, len(s.credentials))
	for ref := range s.credentials {
		refs = append(refs, ref)
	}
	sort.Strings(refs)
	return refs
}

// ---------- 校验 ----------

func normalizeProvider(p *Provider) {
	p.ID = strings.ToLower(strings.TrimSpace(p.ID))
	p.Label = strings.TrimSpace(p.Label)
	p.BaseURL = strings.TrimRight(strings.TrimSpace(p.BaseURL), "/")
	p.ChatPath = childPath(p.ChatPath, "/chat/completions")
	p.ResponsesPath = childPath(p.ResponsesPath, "/responses")
	p.MessagesPath = childPath(p.MessagesPath, "/v1/messages")
	p.ModelsPath = childPath(p.ModelsPath, "/models")
	p.RefreshURL = strings.TrimSpace(p.RefreshURL)
	p.AuthScheme = strings.TrimSpace(p.AuthScheme)
	if p.AuthScheme == "" {
		p.AuthScheme = AuthBearer
	}
	p.APIMode = strings.TrimSpace(p.APIMode)
	p.DefaultModel = strings.TrimSpace(p.DefaultModel)
	p.CredentialRef = strings.TrimSpace(p.CredentialRef)
	p.CachedModels = normalizeModels(p.CachedModels)
}

func normalizeModels(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, m := range in {
		m = strings.TrimSpace(m)
		if m == "" || seen[m] {
			continue
		}
		seen[m] = true
		out = append(out, m)
	}
	if len(out) == 0 {
		return nil
	}
	sort.Strings(out)
	return out
}

func normalizeAccount(a *Account) {
	a.ID = strings.TrimSpace(a.ID)
	a.Nickname = strings.TrimSpace(a.Nickname)
	a.CredentialRef = strings.TrimSpace(a.CredentialRef)
	if a.CreatedAt == 0 {
		a.CreatedAt = time.Now().UnixMilli()
	}
	if a.ModelRateLimits != nil {
		cleaned := make(map[string]int64, len(a.ModelRateLimits))
		for k, v := range a.ModelRateLimits {
			if k = strings.TrimSpace(k); k != "" && v > 0 {
				cleaned[k] = v
			}
		}
		if len(cleaned) == 0 {
			a.ModelRateLimits = nil
		} else {
			a.ModelRateLimits = cleaned
		}
	}
}

func validateProvider(p Provider) error {
	if !providerIDPattern.MatchString(p.ID) {
		return errors.New("供应商 ID 只能包含小写字母、数字、连字符和下划线，长度 1–64")
	}
	if p.Label == "" || len([]rune(p.Label)) > 80 {
		return errors.New("供应商名称不能为空且不能超过 80 个字符")
	}
	if p.BaseURL != "" {
		if len(p.BaseURL) > 512 {
			return errors.New("API Base URL 过长")
		}
		parsed, err := url.Parse(p.BaseURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return errors.New("API Base URL 必须是合法的 http/https 地址")
		}
		if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return errors.New("API Base URL 不能包含用户信息、查询串或片段")
		}
	} else if p.ID != "custom" {
		return errors.New("请填写 API Base URL")
	}
	if p.RefreshURL != "" {
		parsed, err := url.Parse(p.RefreshURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return errors.New("刷新地址必须是合法的 http/https 地址")
		}
	}
	if p.CredentialRef != "" && !credentialRefPattern.MatchString(p.CredentialRef) {
		return errors.New("凭据引用名只能包含字母、数字和下划线，且以字母或下划线开头")
	}
	switch p.AuthScheme {
	case AuthBearer, AuthAPIKey, AuthNone:
	default:
		return fmt.Errorf("unsupported auth_scheme: %s", p.AuthScheme)
	}
	switch p.APIMode {
	case "", "auto", "chat_completions", "responses", "codex_responses", "anthropic_messages":
	default:
		return fmt.Errorf("unsupported api_mode: %s", p.APIMode)
	}
	return nil
}

func validateAccount(a Account) error {
	if a.ID == "" || len(a.ID) > 100 {
		return errors.New("账号 ID 不能为空且不能超过 100 个字符")
	}
	if !credentialRefPattern.MatchString(a.CredentialRef) {
		return errors.New("凭据引用名只能包含字母、数字和下划线，且以字母或下划线开头")
	}
	return nil
}
