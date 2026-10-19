package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"easy-stock/backend/internal/agent"
	"easy-stock/backend/internal/appsettings"
)

const maxModelListResponseBytes = 2 << 20

type llmModelsRequest struct {
	Provider  string  `json:"provider"`
	BaseURL   string  `json:"base_url"`
	APIKey    *string `json:"api_key"`
	ProfileID string  `json:"profile_id"`
	APIMode   string  `json:"api_mode"`
}

type llmModelOption struct {
	Metadata     json.RawMessage           `json:"-"`
	Reasoning    agent.ReasoningCapability `json:"reasoning"`
	Capabilities json.RawMessage           `json:"-"`
	ID           string                    `json:"id"`
	OwnedBy      string                    `json:"owned_by,omitempty"`
	DisplayName  string                    `json:"display_name,omitempty"`
}

type llmModelsResult struct {
	Models    []llmModelOption `json:"models"`
	SourceURL string           `json:"source_url"`
}

func (s *Server) settingsLLMModels(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input llmModelsRequest
	if err := decoder.Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid model list request: "+err.Error())
		return
	}
	if err := ensureJSONEOF(decoder); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	saved := s.settingsStore.Snapshot().LLM
	provider := strings.ToLower(firstNonEmpty(strings.TrimSpace(input.Provider), strings.TrimSpace(saved.Provider), "openai"))
	if !supportedLLMProvider(provider) {
		writeError(w, http.StatusBadRequest, "unsupported llm provider: "+provider)
		return
	}
	mode := normalizeAPIMode(input.APIMode, provider)
	if mode != "auto" && mode != "chat_completions" && mode != "codex_responses" && mode != "anthropic_messages" {
		writeError(w, http.StatusBadRequest, "unsupported api_mode")
		return
	}
	baseURL := firstNonEmpty(strings.TrimSpace(input.BaseURL), strings.TrimSpace(saved.BaseURL))
	modelsURL, err := buildModelsURL(provider, baseURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	apiKey := ""
	if input.APIKey != nil {
		apiKey = strings.TrimSpace(*input.APIKey)
	} else if s.agentGateway != nil {
		if gateway, ok := s.agentGateway.(agent.ProfileGateway); ok && strings.TrimSpace(input.ProfileID) != "" {
			apiKey, err = gateway.ModelAPIKeyForProfile(strings.TrimSpace(input.ProfileID))
		} else {
			apiKey, err = s.agentGateway.ModelAPIKey()
		}
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "读取已保存模型密钥失败")
			return
		}
	}
	if apiKey == "" && provider != "custom" {
		writeError(w, http.StatusPreconditionFailed, "请先输入或保存模型 API Key")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, modelsURL, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, "创建模型列表请求失败")
		return
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "easy-stock/model-discovery")
	if apiKey != "" {
		if provider == "anthropic" {
			request.Header.Set("x-api-key", apiKey)
			request.Header.Set("anthropic-version", "2023-06-01")
		} else {
			request.Header.Set("Authorization", "Bearer "+apiKey)
		}
	}

	client := &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	response, err := client.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			writeError(w, http.StatusGatewayTimeout, "获取模型列表超时")
			return
		}
		writeError(w, http.StatusBadGateway, "无法连接模型服务的模型列表接口")
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("模型服务返回 %s，请检查 Base URL 和 API Key", response.Status))
		return
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxModelListResponseBytes+1))
	if err != nil {
		writeError(w, http.StatusBadGateway, "读取模型列表失败")
		return
	}
	if len(body) > maxModelListResponseBytes {
		writeError(w, http.StatusBadGateway, "模型列表响应过大")
		return
	}
	models, err := decodeModelList(body)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	discovered := map[string]agent.ReasoningCapability{}
	for i := range models {
		models[i].Reasoning = agent.OfficialReasoningCapability(appsettings.LLM{Provider: provider, BaseURL: baseURL, Model: models[i].ID, APIMode: mode})
		if capability, ok := agent.DiscoveredModelReasoningCapability(mode, models[i].Metadata); ok {
			models[i].Reasoning = capability
			discovered[models[i].ID] = capability
		}
	}
	if gateway, ok := s.agentGateway.(agent.CapabilityGateway); ok {
		raw := map[string]json.RawMessage{}
		for _, model := range models {
			raw[model.ID] = model.Metadata
		}
		resolved, err := gateway.ResolveModelCapabilities(baseURL, mode, raw)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "读取模型能力失败")
			return
		}
		for i := range models {
			if c, ok := resolved[models[i].ID]; ok {
				models[i].Reasoning = c
				discovered[models[i].ID] = c
			}
		}
		if err := gateway.SyncModelCapabilities(baseURL, mode, discovered); err != nil {
			writeError(w, http.StatusInternalServerError, "模型列表已获取，但保存模型能力失败")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": llmModelsResult{Models: models, SourceURL: modelsURL}})
}

func supportedLLMProvider(provider string) bool {
	switch provider {
	case "openai", "deepseek", "qwen", "moonshot", "minimax", "zhipu", "siliconflow", "anthropic", "custom":
		return true
	default:
		return false
	}
}

func buildModelsURL(provider, rawBaseURL string) (string, error) {
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
	if provider == "anthropic" && path == "" {
		path = "/v1"
	}
	if !strings.HasSuffix(path, "/models") {
		path += "/models"
	}
	if path == "models" {
		path = "/models"
	}
	parsed.Path = path
	parsed.RawPath = ""
	return parsed.String(), nil
}

func decodeModelList(body []byte) ([]llmModelOption, error) {
	var payload struct {
		Data    []json.RawMessage `json:"data"`
		Models  []json.RawMessage `json:"models"`
		Success *bool             `json:"success"`
		Error   json.RawMessage   `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, errors.New("模型列表响应不是有效 JSON")
	}
	// Some services (including GLM's Responses endpoint) return HTTP 200 for
	// authentication failures. Never expose their raw error message or body.
	if (payload.Success != nil && !*payload.Success) || (len(payload.Error) > 0 && string(payload.Error) != "null") {
		return nil, errors.New("模型列表接口返回错误，请检查 Base URL、API Key 和模型权限")
	}
	items := payload.Data
	catalog := len(items) == 0 && payload.Models != nil
	if catalog {
		// GLM /api/v1/models returns the native Codex catalog, models[].slug,
		// rather than OpenAI's data[].id. Only the discovery format differs;
		// inference continues to use the configured URL and native protocol.
		items = payload.Models
	}
	seen := make(map[string]struct{}, len(items))
	models := make([]llmModelOption, 0, len(items))
	for _, metadata := range items {
		var item struct {
			ID             string          `json:"id"`
			Slug           string          `json:"slug"`
			OwnedBy        string          `json:"owned_by"`
			DisplayName    string          `json:"display_name"`
			Capabilities   json.RawMessage `json:"capabilities"`
			SupportedInAPI *bool           `json:"supported_in_api"`
		}
		if err := json.Unmarshal(metadata, &item); err != nil {
			return nil, errors.New("模型列表条目格式无效")
		}
		id := strings.TrimSpace(item.ID)
		if catalog {
			if item.SupportedInAPI != nil && !*item.SupportedInAPI {
				continue
			}
			id = strings.TrimSpace(item.Slug)
		}
		if id == "" || len(id) > 256 {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		models = append(models, llmModelOption{Metadata: metadata, ID: id, Capabilities: item.Capabilities, OwnedBy: strings.TrimSpace(item.OwnedBy), DisplayName: strings.TrimSpace(item.DisplayName)})
	}
	if len(models) == 0 {
		return nil, errors.New("模型服务未返回可用模型列表；可手动输入模型 ID 并测试连接")
	}
	sort.Slice(models, func(i, j int) bool {
		return strings.ToLower(models[i].ID) < strings.ToLower(models[j].ID)
	})
	return models, nil
}
