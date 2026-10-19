package agent

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

type protocolPeer struct {
	input  *io.PipeWriter
	output *json.Decoder
	reader *io.PipeReader
}

func (p protocolPeer) send(t *testing.T, v any) {
	t.Helper()
	if err := json.NewEncoder(p.input).Encode(v); err != nil {
		t.Fatal(err)
	}
}
func (p protocolPeer) next(t *testing.T) map[string]any {
	t.Helper()
	var v map[string]any
	if err := p.output.Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestCodexProtocolApprovalsHistoryAndUsage(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ci, cw := io.Pipe()
	co, ow := io.Pipe()
	si, sw := io.Pipe()
	so, sow := io.Pipe()
	defer ci.Close()
	defer cw.Close()
	defer co.Close()
	defer ow.Close()
	defer si.Close()
	defer sw.Close()
	defer so.Close()
	defer sow.Close()
	go func() { <-ctx.Done(); ci.Close(); co.Close(); si.Close(); so.Close() }()
	done := make(chan error, 1)
	go func() { done <- runCodexProtocol(ctx, ci, ow, sw, so, t.TempDir(), PromptOptions{}, "test-secret") }()
	client := protocolPeer{cw, json.NewDecoder(co), co}
	server := protocolPeer{sow, json.NewDecoder(si), si}
	init := server.next(t)
	if init["method"] != "initialize" {
		t.Fatal(init)
	}
	server.send(t, map[string]any{"id": init["id"], "result": map[string]any{}})
	if f := server.next(t); f["method"] != "initialized" {
		t.Fatal(f)
	}
	if f := client.next(t); f["method"] != "gateway.ready" {
		t.Fatal(f)
	}
	client.send(t, map[string]any{"id": "create", "method": "session.create", "params": map[string]any{"messages": []any{map[string]any{"role": "user", "content": "PRIOR_CONTEXT"}}}})
	start := server.next(t)
	if start["method"] != "thread/start" {
		t.Fatal(start)
	}
	server.send(t, map[string]any{"id": "create", "result": map[string]any{"model": "fixture", "thread": map[string]any{"id": "native"}}})
	session := client.next(t)
	if session["result"].(map[string]any)["session_id"] != "codex:native" {
		t.Fatal(session)
	}
	client.send(t, map[string]any{"id": "prompt", "method": "prompt.submit", "params": map[string]any{"text": "CURRENT"}})
	turn := server.next(t)
	params := turn["params"].(map[string]any)
	input := params["input"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(input, "PRIOR_CONTEXT") || !strings.Contains(input, "CURRENT") {
		t.Fatal("history omitted")
	}
	server.send(t, map[string]any{"id": "prompt", "result": map[string]any{"turn": map[string]any{"id": "turn1"}}})
	client.next(t)
	for _, method := range []string{"item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"} {
		server.send(t, map[string]any{"id": 42, "method": method, "params": map[string]any{"command": "echo ok", "permissions": map[string]any{"network": map[string]any{"enabled": true}}}})
		approval := client.next(t)
		if approval["method"] != "approval" {
			t.Fatal(approval)
		}
		client.send(t, map[string]any{"id": approval["id"], "result": map[string]any{"choice": "once"}})
		reply := server.next(t)
		result := reply["result"].(map[string]any)
		if method == "item/permissions/requestApproval" {
			if len(result["permissions"].(map[string]any)) == 0 {
				t.Fatal("approved permissions lost")
			}
		} else if result["decision"] != "accept" {
			t.Fatal(result)
		}
	}
	server.send(t, map[string]any{"id": 43, "method": "item/tool/requestUserInput", "params": map[string]any{"questions": []any{map[string]any{"id": "question1", "question": "Which?", "options": []any{map[string]any{"label": "A"}}}}}})
	question := client.next(t)
	if question["method"] != "clarify" {
		t.Fatal(question)
	}
	client.send(t, map[string]any{"id": question["id"], "result": map[string]any{"answers": map[string]any{"question1": "A"}}})
	answer := server.next(t)
	if answer["id"] != float64(43) {
		t.Fatal(answer)
	}
	for _, count := range []int{10, 20} {
		server.send(t, map[string]any{"method": "thread/tokenUsage/updated", "params": map[string]any{"tokenUsage": map[string]any{"last": map[string]any{"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}, "total": map[string]any{"inputTokens": count + 100, "outputTokens": count/2 + 50, "totalTokens": count*3/2 + 150}}}})
	}
	server.send(t, map[string]any{"method": "item/agentMessage/delta", "params": map[string]any{"itemId": "msg", "delta": "RESULT"}})
	if f := client.next(t); f["method"] != "message.delta" {
		t.Fatal(f)
	}
	server.send(t, map[string]any{"method": "turn/completed", "params": map[string]any{"turn": map[string]any{"status": "completed"}}})
	complete := client.next(t)
	usage := complete["params"].(map[string]any)["usage"].(map[string]any)
	if usage["total_tokens"] != float64(30) {
		t.Fatalf("multi-round usage lost: %v", usage)
	}
	// User cancellation maps to the native turn, never to another submit.
	client.send(t, map[string]any{"id": "stop", "method": "session.interrupt"})
	interrupted := server.next(t)
	if interrupted["method"] != "turn/interrupt" {
		t.Fatal(interrupted)
	}
	cancel()
	<-done
}
