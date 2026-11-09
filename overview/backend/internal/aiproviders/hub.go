package aiproviders

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Hub 是本机 OpenAI 兼容反向代理：把「provider/model」格式的请求按账号池
// 选号、换号重试、计费后转发到注册表里保存的真实上游地址。
// 设计对齐 Jet Hub 的 openai-gateway：
//   - model 必须是 "<provider>/<model>"（parseModelRoute 语义）；
//   - 只对「尚未向客户端写任何字节」的失败换号，已产出的流绝不重放；
//   - 401/403 换号但不写限流标记，429 换号且写 modelRateLimits，5xx/网络换号。
//
// 监听地址由挂载方决定；默认只应绑定 127.0.0.1（与 DSH 网关一致，
// 宿主显式拒绝 0.0.0.0 / ::）。
type Hub struct {
	store  *Store
	apiKey string
	client *http.Client
}

// HubStatus 是给设置页看的网关状态（不含 key 明文）。
type HubStatus struct {
	Enabled     bool     `json:"enabled"`
	Listen      string   `json:"listen,omitempty"`
	APIKeyRef   string   `json:"api_key_ref,omitempty"`
	ModelRoutes []string `json:"model_routes,omitempty"`
}

// LoadOrCreateAPIKey 读取（或生成）网关自身对外的 Bearer Key，0600 落盘。
// 生成形态与 Jet Hub 一致：43 字符 base64url(32 bytes)。已有内容不符合形态
// 时直接报错，不静默更换，避免已配置好的客户端全部失效。
func LoadOrCreateAPIKey(path string) (string, error) {
	if env := strings.TrimSpace(os.Getenv("A_STOCK_AI_HUB_API_KEY")); env != "" {
		return env, nil
	}
	data, err := os.ReadFile(path)
	if err == nil {
		key := strings.TrimSpace(string(data))
		if len(key) != 43 {
			return "", fmt.Errorf("网关 API Key 形态异常（应为 43 字符）：%s", path)
		}
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	key := base64.RawURLEncoding.EncodeToString(buf)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(key+"\n"), 0o600); err != nil {
		return "", err
	}
	return key, nil
}

// NewHub 构造网关。apiKey 为空表示不校验调用方（仅供进程内嵌调用）。
func NewHub(store *Store, apiKey string, client *http.Client) *Hub {
	if client == nil {
		client = &http.Client{
			Timeout: 0, // 流式请求不设整体超时，由 ctx 控制
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	return &Hub{store: store, apiKey: strings.TrimSpace(apiKey), client: client}
}

// APIKey 返回网关对外 Key（供设置页展示；调用方自行决定是否掩码）。
func (h *Hub) APIKey() string { return h.apiKey }

// Status 返回网关状态与当前可用模型路由示例。
func (h *Hub) Status(listen string) HubStatus {
	routes := make([]string, 0, 16)
	for _, p := range h.store.List() {
		if !p.Enabled {
			continue
		}
		for _, m := range p.CachedModels {
			routes = append(routes, p.ID+"/"+m)
			if len(routes) >= 16 {
				break
			}
		}
		if len(routes) >= 16 {
			break
		}
	}
	return HubStatus{Enabled: true, Listen: listen, ModelRoutes: routes}
}

// Handler 返回实现 /v1/models、/v1/chat/completions、/v1/responses、
// /v1/messages 的 http.Handler。所有请求都要求 Authorization: Bearer <apiKey>
// （当 apiKey 非空时）。
func (h *Hub) Handler() http.Handler {
	return http.HandlerFunc(h.serve)
}

func (h *Hub) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if h.apiKey != "" && r.Header.Get("Authorization") != "Bearer "+h.apiKey {
		writeHubError(w, http.StatusUnauthorized, "Missing or invalid API key", "invalid_api_key")
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/v1/models":
		h.writeModels(w)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/chat/completions":
		h.proxy(w, r, "chat_completions")
	case r.Method == http.MethodPost && r.URL.Path == "/v1/responses":
		h.proxy(w, r, "responses")
	case r.Method == http.MethodPost && r.URL.Path == "/v1/messages":
		h.proxy(w, r, "anthropic_messages")
	default:
		writeHubError(w, http.StatusNotFound, "Unknown endpoint", "not_found")
	}
}

func (h *Hub) writeModels(w http.ResponseWriter) {
	type modelItem struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		OwnedBy string `json:"owned_by"`
	}
	items := []modelItem{}
	for _, p := range h.store.List() {
		if !p.Enabled {
			continue
		}
		for _, m := range p.CachedModels {
			items = append(items, modelItem{ID: p.ID + "/" + m, Object: "model", OwnedBy: p.ID})
		}
		if len(p.CachedModels) == 0 && p.DefaultModel != "" {
			items = append(items, modelItem{ID: p.ID + "/" + p.DefaultModel, Object: "model", OwnedBy: p.ID})
		}
	}
	writeHubJSON(w, http.StatusOK, map[string]any{"object": "list", "data": items})
}

func (h *Hub) proxy(w http.ResponseWriter, r *http.Request, protocol string) {
	if !strings.Contains(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		writeHubError(w, http.StatusUnsupportedMediaType, "Content-Type must be application/json", "invalid_content_type")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		writeHubError(w, http.StatusBadRequest, err.Error(), "invalid_request")
		return
	}
	var envelope map[string]any
	if err := json.Unmarshal(body, &envelope); err != nil {
		writeHubError(w, http.StatusBadRequest, err.Error(), "invalid_request")
		return
	}
	routeRaw, _ := envelope["model"].(string)
	providerID, modelID, err := ParseModelRoute(routeRaw)
	if err != nil {
		writeHubError(w, http.StatusBadRequest, err.Error(), "invalid_request")
		return
	}
	// 转发给上游时用不带前缀的真实模型 id。
	envelope["model"] = modelID
	body, err = json.Marshal(envelope)
	if err != nil {
		writeHubError(w, http.StatusBadRequest, err.Error(), "invalid_request")
		return
	}
	p, ok := h.store.Get(providerID)
	if !ok || !p.Enabled {
		writeHubError(w, http.StatusNotFound, "unknown provider: "+providerID, "unknown_provider")
		return
	}

	tried := map[string]bool{}
	var lastStatus int
	var lastMessage string
	for attempt := 0; attempt < 8; attempt++ {
		selected, err := h.store.Select(providerID, modelID, tried)
		if err != nil {
			if lastStatus != 0 {
				writeHubError(w, lastStatus, lastMessage, "upstream_error")
			} else {
				writeHubError(w, http.StatusServiceUnavailable, err.Error(), "no_account")
			}
			return
		}
		accountID := ""
		if selected.Account != nil {
			accountID = selected.Account.ID
			tried[accountID] = true
		} else {
			// 单 Key 型没有第二个候选，失败即返回。
			tried["__provider_key__"] = true
		}

		status, message, streamed, tokens := h.forward(w, r, selected, protocol, body, modelID)
		if streamed {
			// 已经开始向客户端输出，不能换号重放。
			h.store.RecordUsage(providerID, accountID, modelID, tokens, 0, status >= 400)
			return
		}
		lastStatus, lastMessage = status, message
		kind := ClassifyStatus(status)
		if kind == "ok" || kind == "invalid_request" {
			h.store.RecordUsage(providerID, accountID, modelID, tokens, 0, status >= 400)
			return
		}
		if kind == "rate_limit" && selected.Account != nil {
			_ = h.store.MarkRateLimited(providerID, accountID, modelID, h.store.Now()+DefaultRateLimitCooldown)
		}
		if !ShouldRotate(kind) || selected.Account == nil {
			h.store.RecordUsage(providerID, accountID, modelID, tokens, 0, true)
			writeHubError(w, status, message, "upstream_error")
			return
		}
		h.store.RecordUsage(providerID, accountID, modelID, tokens, 0, true)
	}
	writeHubError(w, lastStatus, "所有订阅账号均不可用："+lastMessage, "accounts_exhausted")
}

// forward 发起一次上游请求并把响应写给客户端。streamed=true 表示已经写了字节。
func (h *Hub) forward(w http.ResponseWriter, r *http.Request, selected Selected, protocol string, body []byte, modelID string) (status int, message string, streamed bool, outputTokens int64) {
	target, err := h.upstreamURL(selected.Provider, protocol)
	if err != nil {
		return http.StatusBadGateway, err.Error(), false, 0
	}
	ctx := r.Context()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return http.StatusBadGateway, err.Error(), false, 0
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", r.Header.Get("Accept"))
	if req.Header.Get("Accept") == "" {
		req.Header.Set("Accept", "application/json")
	}
	for k, v := range h.store.AuthHeaders(selected.Provider.ID, selected.Key) {
		req.Header.Set(k, v)
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return 0, err.Error(), false, 0
	}
	defer resp.Body.Close()

	// 复制上游响应头（去掉 hop-by-hop 与 content-length，交给 net/http 重算）。
	for k, values := range resp.Header {
		lower := strings.ToLower(k)
		if lower == "content-length" || lower == "transfer-encoding" || lower == "connection" {
			continue
		}
		for _, v := range values {
			w.Header().Add(k, v)
		}
	}
	status = resp.StatusCode

	// 失败且尚未写字节时读回一小段错误信息，供换号/上报使用。
	if status >= 400 {
		preview, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return status, strings.TrimSpace(string(preview)), false, 0
	}

	w.WriteHeader(status)
	streamed = true
	buf := make([]byte, 32<<10)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if _, writeErr := w.Write(chunk); writeErr != nil {
				break
			}
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			outputTokens += int64(bytes.Count(chunk, []byte("\"content\"")))
		}
		if readErr != nil {
			break
		}
	}
	return status, "", true, outputTokens
}

func (h *Hub) upstreamURL(p Provider, protocol string) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(p.BaseURL), "/")
	if base == "" {
		return "", fmt.Errorf("供应商 %s 未配置 API Base URL", p.ID)
	}
	path := ""
	switch protocol {
	case "responses":
		path = childPath(p.ResponsesPath, "/responses")
	case "anthropic_messages":
		path = childPath(p.MessagesPath, "/v1/messages")
	default:
		path = childPath(p.ChatPath, "/chat/completions")
	}
	// BaseURL 在 validateProvider 里已保证是合法 http/https 且无 query/fragment，
	// 这里只需拼上协议子路径。
	return strings.TrimRight(base, "/") + path, nil
}

// ParseModelRoute 把 "provider/model" 拆开。model 允许自带斜杠
// （如七牛云的 deepseek-ai/DeepSeek-V4.1-Flash），因此只切第一个斜杠。
func ParseModelRoute(value string) (providerID, modelID string, err error) {
	value = strings.TrimSpace(value)
	slash := strings.Index(value, "/")
	if slash <= 0 || slash == len(value)-1 {
		return "", "", errors.New("model must use provider/model format")
	}
	return strings.ToLower(value[:slash]), value[slash+1:], nil
}

func writeHubJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeHubError(w http.ResponseWriter, status int, message, code string) {
	if status < 400 {
		status = http.StatusBadRequest
	}
	writeHubJSON(w, status, map[string]any{
		"error": map[string]any{"message": message, "type": "hub_error", "code": code},
	})
}

// HubListenAddr 返回默认监听地址。显式拒绝非回环地址，与 DSH 网关一致。
func HubListenAddr(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "127.0.0.1:8327", nil
	}
	host := value
	if idx := strings.LastIndex(value, ":"); idx >= 0 {
		host = value[:idx]
	}
	host = strings.Trim(host, "[]")
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return "", fmt.Errorf("网关只允许绑定回环地址，收到：%s", value)
	}
	return value, nil
}

// StartHub 在独立端口启动网关（只绑回环）。返回的 *http.Server 供调用方关闭。
func StartHub(h *Hub, addr string) (*http.Server, error) {
	resolved, err := HubListenAddr(addr)
	if err != nil {
		return nil, err
	}
	srv := &http.Server{
		Addr:              resolved,
		Handler:           h.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() { _ = srv.ListenAndServe() }()
	return srv, nil
}
