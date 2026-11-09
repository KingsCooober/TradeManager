package httpapi

import (
	"net/http"
	"strings"
)

func (s *Server) withCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
	}
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-A-Stock-Token, X-Request-ID")
	w.Header().Set("Access-Control-Expose-Headers", "X-Request-ID")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
}

func (s *Server) authorized(r *http.Request) bool {
	if s.token == "" || r.URL.Path == "/api/health" || r.Method == http.MethodOptions {
		return true
	}
	// 服务器登录回调：浏览器从华为云 302 顶层导航过来，带的是交易台 cookie 而非
	// X-A-Stock-Token / Authorization 头，全局 token 鉴权不适用。安全性由 handler 里的
	// 一次性 ticket_id 校验兜底（构造登录 URL 时生成的 64 位随机串）。
	// 路径尾部带 /{accountId}/{ticketID} 两段，用前缀匹配。
	if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/v1/settings/llm/login/callback") {
		return true
	}
	if r.URL.Query().Get("token") == s.token {
		return true
	}
	if r.Header.Get("X-A-Stock-Token") == s.token {
		return true
	}
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(auth, "Bearer ") && strings.TrimSpace(strings.TrimPrefix(auth, "Bearer ")) == s.token {
		return true
	}
	return false
}
