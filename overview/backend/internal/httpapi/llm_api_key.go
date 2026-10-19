package httpapi

import (
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strings"

	"easy-stock/backend/internal/agent"
)

// Only this explicit reveal action returns a model credential. Ordinary
// settings responses continue to expose configured/masked status only.
func (s *Server) settingsLLMAPIKeyReveal(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	// Production requests already pass the backend token check. In tokenless
	// local development, don't expose credentials to arbitrary browser origins
	// or hosts through the otherwise permissive development CORS policy.
	if s.token == "" && !localSecretRequest(r) {
		writeError(w, http.StatusForbidden, "查看密钥需要本机页面或后端访问令牌")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input struct {
		ProfileID string `json:"profile_id"`
	}
	if err := decoder.Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "无效的密钥查看请求")
		return
	}
	if err := ensureJSONEOF(decoder); err != nil {
		writeError(w, http.StatusBadRequest, "无效的密钥查看请求")
		return
	}
	profileID := strings.TrimSpace(input.ProfileID)
	if profileID == "" {
		writeError(w, http.StatusBadRequest, "请选择模型配置")
		return
	}
	saved := s.settingsStore.Snapshot()
	if _, ok := findLLMProfile(saved.LLMProfiles, profileID); !ok {
		writeError(w, http.StatusNotFound, "模型配置尚未保存或已被删除")
		return
	}
	if s.agentGateway == nil {
		writeError(w, http.StatusServiceUnavailable, "暂时无法读取模型密钥")
		return
	}
	var key string
	var err error
	if gateway, ok := s.agentGateway.(agent.ProfileGateway); ok {
		key, err = gateway.ModelAPIKeyForProfile(profileID)
	} else if profileID == saved.ActiveLLMProfileID {
		key, err = s.agentGateway.ModelAPIKey()
	} else {
		writeError(w, http.StatusServiceUnavailable, "当前运行时无法读取此模型配置的密钥")
		return
	}
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "读取已保存模型密钥失败")
		return
	}
	if strings.TrimSpace(key) == "" {
		writeError(w, http.StatusNotFound, "此模型配置未保存 API Key")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]string{"api_key": key}})
}

func localSecretRequest(r *http.Request) bool {
	isLoopback := func(host string) bool {
		return host == "localhost" || net.ParseIP(host).IsLoopback()
	}
	peer, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || !isLoopback(peer) {
		return false
	}
	host := r.Host
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		host = parsedHost
	}
	if !isLoopback(host) {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || !isLoopback(parsed.Hostname()) {
			return false
		}
	}
	return true
}
