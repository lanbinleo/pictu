package api

import (
	"fmt"
	"strings"
)

type PlanInput struct {
	UserText   string
	ImageNames []string
	Size       string
	Resolution string
	Quality    string
	Count      int
}

type GenerationPlan struct {
	Prompt     string `json:"prompt"`
	Size       string `json:"size"`
	Resolution string `json:"resolution"`
	Quality    string `json:"quality"`
	Count      int    `json:"count"`
}

func BuildPlan(input PlanInput) GenerationPlan {
	size := input.Size
	if size == "" {
		size = "auto"
	}
	resolution := input.Resolution
	if resolution == "" {
		resolution = "1K"
	}
	quality := input.Quality
	if quality == "" {
		quality = "medium"
	}
	count := input.Count
	if count <= 0 {
		count = 1
	}
	if count > 4 {
		count = 4
	}

	var b strings.Builder
	b.WriteString("You are GPT Image 2. Create a high-quality image result from the user's instruction.\n")
	if len(input.ImageNames) > 0 {
		b.WriteString("Reference images are provided in order: ")
		b.WriteString(strings.Join(input.ImageNames, ", "))
		b.WriteString(". Treat them as visual references by their order and preserve identity, composition, or style only when the user asks.\n")
	}
	b.WriteString("User instruction: ")
	b.WriteString(strings.TrimSpace(input.UserText))
	b.WriteString("\n")
	b.WriteString("Output requirements: clean composition, natural details, no watermark, no unreadable text unless requested, production-ready image.")
	return GenerationPlan{
		Prompt:     strings.TrimSpace(b.String()),
		Size:       size,
		Resolution: resolution,
		Quality:    quality,
		Count:      count,
	}
}

func EstimateCost(baseCost, inputCost int, lowMultiplier, highMultiplier float64, quality string, imageCount, outputCount int) int {
	if outputCount <= 0 {
		outputCount = 1
	}
	multiplier := 1.0
	switch quality {
	case "low":
		multiplier = lowMultiplier
	case "high":
		multiplier = highMultiplier
	}
	cost := int(float64(baseCost*outputCount)*multiplier) + inputCost*imageCount
	if cost < 1 {
		return 1
	}
	return cost
}

func TitleFromPrompt(text string) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "New image session"
	}
	runes := []rune(trimmed)
	if len(runes) > 24 {
		return fmt.Sprintf("%s...", string(runes[:24]))
	}
	return trimmed
}
