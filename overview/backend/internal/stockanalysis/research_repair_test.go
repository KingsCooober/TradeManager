package stockanalysis

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const invalidTradeJSON = `{"conditions":[{"id":"c1","threshold":"not-a-number"}],"decision":{}}`

func TestDecodeResearchJSONPreservesMainObjectFieldError(t *testing.T) {
	trade := ResearchTradeConditions{InvalidationIDs: []string{"original"}}
	err := decodeJSONObject(invalidTradeJSON, &trade)
	var fieldErr *json.UnmarshalTypeError
	if !errors.As(err, &fieldErr) || !strings.Contains(fieldErr.Field, "threshold") {
		t.Fatalf("nested decision hid the threshold type error: %v", err)
	}
	if len(trade.InvalidationIDs) != 1 || trade.InvalidationIDs[0] != "original" || len(trade.Conditions) != 0 {
		t.Fatal("invalid main object changed the decode target")
	}
}

func TestResearchRepairsTradeJSONOnceWithOriginalError(t *testing.T) {
	for _, level := range []ResearchLevel{ResearchLevelDeep, ResearchLevelStandard} {
		t.Run(string(level), func(t *testing.T) {
			analysis, snapshot := researchFixture(t)
			final, _ := json.Marshal(validResearch())
			execution := &researchExecution{}
			ctx := context.WithValue(context.Background(), researchExecutionKey{}, execution)
			expectedCalls := 3
			if level == ResearchLevelDeep {
				expectedCalls = 4
			}
			p := &researchTestPrompter{respond: func(call int, prompt string) (string, error) {
				if level == ResearchLevelDeep && call == 1 {
					return `{"questions":[]}`, nil
				}
				if call == expectedCalls-1 {
					return invalidTradeJSON, nil
				}
				if call == expectedCalls {
					if !strings.Contains(prompt, "具体解析错误：") || !strings.Contains(prompt, "threshold") || !strings.Contains(prompt, invalidTradeJSON) {
						t.Fatal("repair did not receive the field error and original final output")
					}
					failure, ok := execution.checkpoint.Failures["交易条件"]
					if !ok || failure.Content != invalidTradeJSON || !strings.Contains(failure.Error, "threshold") {
						t.Fatal("invalid trade output was not captured before repair")
					}
				}
				if call > expectedCalls {
					t.Fatal("exceeded the shared repair budget")
				}
				return string(final), nil
			}}
			request := ResearchRequest{Symbol: analysis.Symbol, Horizon: "swing", AnalysisLevel: level}
			if err := RunResearch(ctx, p, &snapshot, &analysis, request, "fixture", nil, nil); err != nil {
				t.Fatal(err)
			}
			if p.calls != expectedCalls || analysis.ResearchReport == nil || analysis.ResearchReport.Validation != "references_checked" || len(analysis.ResearchReport.Attempts) != expectedCalls {
				t.Fatalf("trade repair failed: calls=%d report=%+v", p.calls, analysis.ResearchReport)
			}
			cp := execution.checkpoint
			if !cp.RepairUsed || len(cp.Failures) != 0 || len(cp.Outputs["交易条件"].Value) == 0 {
				t.Fatal("repaired trade was not cached under its original stage")
			}
			for _, options := range p.options {
				if !options.DisableTools || !options.Sandbox {
					t.Fatal("format repair enabled model tools")
				}
			}
		})
	}
}

func TestDeepResearchSharesJSONAndValidationRepairBudget(t *testing.T) {
	for _, failure := range []string{"trade_json_after_core_repair", "validation_after_trade_repair"} {
		t.Run(failure, func(t *testing.T) {
			analysis, snapshot := researchFixture(t)
			before := analysis.Conclusion
			final, _ := json.Marshal(validResearch())
			invalidReferences := validResearch()
			invalidReferences.Conditions[0].SourceIDs = []string{"unknown-source"}
			invalidFinal, _ := json.Marshal(invalidReferences)
			p := &researchTestPrompter{respond: func(call int, prompt string) (string, error) {
				if call > 4 {
					t.Fatal("a second repair was attempted")
				}
				if call == 1 {
					return `{"questions":[]}`, nil
				}
				if failure == "trade_json_after_core_repair" {
					if call == 2 {
						return `{"headline":["invalid"]}`, nil
					}
					if call == 3 && strings.Contains(prompt, "交易条件conditions") {
						t.Fatal("core repair was given trade-stage instructions")
					}
					if call == 4 {
						return invalidTradeJSON, nil
					}
				} else {
					if call == 3 {
						return invalidTradeJSON, nil
					}
					if call == 4 {
						return string(invalidFinal), nil
					}
				}
				return string(final), nil
			}}
			request := ResearchRequest{Symbol: analysis.Symbol, Horizon: "swing", AnalysisLevel: ResearchLevelDeep}
			err := RunResearch(context.Background(), p, &snapshot, &analysis, request, "fixture", nil, nil)
			if err == nil || p.calls != 4 || analysis.ResearchReport != nil || analysis.Conclusion != before {
				t.Fatalf("failed stage became AI success or exceeded budget: calls=%d err=%v", p.calls, err)
			}
		})
	}
}

func TestDeepResearchDoesNotRepairTransportErrorsOrCancellation(t *testing.T) {
	for _, failure := range []string{"transport", "cancelled_with_invalid_json"} {
		t.Run(failure, func(t *testing.T) {
			analysis, snapshot := researchFixture(t)
			final, _ := json.Marshal(validResearch())
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			p := &researchTestPrompter{respond: func(call int, _ string) (string, error) {
				switch call {
				case 1:
					return `{"questions":[]}`, nil
				case 2:
					return string(final), nil
				case 3:
					if failure == "transport" {
						return "", errors.New("connection interrupted")
					}
					cancel()
					return invalidTradeJSON, nil
				default:
					t.Fatal("transport or cancellation triggered format repair")
					return "", nil
				}
			}}
			err := RunResearch(ctx, p, &snapshot, &analysis, ResearchRequest{Symbol: analysis.Symbol, Horizon: "swing", AnalysisLevel: ResearchLevelDeep}, "fixture", nil, nil)
			if err == nil || p.calls != 3 || analysis.ResearchReport != nil {
				t.Fatalf("failure was accepted: calls=%d err=%v", p.calls, err)
			}
		})
	}
}

func TestResearchFailedFinalOutputIsBoundedRedactedAndPrivate(t *testing.T) {
	analysis, snapshot := researchFixture(t)
	path := filepath.Join(t.TempDir(), "research.db")
	store, err := OpenResearchStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	cp := &ResearchCheckpoint{PromptVersion: ResearchPromptVersion, CompressionVersion: ResearchCompressionVersion, Outputs: map[string]ResearchStageOutput{}}
	job := ResearchJob{ID: "invalid-json", Status: "failed", Analysis: &analysis, Snapshot: &snapshot, Checkpoint: cp}
	ctx := context.WithValue(context.Background(), researchExecutionKey{}, &researchExecution{save: func(*ResearchCheckpoint) error {
		return store.Save(context.Background(), job)
	}})
	content := `{"conditions":[{"threshold":"wrong"}],"decision":{},"debug":"PRIVATE_FINAL_OUTPUT Bearer fake-test-secret ` + strings.Repeat("x", 9000) + ` END_OF_RESPONSE"}`
	p := &researchTestPrompter{respond: func(int, string) (string, error) { return content, nil }}
	_, err = promptResearchJSON[ResearchTradeConditions](ctx, p, "trade prompt", "交易条件", promptJSONObjectOptions{maxAttempts: 1, disableTools: true}, cp, &snapshot)
	if !isInvalidModelJSON(err) {
		t.Fatalf("expected typed invalid JSON error: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = OpenResearchStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	saved, err := store.Get(context.Background(), job.ID)
	if err != nil {
		t.Fatal(err)
	}
	failure := saved.Checkpoint.Failures["交易条件"]
	if failure.PromptHash != researchHash("trade prompt") || !strings.Contains(failure.Error, "threshold") || !strings.Contains(failure.Content, "PRIVATE_FINAL_OUTPUT") || !strings.Contains(failure.Content, "<redacted>") || len([]rune(failure.Content)) > 8000 || strings.Contains(failure.Content, "fake-test-secret") || strings.Contains(failure.Content, "END_OF_RESPONSE") {
		t.Fatal("failed final output was not stored with bounded, redacted diagnostics")
	}
	if len(saved.Checkpoint.Outputs) != 0 || saved.Analysis.ResearchReport != nil {
		t.Fatal("invalid JSON was saved as a successful stage")
	}
	public, err := json.Marshal(saved.Public())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(public), "PRIVATE_FINAL_OUTPUT") || strings.Contains(string(public), "checkpoint") || strings.Contains(string(public), "failures") {
		t.Fatal("private failed output escaped through the public task")
	}
}

func TestResearchResumeCachesRepairedCoreAndPreservesBudget(t *testing.T) {
	analysis, snapshot := researchFixture(t)
	path := filepath.Join(t.TempDir(), "research.db")
	store, err := OpenResearchStore(path)
	if err != nil {
		t.Fatal(err)
	}
	final, _ := json.Marshal(validResearch())
	p := &researchTestPrompter{respond: func(call int, prompt string) (string, error) {
		switch call {
		case 1:
			return `{"questions":[]}`, nil
		case 2:
			return `{"headline":["invalid"]}`, nil
		case 3:
			return string(final), nil
		case 4:
			return "", errors.New("connection interrupted")
		case 5:
			if !strings.HasPrefix(prompt, "你是A股交易条件整理器") || strings.Contains(prompt, "[结构修复要求]") {
				t.Fatal("resume reran a completed stage")
			}
			return invalidTradeJSON, nil
		default:
			t.Fatal("resume repeated a completed stage or reset its repair budget")
			return "", nil
		}
	}}
	runner := func(ctx context.Context, request ResearchRequest, publish ResearchPublisher) (Analysis, *ResearchSnapshot, error) {
		a, s := analysis, snapshot
		if previous := ResearchResumeData(ctx); previous != nil {
			a, s = *previous.Analysis, *previous.Snapshot
		}
		if err := publish("baseline", "quantitative", &a, &s); err != nil {
			return a, &s, err
		}
		err := RunResearch(ctx, p, &s, &a, request, "fixture", nil, nil)
		return a, &s, err
	}
	service := NewResearchService(store, runner)
	first, err := service.Start(context.Background(), ResearchRequest{Symbol: analysis.Symbol, Horizon: "swing", AnalysisLevel: ResearchLevelDeep})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	first, err = service.Wait(ctx, first.ID)
	if err != nil || first.Status != "failed" || p.calls != 4 || first.Checkpoint == nil || !first.Checkpoint.RepairUsed || len(first.Checkpoint.Outputs["核心判断"].Value) == 0 || len(first.Checkpoint.Failures) != 0 {
		t.Fatalf("repaired core was not checkpointed: status=%s calls=%d err=%v", first.Status, p.calls, err)
	}
	service.Close()
	store.Close()
	store, err = OpenResearchStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	service = NewResearchService(store, runner)
	defer service.Close()
	second, err := service.Resume(ctx, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err = service.Wait(ctx, second.ID)
	if err != nil || second.Status != "failed" || p.calls != 5 || second.Analysis.ResearchReport != nil || !strings.Contains(second.Error, "threshold") {
		t.Fatalf("resume reset repair budget or accepted invalid trade: status=%s calls=%d err=%v", second.Status, p.calls, err)
	}
	if second.ResumedFrom != first.ID || second.ID == first.ID || second.Snapshot.ID != first.Snapshot.ID || !second.Snapshot.CutoffAt.Equal(first.Snapshot.CutoffAt) {
		t.Fatal("resume lost the original task or evidence time")
	}
}
