package api

import (
	"strings"
	"testing"
)

func TestPlannerSystemPromptUsesCustomPrompt(t *testing.T) {
	got := plannerSystemPrompt("Custom planner rules.", true)
	if !strings.Contains(got, "Custom planner rules.") {
		t.Fatalf("custom prompt missing from planner prompt: %q", got)
	}
	if !strings.Contains(got, "You can inspect them directly") {
		t.Fatalf("vision capability note missing from planner prompt: %q", got)
	}
}

func TestPlannerSystemPromptFallsBackToDefault(t *testing.T) {
	got := plannerSystemPrompt("", false)
	if !strings.Contains(got, "visual designer") {
		t.Fatalf("default planner brief guidance missing: %q", got)
	}
	if !strings.Contains(got, "You cannot see pixels") {
		t.Fatalf("non-vision capability note missing from planner prompt: %q", got)
	}
}
