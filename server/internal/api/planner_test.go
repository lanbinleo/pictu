package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"pictu/server/internal/config"
)

func TestPlannerSystemPromptUsesCustomPrompt(t *testing.T) {
	got := plannerSystemPrompt("Custom planner rules.", true, PlanInput{})
	if !strings.Contains(got, "Custom planner rules.") {
		t.Fatalf("custom prompt missing from planner prompt: %q", got)
	}
	if !strings.Contains(got, "You can inspect them directly") {
		t.Fatalf("vision capability note missing from planner prompt: %q", got)
	}
}

func TestPlannerSystemPromptFallsBackToDefault(t *testing.T) {
	got := plannerSystemPrompt("", false, PlanInput{})
	if !strings.Contains(got, "visual designer") {
		t.Fatalf("default planner brief guidance missing: %q", got)
	}
	if !strings.Contains(got, "You cannot see pixels") {
		t.Fatalf("non-vision capability note missing from planner prompt: %q", got)
	}
}

func TestPlannerSystemPromptRendersCapsuleTemplate(t *testing.T) {
	got := plannerSystemPrompt("Rules\n{{capsules}}\n{{user_message}}", false, PlanInput{
		UserText: "draw a character",
		Capsules: []PlanCapsule{{
			CapsuleID:          "style/anime",
			Title:              "日漫风格",
			Type:               "style",
			PlannerInstruction: "Use clean anime illustration details.",
		}},
	})
	if !strings.Contains(got, "@style/anime") || !strings.Contains(got, "Use clean anime illustration details.") {
		t.Fatalf("capsule template was not rendered: %q", got)
	}
	if !strings.Contains(got, "draw a character") {
		t.Fatalf("user message template was not rendered: %q", got)
	}
}

func TestDirectPlanIncludesCapsuleInstruction(t *testing.T) {
	plan := DirectPlan(PlanInput{
		UserText: "draw a character",
		Capsules: []PlanCapsule{{
			CapsuleID:         "style/cel-shading",
			DirectInstruction: "crisp cel-shaded lighting",
		}},
	})
	if !strings.Contains(plan.Prompt, "draw a character") || !strings.Contains(plan.Prompt, "crisp cel-shaded lighting") {
		t.Fatalf("direct plan missing capsule instruction: %q", plan.Prompt)
	}
}

func TestPlannerPlanStreamHandlesLargeSSEChunk(t *testing.T) {
	t.Parallel()

	var streamRequests atomic.Int32
	var mu sync.Mutex
	var handlerErr error
	recordErr := func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		if handlerErr == nil {
			handlerErr = fmt.Errorf(format, args...)
		}
	}
	largePrompt := strings.Repeat("long prompt segment ", 70000)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		streamRequests.Add(1)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			recordErr("read request body: %v", err)
			return
		}
		if !strings.Contains(string(body), `"stream":true`) {
			recordErr("expected stream request body, got %s", body)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		payload := map[string]any{
			"choices": []map[string]any{{
				"delta": map[string]any{
					"tool_calls": []map[string]any{{
						"index": 0,
						"id":    "call_1",
						"type":  "function",
						"function": map[string]any{
							"name":      "generate_image",
							"arguments": fmt.Sprintf(`{"prompt":%q,"size":"1024x1024","resolution":"1K","quality":"medium","count":1,"assistant_message":"ready"}`, largePrompt),
						},
					}},
				},
			}},
		}
		data, err := json.Marshal(payload)
		if err != nil {
			recordErr("marshal stream chunk: %v", err)
			return
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
			recordErr("write stream chunk: %v", err)
			return
		}
		if _, err := fmt.Fprint(w, "data: [DONE]\n\n"); err != nil {
			recordErr("write done chunk: %v", err)
		}
	}))
	defer server.Close()

	planner := NewPlanner(configForPlannerTest(server.URL))
	plan, err := planner.PlanStream(context.Background(), PlanInput{
		UserText:   "make a poster",
		Size:       "1024x1024",
		Resolution: "1K",
		Quality:    "medium",
		Count:      1,
	}, func(PlanStreamEvent) error { return nil })
	if err != nil {
		t.Fatalf("plan stream failed: %v", err)
	}
	if !plan.ToolCalled {
		t.Fatalf("expected tool call in streamed plan")
	}
	wantPrompt := strings.TrimSpace(largePrompt)
	if plan.Prompt != wantPrompt {
		t.Fatalf("unexpected prompt length: got %d want %d", len(plan.Prompt), len(wantPrompt))
	}
	if streamRequests.Load() != 1 {
		t.Fatalf("unexpected request count: %d", streamRequests.Load())
	}
	mu.Lock()
	defer mu.Unlock()
	if handlerErr != nil {
		t.Fatalf("handler error: %v", handlerErr)
	}
}

func TestPlannerPlanStreamFallsBackAfterUnexpectedEOF(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	var mu sync.Mutex
	var handlerErr error
	recordErr := func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		if handlerErr == nil {
			handlerErr = fmt.Errorf(format, args...)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := calls.Add(1)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			recordErr("read request body: %v", err)
			return
		}
		switch call {
		case 1:
			if !strings.Contains(string(body), `"stream":true`) {
				recordErr("expected stream request body, got %s", body)
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			if _, err := fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"still thinking\"}}]}\n\n"); err != nil {
				recordErr("write partial stream chunk: %v", err)
				return
			}
		case 2:
			if strings.Contains(string(body), `"stream":true`) {
				recordErr("expected non-stream fallback request body, got %s", body)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			if _, err := fmt.Fprint(w, `{"choices":[{"message":{"content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"generate_image","arguments":"{\"prompt\":\"fallback prompt\",\"size\":\"1024x1024\",\"resolution\":\"1K\",\"quality\":\"medium\",\"count\":1,\"assistant_message\":\"ok\"}"}}]}}]}`); err != nil {
				recordErr("write fallback response: %v", err)
				return
			}
		default:
			recordErr("unexpected extra request %d", call)
			return
		}
	}))
	defer server.Close()

	planner := NewPlanner(configForPlannerTest(server.URL))
	plan, err := planner.PlanStream(context.Background(), PlanInput{
		UserText:   "make a poster",
		Size:       "1024x1024",
		Resolution: "1K",
		Quality:    "medium",
		Count:      1,
	}, func(PlanStreamEvent) error { return nil })
	if err != nil {
		t.Fatalf("plan stream failed: %v", err)
	}
	if !plan.ToolCalled {
		t.Fatalf("expected fallback plan to call tool")
	}
	if plan.Prompt != "fallback prompt" {
		t.Fatalf("unexpected fallback prompt: %q", plan.Prompt)
	}
	if calls.Load() != 2 {
		t.Fatalf("unexpected request count: %d", calls.Load())
	}
	mu.Lock()
	defer mu.Unlock()
	if handlerErr != nil {
		t.Fatalf("handler error: %v", handlerErr)
	}
}

func configForPlannerTest(baseURL string) config.LLMConfig {
	return config.LLMConfig{
		Provider:       "openai_compatible",
		BaseURL:        baseURL,
		APIKey:         "test-key",
		PlannerModel:   "planner",
		TimeoutSeconds: 1,
		SupportsVision: false,
	}
}
