package httpapi

import (
	"errors"
	"strings"

	"easy-stock/backend/internal/aiproviders"
	"easy-stock/backend/internal/appsettings"
)

// codeArtsHubBaseURL 是服务器进程访问本机网关的地址。这里的 127.0.0.1
// 只在服务器内部使用，浏览器不会直接请求它。
func (s *Server) codeArtsHubBaseURL() (string, error) {
	if s.aiHub == nil || strings.TrimSpace(s.aiHubListen) == "" {
		return "", errors.New("CodeArts 本机网关未启用")
	}
	if strings.TrimSpace(s.aiHub.APIKey()) == "" {
		return "", errors.New("CodeArts 网关 API Key 未配置")
	}
	return "http://" + strings.TrimSpace(s.aiHubListen) + "/v1", nil
}

func codeArtsModelRoute(model string) string {
	model = strings.TrimSpace(model)
	if model == "" || strings.HasPrefix(model, aiproviders.ProviderCodeArts+"/") {
		return model
	}
	return aiproviders.ProviderCodeArts + "/" + model
}

// applyCodeArtsLLM 把登录型供应商规范成 OpenAI 兼容的本机网关配置，并把
// 网关密钥直接注入 Hermes 的 profile key 存储。前端不需要知道网关明文 key，
// 设置 JSON 里也仍然只保存 configured 状态，不保存密钥。
func (s *Server) applyCodeArtsLLM(values *appsettings.Values, profileKeyUpdates map[string]*string) (*string, error) {
	needed := values.LLM.Provider == aiproviders.ProviderCodeArts
	for _, profile := range values.LLMProfiles {
		if profile.Provider == aiproviders.ProviderCodeArts {
			needed = true
			break
		}
	}
	if !needed {
		return nil, nil
	}
	baseURL, err := s.codeArtsHubBaseURL()
	if err != nil {
		return nil, err
	}
	hubKey := strings.TrimSpace(s.aiHub.APIKey())
	for i := range values.LLMProfiles {
		profile := &values.LLMProfiles[i]
		if profile.Provider != aiproviders.ProviderCodeArts {
			continue
		}
		profile.BaseURL = baseURL
		profile.APIMode = "chat_completions"
		profile.Model = codeArtsModelRoute(profile.Model)
		profile.APIKeyConfigured = true
		keyCopy := hubKey
		profileKeyUpdates[profile.ID] = &keyCopy
	}
	if values.LLM.Provider == aiproviders.ProviderCodeArts {
		values.LLM.BaseURL = baseURL
		values.LLM.APIMode = "chat_completions"
		values.LLM.Model = codeArtsModelRoute(values.LLM.Model)
		keyCopy := hubKey
		return &keyCopy, nil
	}
	return nil, nil
}
