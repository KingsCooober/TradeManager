package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"easy-stock/backend/internal/appsettings"
)

var ErrProtocolUnconfirmed = errors.New("模型 Responses 能力尚未确认")

// ProbeResponses sends a native, tiny Responses request to the exact endpoint,
// model and credential. It never translates chat/messages, proxies generation,
// or treats auth/network errors as proof of protocol incompatibility.
func ProbeResponses(ctx context.Context, cfg appsettings.LLM, key string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	payload, _ := json.Marshal(map[string]any{"model": cfg.Model, "store": false, "stream": true,
		"input": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": "Reply OK."}}}}})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(cfg.BaseURL, "/")+"/responses", bytes.NewReader(payload))
	if err != nil {
		return false, fmt.Errorf("%w：模型地址无效", ErrProtocolUnconfirmed)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return false, fmt.Errorf("%w：无法连接模型服务，请检查地址、网络或超时", ErrProtocolUnconfirmed)
	}
	defer response.Body.Close()
	body := io.LimitReader(response.Body, 1<<20)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var envelope struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.NewDecoder(body).Decode(&envelope)
		if envelope.Error.Code == "model_not_found" {
			return false, fmt.Errorf("%w：模型不存在或当前密钥无权使用", ErrProtocolUnconfirmed)
		}
		if response.StatusCode == 404 || response.StatusCode == 405 || response.StatusCode == 501 {
			return false, nil
		}
		detail := strings.ToLower(envelope.Error.Code + " " + envelope.Error.Message)
		if response.StatusCode == 400 && (strings.Contains(detail, "unsupported_api") || strings.Contains(detail, "unsupported_protocol") || strings.Contains(detail, "responses is not supported") || strings.Contains(detail, "does not support responses")) {
			return false, nil
		}
		return false, fmt.Errorf("%w：服务返回 HTTP %d，请检查密钥、模型权限和服务状态", ErrProtocolUnconfirmed, response.StatusCode)
	}
	valid := func(data []byte) bool {
		var value map[string]any
		if json.Unmarshal(data, &value) != nil {
			return false
		}
		kind, _ := value["type"].(string)
		if kind == "response.completed" || kind == "response.incomplete" {
			return true
		}
		return value["object"] == "response" && value["id"] != nil
	}
	if strings.Contains(response.Header.Get("Content-Type"), "text/event-stream") {
		scanner := bufio.NewScanner(body)
		scanner.Buffer(make([]byte, 4096), 1<<20)
		for scanner.Scan() {
			line := scanner.Bytes()
			if bytes.HasPrefix(line, []byte("data:")) && valid(bytes.TrimSpace(line[5:])) {
				return true, nil
			}
		}
	} else {
		data, _ := io.ReadAll(body)
		if valid(data) {
			return true, nil
		}
	}
	return false, fmt.Errorf("%w：服务没有返回有效的 Responses 结果", ErrProtocolUnconfirmed)
}
