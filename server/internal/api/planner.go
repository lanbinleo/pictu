package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"pictu/server/internal/config"
	"pictu/server/internal/store"
)

type PlanInput struct {
	UserText        string
	ImageNames      []string
	Size            string
	Resolution      string
	Quality         string
	Count           int
	ContextMessages []store.Message
}

type GenerationPlan struct {
	Prompt           string `json:"prompt"`
	Size             string `json:"size"`
	Resolution       string `json:"resolution"`
	Quality          string `json:"quality"`
	Count            int    `json:"count"`
	AssistantMessage string `json:"assistant_message"`
	ToolCalled       bool   `json:"tool_called"`
}

type Planner struct {
	cfg        config.LLMConfig
	httpClient *http.Client
}

type chatMessage struct {
	Role       string     `json:"role"`
	Content    string     `json:"content,omitempty"`
	ToolCalls  []toolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

type toolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function toolFunction `json:"function"`
}

type toolFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Tools       []toolDef     `json:"tools,omitempty"`
	ToolChoice  string        `json:"tool_choice,omitempty"`
	Temperature float64       `json:"temperature,omitempty"`
	Stream      bool          `json:"stream,omitempty"`
}

type toolDef struct {
	Type     string      `json:"type"`
	Function functionDef `json:"function"`
}

type functionDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

type chatResponse struct {
	Choices []struct {
		Message chatMessage `json:"message"`
	} `json:"choices"`
}

type PlanStreamEvent struct {
	Type string
	Text string
}

func NewPlanner(cfg config.LLMConfig) *Planner {
	return &Planner{
		cfg: cfg,
		httpClient: &http.Client{
			Timeout: time.Duration(cfg.TimeoutSeconds) * time.Second,
		},
	}
}

func (p *Planner) Plan(ctx context.Context, input PlanInput) (GenerationPlan, error) {
	input = normalizeInput(input)
	if p.cfg.Provider != "openai_compatible" || p.cfg.APIKey == "" || p.cfg.BaseURL == "" || p.cfg.PlannerModel == "" {
		return BuildPlan(input), nil
	}

	messages := []chatMessage{
		{Role: "system", Content: plannerSystemPrompt()},
	}
	for _, msg := range trimContext(input.ContextMessages, p.cfg.MaxContextMessages) {
		content := msg.Content
		if msg.Prompt != "" {
			content += "\nPrevious generated prompt:\n" + msg.Prompt
		}
		messages = append(messages, chatMessage{Role: msg.Role, Content: content})
	}
	messages = append(messages, chatMessage{Role: "user", Content: userPlanningPrompt(input)})

	var out chatResponse
	if err := p.doChat(ctx, chatRequest{
		Model:       p.cfg.PlannerModel,
		Messages:    messages,
		Tools:       []toolDef{generateImageTool()},
		ToolChoice:  "auto",
		Temperature: 0.4,
	}, &out); err != nil {
		return BuildPlan(input), err
	}
	if len(out.Choices) == 0 {
		return BuildPlan(input), nil
	}
	msg := out.Choices[0].Message
	return planFromMessage(msg, input), nil
}

func (p *Planner) PlanStream(ctx context.Context, input PlanInput, emit func(PlanStreamEvent) error) (GenerationPlan, error) {
	input = normalizeInput(input)
	if p.cfg.Provider != "openai_compatible" || p.cfg.APIKey == "" || p.cfg.BaseURL == "" || p.cfg.PlannerModel == "" {
		plan := BuildPlan(input)
		if plan.AssistantMessage != "" {
			_ = emit(PlanStreamEvent{Type: "content", Text: plan.AssistantMessage})
		}
		return plan, nil
	}

	messages := []chatMessage{{Role: "system", Content: plannerSystemPrompt()}}
	for _, msg := range trimContext(input.ContextMessages, p.cfg.MaxContextMessages) {
		content := msg.Content
		if msg.Prompt != "" {
			content += "\nPrevious generated prompt:\n" + msg.Prompt
		}
		messages = append(messages, chatMessage{Role: msg.Role, Content: content})
	}
	messages = append(messages, chatMessage{Role: "user", Content: userPlanningPrompt(input)})

	reqBody := chatRequest{
		Model:       p.cfg.PlannerModel,
		Messages:    messages,
		Tools:       []toolDef{generateImageTool()},
		ToolChoice:  "auto",
		Temperature: 0.4,
		Stream:      true,
	}
	msg, err := p.doChatStream(ctx, reqBody, emit)
	if err != nil {
		return p.Plan(ctx, input)
	}
	return planFromMessage(msg, input), nil
}

func (p *Planner) Title(ctx context.Context, userText, assistantText string, date time.Time) (string, error) {
	fallback := TitleFromPrompt(userText, date)
	if p.cfg.Provider != "openai_compatible" || p.cfg.APIKey == "" || p.cfg.BaseURL == "" || p.cfg.TitleModel == "" {
		return fallback, nil
	}
	messages := []chatMessage{
		{Role: "system", Content: "为绘画会话生成一个简短中文标题。不要包含日期，不要包含具体时间。总长度不超过 18 个汉字。只输出标题。"},
		{Role: "user", Content: fmt.Sprintf("用户：%s\n助手：%s", userText, assistantText)},
	}
	var out chatResponse
	if err := p.doChat(ctx, chatRequest{Model: p.cfg.TitleModel, Messages: messages, Temperature: 0.2}, &out); err != nil {
		return fallback, err
	}
	if len(out.Choices) == 0 {
		return fallback, nil
	}
	title := strings.TrimSpace(out.Choices[0].Message.Content)
	title = strings.Trim(title, "\"'“”")
	if title == "" {
		return fallback, nil
	}
	runes := []rune(title)
	if len(runes) > 36 {
		title = string(runes[:36])
	}
	return title, nil
}

func (p *Planner) doChat(ctx context.Context, reqBody chatRequest, out any) error {
	data, err := json.Marshal(reqBody)
	if err != nil {
		return err
	}
	base := strings.TrimRight(p.cfg.BaseURL, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/chat/completions", bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+p.cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("llm api error %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return json.Unmarshal(body, out)
}

func (p *Planner) doChatStream(ctx context.Context, reqBody chatRequest, emit func(PlanStreamEvent) error) (chatMessage, error) {
	data, err := json.Marshal(reqBody)
	if err != nil {
		return chatMessage{}, err
	}
	base := strings.TrimRight(p.cfg.BaseURL, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/chat/completions", bytes.NewReader(data))
	if err != nil {
		return chatMessage{}, err
	}
	req.Header.Set("Authorization", "Bearer "+p.cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	resp, err := p.httpClient.Do(req)
	if err != nil {
		return chatMessage{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return chatMessage{}, fmt.Errorf("llm stream error %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var message chatMessage
	toolByIndex := map[int]*toolCall{}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content          string `json:"content"`
					Reasoning        string `json:"reasoning"`
					ReasoningContent string `json:"reasoning_content"`
					ToolCalls        []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Type     string `json:"type"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue
		}
		for _, choice := range chunk.Choices {
			if choice.Delta.ReasoningContent != "" {
				if err := emit(PlanStreamEvent{Type: "thinking", Text: choice.Delta.ReasoningContent}); err != nil {
					return message, err
				}
			}
			if choice.Delta.Reasoning != "" {
				if err := emit(PlanStreamEvent{Type: "thinking", Text: choice.Delta.Reasoning}); err != nil {
					return message, err
				}
			}
			if choice.Delta.Content != "" {
				message.Content += choice.Delta.Content
				if err := emit(PlanStreamEvent{Type: "content", Text: choice.Delta.Content}); err != nil {
					return message, err
				}
			}
			for _, deltaCall := range choice.Delta.ToolCalls {
				call := toolByIndex[deltaCall.Index]
				if call == nil {
					call = &toolCall{Type: "function"}
					toolByIndex[deltaCall.Index] = call
				}
				if deltaCall.ID != "" {
					call.ID = deltaCall.ID
				}
				if deltaCall.Type != "" {
					call.Type = deltaCall.Type
				}
				if deltaCall.Function.Name != "" {
					call.Function.Name += deltaCall.Function.Name
				}
				if deltaCall.Function.Arguments != "" {
					call.Function.Arguments += deltaCall.Function.Arguments
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return message, err
	}
	for i := 0; i < len(toolByIndex); i++ {
		if call := toolByIndex[i]; call != nil {
			message.ToolCalls = append(message.ToolCalls, *call)
		}
	}
	return message, nil
}

func planFromMessage(msg chatMessage, input PlanInput) GenerationPlan {
	plan := GenerationPlan{
		AssistantMessage: strings.TrimSpace(msg.Content),
		Size:             input.Size,
		Resolution:       input.Resolution,
		Quality:          input.Quality,
		Count:            input.Count,
	}
	for _, call := range msg.ToolCalls {
		if call.Function.Name != "generate_image" {
			continue
		}
		var args struct {
			Prompt           string `json:"prompt"`
			Size             string `json:"size"`
			Resolution       string `json:"resolution"`
			Quality          string `json:"quality"`
			Count            int    `json:"count"`
			AssistantMessage string `json:"assistant_message"`
		}
		if err := json.Unmarshal([]byte(call.Function.Arguments), &args); err != nil {
			continue
		}
		plan.ToolCalled = true
		plan.Prompt = strings.TrimSpace(args.Prompt)
		plan.Size = coalesce(args.Size, input.Size)
		plan.Resolution = coalesce(args.Resolution, input.Resolution)
		plan.Quality = coalesce(args.Quality, input.Quality)
		if args.Count > 0 {
			plan.Count = args.Count
		}
		if args.AssistantMessage != "" {
			plan.AssistantMessage = args.AssistantMessage
		}
		break
	}
	if !plan.ToolCalled {
		plan.AssistantMessage = coalesce(plan.AssistantMessage, "我先理解你的方向。你可以继续补充主体、风格、用途或参考图关系。")
		return plan
	}
	return sanitizePlan(plan, input)
}

func BuildPlan(input PlanInput) GenerationPlan {
	input = normalizeInput(input)
	var b strings.Builder
	b.WriteString("Create a high-quality image result from the user's instruction.\n")
	if len(input.ImageNames) > 0 {
		b.WriteString("Reference images are provided in order: ")
		b.WriteString(strings.Join(input.ImageNames, ", "))
		b.WriteString(". The language model cannot see pixels; rely on the user's description for visual details.\n")
	}
	b.WriteString("User instruction: ")
	b.WriteString(strings.TrimSpace(input.UserText))
	b.WriteString("\nOutput requirements: clean composition, natural details, no watermark, no unreadable text unless requested, production-ready image.")
	return GenerationPlan{
		Prompt:           strings.TrimSpace(b.String()),
		Size:             input.Size,
		Resolution:       input.Resolution,
		Quality:          input.Quality,
		Count:            input.Count,
		AssistantMessage: "我已经整理好生成提示词。",
		ToolCalled:       true,
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

func TitleFromPrompt(text string, date time.Time) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "图像会话"
	}
	runes := []rune(trimmed)
	if len(runes) > 16 {
		trimmed = string(runes[:16])
	}
	return trimmed
}

func normalizeInput(input PlanInput) PlanInput {
	if input.Size == "" {
		input.Size = "auto"
	}
	if input.Resolution == "" {
		input.Resolution = "1K"
	}
	if input.Quality == "" {
		input.Quality = "medium"
	}
	if input.Count <= 0 {
		input.Count = 1
	}
	if input.Count > 4 {
		input.Count = 4
	}
	return input
}

func sanitizePlan(plan GenerationPlan, input PlanInput) GenerationPlan {
	plan.Prompt = strings.TrimSpace(plan.Prompt)
	if plan.Prompt == "" {
		plan.Prompt = BuildPlan(input).Prompt
	}
	plan.Size = validSize(plan.Size, input.Size)
	plan.Resolution = validEnum(plan.Resolution, input.Resolution, []string{"1K", "2K", "4K"})
	plan.Quality = validEnum(plan.Quality, input.Quality, []string{"low", "medium", "high"})
	if plan.Count <= 0 {
		plan.Count = input.Count
	}
	if plan.Count > 4 {
		plan.Count = 4
	}
	plan.AssistantMessage = coalesce(plan.AssistantMessage, "我已经准备好生成提示词。")
	return plan
}

func plannerSystemPrompt() string {
	return `You are PicTu's planning model. You are a conversational image design partner and a tool-using agent.

Important:
- You cannot see pixels in uploaded images. You only know image order, file names, and what the user says about them.
- Continue the conversation if the user's idea is underspecified.
- Call generate_image only when the user is ready to create or edit an image.
- UI settings are chosen by the user. Keep size, resolution, quality, and count exactly as CURRENT SETTINGS unless the user explicitly asks for different settings or your recommendation is important. Any difference requires user confirmation in the UI.
- Write the generation prompt clearly and completely. The user will see it.
- Keep assistant_message concise and natural.`
}

func userPlanningPrompt(input PlanInput) string {
	var b strings.Builder
	b.WriteString("CURRENT SETTINGS:\n")
	b.WriteString(fmt.Sprintf("- size: %s\n- resolution: %s\n- quality: %s\n- count: %d\n", input.Size, input.Resolution, input.Quality, input.Count))
	if len(input.ImageNames) > 0 {
		b.WriteString("REFERENCE IMAGES:\n")
		for i, name := range input.ImageNames {
			b.WriteString(fmt.Sprintf("- image %d: %s\n", i+1, name))
		}
	}
	b.WriteString("USER MESSAGE:\n")
	b.WriteString(input.UserText)
	return b.String()
}

func generateImageTool() toolDef {
	return toolDef{
		Type: "function",
		Function: functionDef{
			Name:        "generate_image",
			Description: "Create or edit an image with GPT Image 2. Call this only when the user is ready to generate.",
			Parameters: map[string]any{
				"type":     "object",
				"required": []string{"prompt"},
				"properties": map[string]any{
					"prompt": map[string]any{
						"type":        "string",
						"description": "Final image generation/editing prompt. Include reference image usage by order when relevant.",
					},
					"size": map[string]any{
						"type":        "string",
						"description": "Recommended size ratio or auto. Keep current UI setting unless change is necessary.",
					},
					"resolution": map[string]any{
						"type":        "string",
						"enum":        []string{"1K", "2K", "4K"},
						"description": "Recommended resolution. Keep current UI setting unless change is necessary.",
					},
					"quality": map[string]any{
						"type":        "string",
						"enum":        []string{"low", "medium", "high"},
						"description": "Recommended quality. Keep current UI setting unless change is necessary.",
					},
					"count": map[string]any{
						"type":        "integer",
						"minimum":     1,
						"maximum":     4,
						"description": "Number of outputs. Keep current UI setting unless change is necessary.",
					},
					"assistant_message": map[string]any{
						"type":        "string",
						"description": "Brief message shown to the user before/with the generated prompt.",
					},
				},
			},
		},
	}
}

func trimContext(messages []store.Message, max int) []store.Message {
	if max <= 0 || len(messages) <= max {
		return messages
	}
	return messages[len(messages)-max:]
}

func coalesce(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}

func validEnum(value, fallback string, allowed []string) string {
	for _, item := range allowed {
		if strings.EqualFold(value, item) {
			return item
		}
	}
	return fallback
}

func validSize(value, fallback string) string {
	if value == "" {
		return fallback
	}
	allowed := []string{"auto", "1:1", "1:2", "2:1", "1:3", "3:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "9:21", "21:9"}
	for _, item := range allowed {
		if value == item {
			return value
		}
	}
	if strings.Contains(value, "x") || strings.Contains(value, "×") {
		return value
	}
	return fallback
}
