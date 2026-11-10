package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"strings"
	"time"

	"easy-stock/backend/internal/aiproviders"
)

// providerAllowSet 把运行时注册表（内置 10 家 + 用户自定义供应商）转成
// validateSingleLLM 使用的白名单。空 provider 永远允许（回落 openai）。
func (s *Server) providerAllowSet() map[string]bool {
	allowed := map[string]bool{
		"": true, "openai": true, "deepseek": true, "qwen": true, "moonshot": true,
		"minimax": true, "zhipu": true, "siliconflow": true, "anthropic": true,
		"custom": true, "xiaomi": true,
	}
	if s.aiProviders != nil {
		for _, p := range s.aiProviders.List() {
			allowed[p.ID] = true
		}
	}
	return allowed
}

// providerSupported 模型发现时判断 provider 是否可用：静态内置 + 运行时注册表。
func (s *Server) providerSupported(provider string) bool {
	return s.providerAllowSet()[strings.ToLower(strings.TrimSpace(provider))]
}

// modelsURLFor 兼容既有 buildModelsURL 的语义，同时允许用户自定义供应商
// 通过注册表里的 models_path 指定非 /models 的模型发现端点。
func (s *Server) modelsURLFor(provider, rawBaseURL string) (string, error) {
	if s.aiProviders == nil {
		return buildModelsURL(provider, rawBaseURL)
	}
	p, ok := s.aiProviders.Get(provider)
	if !ok || p.Builtin {
		// 内置供应商保持原有 URL 规则，避免改变既有行为。
		return buildModelsURL(provider, rawBaseURL)
	}
	modelsPath := strings.TrimSpace(p.ModelsPath)
	if modelsPath == "" || modelsPath == "/models" {
		return buildModelsURL(provider, rawBaseURL)
	}
	return buildModelsURLWithPath(rawBaseURL, modelsPath)
}

// buildModelsURLWithPath 用自定义尾部路径拼模型列表 URL，校验规则与
// buildModelsURL 一致（http/https、无 user/query/fragment），且不重复追加 /models。
func buildModelsURLWithPath(rawBaseURL, modelsPath string) (string, error) {
	if rawBaseURL == "" {
		return "", errors.New("llm base_url is required")
	}
	if len(rawBaseURL) > 512 {
		return "", errors.New("llm base_url is too long")
	}
	parsed, err := url.Parse(rawBaseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", errors.New("llm base_url must be an http or https URL")
	}
	if parsed.User != nil {
		return "", errors.New("llm base_url must not contain user information")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("llm base_url must not contain a query or fragment")
	}
	path := strings.TrimRight(parsed.Path, "/")
	custom := "/" + strings.Trim(modelsPath, "/")
	if strings.HasSuffix(path, custom) {
		parsed.Path = path
	} else {
		parsed.Path = path + custom
	}
	parsed.RawPath = ""
	return parsed.String(), nil
}

func (s *Server) requireAIProviders(w http.ResponseWriter) bool {
	if s.aiProviders == nil {
		writeError(w, http.StatusServiceUnavailable, "AI 供应商注册表不可用")
		return false
	}
	return true
}

func decodeAIProviderJSON(w http.ResponseWriter, r *http.Request, dst any, limit int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request: "+err.Error())
		return false
	}
	if err := ensureJSONEOF(decoder); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return false
	}
	return true
}

// GET /api/v1/settings/llm/providers
// 返回注册表（含账号池，但绝不含任何明文凭据）。
func (s *Server) aiProvidersList(w http.ResponseWriter, r *http.Request) {
	if !s.requireAIProviders(w) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{
			"providers":       s.aiProviders.List(),
			"credential_refs": s.aiProviders.CredentialRefs(),
		},
	})
}

// PUT /api/v1/settings/llm/providers —— 新增或更新一个供应商。
func (s *Server) aiProvidersUpsert(w http.ResponseWriter, r *http.Request) {
	if !s.requireAIProviders(w) {
		return
	}
	var input aiproviders.Provider
	if !decodeAIProviderJSON(w, r, &input, 64<<10) {
		return
	}
	if err := s.aiProviders.UpsertProvider(input); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"providers": s.aiProviders.List()}})
}

// DELETE /api/v1/settings/llm/providers —— 删除自定义供应商（内置不可删）。
func (s *Server) aiProvidersDelete(w http.ResponseWriter, r *http.Request) {
	if !s.requireAIProviders(w) {
		return
	}
	var input struct {
		ID string `json:"id"`
	}
	if !decodeAIProviderJSON(w, r, &input, 8<<10) {
		return
	}
	if err := s.aiProviders.DeleteProvider(input.ID); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"providers": s.aiProviders.List()}})
}

// POST /api/v1/settings/llm/providers/account
// action: upsert / delete / move / toggle
func (s *Server) aiProvidersAccount(w http.ResponseWriter, r *http.Request) {
	if !s.requireAIProviders(w) {
		return
	}
	var input struct {
		ProviderID string             `json:"provider_id"`
		Action     string             `json:"action"`
		Account    aiproviders.Account `json:"account"`
		Delta      int                `json:"delta"`
	}
	if !decodeAIProviderJSON(w, r, &input, 32<<10) {
		return
	}
	providerID := strings.ToLower(strings.TrimSpace(input.ProviderID))
	var err error
	switch input.Action {
	case "upsert":
		err = s.aiProviders.UpsertAccount(providerID, input.Account)
	case "delete":
		err = s.aiProviders.DeleteAccount(providerID, input.Account.ID)
	case "move":
		err = s.aiProviders.MoveAccount(providerID, input.Account.ID, input.Delta)
	case "toggle":
		p, ok := s.aiProviders.Get(providerID)
		if !ok {
			err = fmt.Errorf("供应商不存在：%s", providerID)
			break
		}
		found := false
		for _, a := range p.Accounts {
			if a.ID == input.Account.ID {
				a.Enabled = input.Account.Enabled
				err = s.aiProviders.UpsertAccount(providerID, a)
				found = true
				break
			}
		}
		if !found {
			err = fmt.Errorf("账号不存在：%s", input.Account.ID)
		}
	default:
		err = fmt.Errorf("unsupported account action: %s", input.Action)
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"providers": s.aiProviders.List()}})
}

// POST /api/v1/settings/llm/providers/credential
// 明文 secret 只在这一次请求里出现，写入独立 0600 凭据库；列表接口永不返回。
func (s *Server) aiProvidersCredential(w http.ResponseWriter, r *http.Request) {
	if !s.requireAIProviders(w) {
		return
	}
	var input struct {
		CredentialRef string `json:"credential_ref"`
		Secret        string `json:"secret"`
		Clear         bool   `json:"clear"`
	}
	if !decodeAIProviderJSON(w, r, &input, 64<<10) {
		return
	}
	secret := input.Secret
	if input.Clear {
		secret = ""
	}
	if len(secret) > 64<<10 {
		writeError(w, http.StatusBadRequest, "secret value is too long")
		return
	}
	if err := s.aiProviders.SetCredential(input.CredentialRef, secret); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"credential_refs": s.aiProviders.CredentialRefs()}})
}

// GET /api/v1/settings/llm/providers/usage —— 最近 7 天按账号/模型计费。
func (s *Server) aiProvidersUsage(w http.ResponseWriter, r *http.Request) {
	if !s.requireAIProviders(w) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"days": s.aiProviders.UsageSnapshot(7)}})
}

// GET|POST /api/v1/settings/llm/providers/refresh —— 续期计划 / 立即续期。
func (s *Server) aiProvidersRefresh(w http.ResponseWriter, r *http.Request) {
	if !s.requireAIProviders(w) {
		return
	}
	if r.Method == http.MethodPost {
		results := s.aiProviders.RefreshDue(r.Context(), s.reviewHTTPClient())
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"results": results, "plans": s.aiProviders.RefreshPlans()}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"plans": s.aiProviders.RefreshPlans()}})
}

func (s *Server) reviewHTTPClient() *http.Client {
	return &http.Client{Timeout: 30 * time.Second}
}

// GET /api/v1/settings/llm/hub —— 本机 OpenAI 兼容网关状态（Key 掩码）。
func (s *Server) aiHubStatus(w http.ResponseWriter, r *http.Request) {
	if !s.requireAIProviders(w) {
		return
	}
	if s.aiHub == nil {
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"enabled": false}})
		return
	}
	status := s.aiHub.Status(s.aiHubListen)
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{
			"enabled":       status.Enabled && s.aiHubListen != "",
			"listen":        status.Listen,
			"model_routes":  status.ModelRoutes,
			"api_key_masked": maskHubAPIKey(s.aiHub.APIKey()),
		},
	})
}

func maskHubAPIKey(key string) string {
	if key == "" {
		return ""
	}
	if len(key) <= 10 {
		return "••••"
	}
	return key[:6] + "••••" + key[len(key)-4:]
}

func (s *Server) requireAILogin(w http.ResponseWriter) bool {
	if s.aiLogin == nil {
		writeError(w, http.StatusServiceUnavailable, "登录服务不可用")
		return false
	}
	return true
}

// POST /api/v1/settings/llm/login/start —— 两步式登录第一步：写占位账号并立刻返回授权链接。
// callbackBase 由前端按当前站点地址算出（服务器公网回调端点绝对 URL）；带上它走旧式
// ticket 模式，让华为云授权后浏览器 302 回跳到服务器，而不是访客本机 127.0.0.1。
func (s *Server) aiLoginStart(w http.ResponseWriter, r *http.Request) {
	if !s.requireAIProviders(w) || !s.requireAILogin(w) {
		return
	}
	var input struct {
		Provider     string `json:"provider"`
		CallbackBase string `json:"callbackBase"`
	}
	if !decodeAIProviderJSON(w, r, &input, 16<<10) {
		return
	}
	providerID := strings.ToLower(strings.TrimSpace(input.Provider))
	if providerID == "" {
		providerID = aiproviders.ProviderCodeArts
	}
	// 服务端再兜一层：忽略 127.0.0.1/localhost 的回调基址（那是访客本机，不是服务器）。
	// 前端同源部署时给的是当前站点 origin，正常为公网域名；本地开发同源时允许本机。
	callbackBase := strings.TrimSpace(input.CallbackBase)
	result, err := s.aiLogin.StartLogin(providerID, callbackBase)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if s.logger != nil {
		s.logger.Printf("level=info event=ai_login_start provider=%q mode=%q account_id=%q has_callback_base=%t", providerID, result.Mode, result.AccountID, callbackBase != "")
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}

// GET /api/v1/settings/llm/login/poll?accountId=... —— 两步式登录第二步：轮询凭据是否落库。
func (s *Server) aiLoginPoll(w http.ResponseWriter, r *http.Request) {
	if !s.requireAILogin(w) {
		return
	}
	accountID := strings.TrimSpace(r.URL.Query().Get("accountId"))
	if accountID == "" {
		writeError(w, http.StatusBadRequest, "accountId 必填")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": s.aiLogin.Poll(accountID)})
}

// POST /api/v1/settings/llm/login/code —— 远程部署时手动回填授权 code 兜底。
func (s *Server) aiLoginCode(w http.ResponseWriter, r *http.Request) {
	if !s.requireAILogin(w) {
		return
	}
	var input struct {
		AccountID string `json:"accountId"`
		Code      string `json:"code"`
	}
	if !decodeAIProviderJSON(w, r, &input, 16<<10) {
		return
	}
	if err := s.aiLogin.SubmitCode(input.AccountID, input.Code); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"submitted": true}})
}

// GET /api/v1/settings/llm/login/callback/{accountId}/{ticketID}?secret=...&code=...
// 公网部署时华为云 doer/redirect 授权完成后把浏览器 302 回跳到这里（服务器地址，不是
// 127.0.0.1）。这是顶层导航、带不了 X-A-Stock-Token 头，故在 authorized() 里单独放行，
// 由一次性 ticket_id 校验兜底。把 code/secret 交回会话后，凭据换取全在服务器后台完成。
func (s *Server) aiLoginCallback(w http.ResponseWriter, r *http.Request) {
	if !s.requireAILogin(w) {
		return
	}
	accountID := r.PathValue("accountId")
	ticketID := r.PathValue("ticketID")
	q := r.URL.Query()
	code := strings.TrimSpace(q.Get("code"))
	secret := strings.TrimSpace(q.Get("secret"))
	if s.logger != nil {
		s.logger.Printf("level=info event=ai_login_callback account_id=%q has_code=%t has_secret=%t", accountID, code != "", secret != "")
	}
	err := s.aiLogin.SubmitServerCallback(accountID, ticketID, code, secret)
	if err != nil && s.logger != nil {
		s.logger.Printf("level=warn event=ai_login_callback_failed account_id=%q error=%q", accountID, err.Error())
	}
	title, msg, hint := "登录完成", "授权已提交给服务器，凭据正在后台写入。", "可以关闭本页，回到「AI 供应商与订阅账号」设置页查看账号与模型。"
	if err != nil {
		title = "登录未完成"
		msg = html.EscapeString(err.Error())
		hint = "请回到设置页重新点击「登录账号」再试一次。"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = fmt.Fprintf(w, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>%s</title><style>body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:#0d1117;color:#e6edf3;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center}.card{max-width:460px;padding:36px;border-radius:14px;background:#161b22;border:1px solid #30363d;text-align:center}h1{font-size:20px;margin:0 0 14px}p{font-size:14px;line-height:1.7;color:#8b949e;margin:8px 0}</style></head><body><div class="card"><h1>%s</h1><p>%s</p><p>%s</p></div></body></html>`, title, title, html.EscapeString(msg), html.EscapeString(hint))
}

func (s *Server) aiProviderModelsData(providerID string) map[string]any {
	return map[string]any{"models": s.aiProviders.ProviderModels(providerID), "enabled": s.aiProviders.EnabledModelIDs(providerID)}
}

// GET /api/v1/settings/llm/models?provider=codearts —— 全量目录 + 每行 disabled 标记。
func (s *Server) aiProviderModels(w http.ResponseWriter, r *http.Request) {
	if !s.requireAIProviders(w) {
		return
	}
	providerID := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("provider")))
	if providerID == "" {
		providerID = aiproviders.ProviderCodeArts
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": s.aiProviderModelsData(providerID)})
}

// POST /api/v1/settings/llm/models/disabled —— 单个模型启用/禁用（黑名单制）。
func (s *Server) aiProviderModelsDisabled(w http.ResponseWriter, r *http.Request) {
	if !s.requireAIProviders(w) {
		return
	}
	var input struct {
		Provider string `json:"provider"`
		ModelID  string `json:"modelId"`
		Disabled bool   `json:"disabled"`
	}
	if !decodeAIProviderJSON(w, r, &input, 16<<10) {
		return
	}
	providerID := strings.ToLower(strings.TrimSpace(input.Provider))
	if providerID == "" {
		providerID = aiproviders.ProviderCodeArts
	}
	if err := s.aiProviders.SetModelDisabled(providerID, input.ModelID, input.Disabled); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": s.aiProviderModelsData(providerID)})
}

// POST /api/v1/settings/llm/models/all —— 全开/全关目录里的所有模型。
func (s *Server) aiProviderModelsAll(w http.ResponseWriter, r *http.Request) {
	if !s.requireAIProviders(w) {
		return
	}
	var input struct {
		Provider string `json:"provider"`
		Disabled bool   `json:"disabled"`
	}
	if !decodeAIProviderJSON(w, r, &input, 8<<10) {
		return
	}
	providerID := strings.ToLower(strings.TrimSpace(input.Provider))
	if providerID == "" {
		providerID = aiproviders.ProviderCodeArts
	}
	if err := s.aiProviders.SetAllModelsDisabled(providerID, input.Disabled); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": s.aiProviderModelsData(providerID)})
}

// POST /api/v1/settings/llm/models/refresh —— 用账号凭据拉一次 CodeArts 私有模型目录。
func (s *Server) aiProviderModelsRefresh(w http.ResponseWriter, r *http.Request) {
	if !s.requireAIProviders(w) {
		return
	}
	var input struct {
		Provider string `json:"provider"`
	}
	if !decodeAIProviderJSON(w, r, &input, 8<<10) {
		return
	}
	providerID := strings.ToLower(strings.TrimSpace(input.Provider))
	if providerID == "" {
		providerID = aiproviders.ProviderCodeArts
	}
	p, ok := s.aiProviders.Get(providerID)
	if !ok {
		writeError(w, http.StatusBadRequest, "供应商不存在："+providerID)
		return
	}
	// 找一个可用账号的明文凭据（catalog 拉取与具体模型无关，不经过 Select 的限流过滤）。
	secret := ""
	if key, exists := s.aiProviders.Credential(p.CredentialRef); exists {
		secret = key
	}
	if secret == "" {
		for _, a := range p.Accounts {
			if !a.Enabled {
				continue
			}
			if key, exists := s.aiProviders.Credential(a.CredentialRef); exists && strings.TrimSpace(key) != "" {
				secret = key
				break
			}
		}
	}
	if secret == "" {
		writeError(w, http.StatusPreconditionFailed, "请先登录 CodeArts 账号后再刷新模型目录")
		return
	}
	if p.LoginType != aiproviders.LoginTypeCodeArts {
		writeError(w, http.StatusBadRequest, "该供应商没有私有模型目录")
		return
	}
	cred, err := aiproviders.ParseCodeArtsCredential(secret)
	if err != nil {
		writeError(w, http.StatusBadRequest, "账号凭据格式无效："+err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	models, complete := aiproviders.FetchCodeArtsModels(ctx, s.reviewHTTPClient(), cred)
	if len(models) > 0 {
		_ = s.aiProviders.SetProviderCatalog(providerID, models)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": s.aiProviderModelsData(providerID), "complete": complete})
}
