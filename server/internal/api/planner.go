package api

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

	"pictu/server/internal/config"
	"pictu/server/internal/store"
)

type PlanInput struct {
	UserText        string
	ImageNames      []string
	ImageURLs       []string
	Size            string
	Resolution      string
	Quality         string
	Count           int
	Capsules        []PlanCapsule
	ContextMessages []store.Message
}

type PlanCapsule struct {
	CapsuleID          string
	Title              string
	Type               string
	Tags               []string
	PlannerInstruction string
	DirectInstruction  string
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
	Content    any        `json:"content,omitempty"`
	ToolCalls  []toolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

type chatContentPart struct {
	Type     string            `json:"type"`
	Text     string            `json:"text,omitempty"`
	ImageURL *chatImageURLPart `json:"image_url,omitempty"`
}

type chatImageURLPart struct {
	URL    string `json:"url"`
	Detail string `json:"detail,omitempty"`
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

var (
	errPlannerStreamDone        = errors.New("planner stream done")
	errPlannerStreamIdleTimeout = errors.New("planner stream idle timeout")
)

type plannerEmitError struct {
	err error
}

func (e plannerEmitError) Error() string {
	return e.err.Error()
}

func (e plannerEmitError) Unwrap() error {
	return e.err
}

func NewPlanner(cfg config.LLMConfig) *Planner {
	return &Planner{
		cfg: cfg,
		httpClient: &http.Client{
			Timeout: plannerRequestTimeout(cfg.TimeoutSeconds),
		},
	}
}

func (p *Planner) Plan(ctx context.Context, input PlanInput) (GenerationPlan, error) {
	input = normalizeInput(input)
	if p.cfg.Provider != "openai_compatible" || p.cfg.APIKey == "" || p.cfg.BaseURL == "" || p.cfg.PlannerModel == "" {
		return BuildPlan(input), nil
	}

	messages := []chatMessage{
		{Role: "system", Content: plannerSystemPrompt(p.cfg.PlannerSystemPrompt, p.cfg.SupportsVision, input)},
	}
	for _, msg := range trimContext(input.ContextMessages, p.cfg.MaxContextMessages) {
		content := msg.Content
		if msg.Prompt != "" {
			content += "\nPrevious generated prompt:\n" + msg.Prompt
		}
		messages = append(messages, chatMessage{Role: msg.Role, Content: content})
	}
	messages = append(messages, chatMessage{Role: "user", Content: userPlanningContent(input, p.cfg.SupportsVision)})

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

	messages := []chatMessage{{Role: "system", Content: plannerSystemPrompt(p.cfg.PlannerSystemPrompt, p.cfg.SupportsVision, input)}}
	for _, msg := range trimContext(input.ContextMessages, p.cfg.MaxContextMessages) {
		content := msg.Content
		if msg.Prompt != "" {
			content += "\nPrevious generated prompt:\n" + msg.Prompt
		}
		messages = append(messages, chatMessage{Role: msg.Role, Content: content})
	}
	messages = append(messages, chatMessage{Role: "user", Content: userPlanningContent(input, p.cfg.SupportsVision)})

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
		var emitErr plannerEmitError
		if errors.As(err, &emitErr) {
			return GenerationPlan{}, err
		}
		partial := planFromMessage(msg, input)
		if partial.ToolCalled && strings.TrimSpace(partial.Prompt) != "" {
			return partial, nil
		}
		if fallback, fallbackErr := p.Plan(ctx, input); fallbackErr == nil {
			return fallback, nil
		}
		return BuildPlan(input), nil
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
	title := strings.TrimSpace(messageText(out.Choices[0].Message.Content))
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
	if strings.Contains(strings.ToLower(p.cfg.BaseURL), "openrouter.ai") {
		req.Header.Set("HTTP-Referer", "http://localhost")
		req.Header.Set("X-Title", "PicTu")
	}
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
	if strings.Contains(strings.ToLower(p.cfg.BaseURL), "openrouter.ai") {
		req.Header.Set("HTTP-Referer", "http://localhost")
		req.Header.Set("X-Title", "PicTu")
	}
	client := p.streamHTTPClient()
	resp, err := client.Do(req)
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
	toolStarted := false
	sawDone := false
	err = readSSEPayloads(ctx, resp.Body, plannerStreamIdleTimeout(p.cfg.TimeoutSeconds), func(payload string) error {
		if payload == "[DONE]" {
			sawDone = true
			return errPlannerStreamDone
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
			return nil
		}
		for _, choice := range chunk.Choices {
			if choice.Delta.ReasoningContent != "" {
				if err := emitPlanStreamEvent(emit, PlanStreamEvent{Type: "thinking", Text: choice.Delta.ReasoningContent}); err != nil {
					return err
				}
			}
			if choice.Delta.Reasoning != "" {
				if err := emitPlanStreamEvent(emit, PlanStreamEvent{Type: "thinking", Text: choice.Delta.Reasoning}); err != nil {
					return err
				}
			}
			if choice.Delta.Content != "" {
				message.Content = appendChatMessageContent(message.Content, choice.Delta.Content)
				if err := emitPlanStreamEvent(emit, PlanStreamEvent{Type: "content", Text: choice.Delta.Content}); err != nil {
					return err
				}
			}
			for _, deltaCall := range choice.Delta.ToolCalls {
				call := toolByIndex[deltaCall.Index]
				if call == nil {
					call = &toolCall{Type: "function"}
					toolByIndex[deltaCall.Index] = call
				}
				if !toolStarted {
					toolStarted = true
					if err := emitPlanStreamEvent(emit, PlanStreamEvent{Type: "tool", Text: ""}); err != nil {
						return err
					}
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
					if err := emitPlanStreamEvent(emit, PlanStreamEvent{Type: "tool", Text: deltaCall.Function.Arguments}); err != nil {
						return err
					}
				}
			}
		}
		return nil
	})
	if errors.Is(err, errPlannerStreamDone) {
		err = nil
	}
	if err != nil {
		return message, err
	}
	for i := 0; i < len(toolByIndex); i++ {
		if call := toolByIndex[i]; call != nil {
			message.ToolCalls = append(message.ToolCalls, *call)
		}
	}
	if !sawDone {
		return message, io.ErrUnexpectedEOF
	}
	return message, nil
}

func (p *Planner) streamHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = plannerRequestTimeout(p.cfg.TimeoutSeconds)
	return &http.Client{Transport: transport}
}

func plannerRequestTimeout(seconds int) time.Duration {
	if seconds <= 0 {
		return 45 * time.Second
	}
	return time.Duration(seconds) * time.Second
}

func plannerStreamIdleTimeout(seconds int) time.Duration {
	timeout := plannerRequestTimeout(seconds)
	if timeout < 30*time.Second {
		return 30 * time.Second
	}
	return timeout
}

func emitPlanStreamEvent(emit func(PlanStreamEvent) error, event PlanStreamEvent) error {
	if err := emit(event); err != nil {
		return plannerEmitError{err: err}
	}
	return nil
}

func readSSEPayloads(ctx context.Context, body io.Reader, idleTimeout time.Duration, handle func(string) error) error {
	reader := bufio.NewReaderSize(body, 64*1024)
	var dataLines []string
	flush := func() error {
		if len(dataLines) == 0 {
			return nil
		}
		payload := strings.Join(dataLines, "\n")
		dataLines = dataLines[:0]
		if strings.TrimSpace(payload) == "" {
			return nil
		}
		return handle(payload)
	}
	for {
		line, err := readLineWithIdle(ctx, reader, idleTimeout)
		if line != "" {
			line = strings.TrimRight(line, "\n")
			line = strings.TrimRight(line, "\r")
			switch {
			case line == "":
				if flushErr := flush(); flushErr != nil {
					return flushErr
				}
			case strings.HasPrefix(line, ":"):
				continue
			case strings.HasPrefix(line, "data:"):
				value := strings.TrimPrefix(line, "data:")
				if strings.HasPrefix(value, " ") {
					value = value[1:]
				}
				dataLines = append(dataLines, value)
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return flush()
			}
			return err
		}
	}
}

func readLineWithIdle(ctx context.Context, reader *bufio.Reader, idleTimeout time.Duration) (string, error) {
	type readResult struct {
		line string
		err  error
	}
	resultCh := make(chan readResult, 1)
	go func() {
		line, err := reader.ReadString('\n')
		resultCh <- readResult{line: line, err: err}
	}()
	timer := time.NewTimer(idleTimeout)
	defer timer.Stop()
	select {
	case result := <-resultCh:
		return result.line, result.err
	case <-timer.C:
		return "", errPlannerStreamIdleTimeout
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func planFromMessage(msg chatMessage, input PlanInput) GenerationPlan {
	plan := GenerationPlan{
		AssistantMessage: strings.TrimSpace(messageText(msg.Content)),
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
		plan.AssistantMessage = mergeAssistantMessage(messageText(msg.Content), args.AssistantMessage)
		break
	}
	if !plan.ToolCalled {
		plan.AssistantMessage = coalesce(plan.AssistantMessage, "我先理解你的方向。你可以继续补充主体、风格、用途或参考图关系。")
		return plan
	}
	return sanitizePlan(plan, input)
}

func mergeAssistantMessage(content, toolMessage string) string {
	content = strings.TrimSpace(content)
	toolMessage = strings.TrimSpace(toolMessage)
	if content == "" {
		return toolMessage
	}
	if toolMessage == "" || strings.Contains(content, toolMessage) {
		return content
	}
	return content + "\n\n" + toolMessage
}

func BuildPlan(input PlanInput) GenerationPlan {
	input = normalizeInput(input)
	var b strings.Builder
	b.WriteString("Generate an image prompt as a clear visual brief.\n")
	if section := plannerCapsulesText(input.Capsules); section != "" {
		b.WriteString(section)
		b.WriteString("\n")
	}
	if len(input.ImageNames) > 0 {
		b.WriteString("Reference images are provided in order: ")
		b.WriteString(strings.Join(input.ImageNames, ", "))
		b.WriteString(". The language model cannot see pixels; rely on the user's description for visual details.\n")
	}
	b.WriteString("User instruction: ")
	b.WriteString(strings.TrimSpace(input.UserText))
	b.WriteString("\nOutput requirements: respect the user's requested subject, action, style, composition, text, and restrictions. Use clear scene, lighting, material, camera, and use-case details when they are implied. Avoid watermark, random extra text, clutter, and unrelated objects.")
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

func DirectPlan(input PlanInput) GenerationPlan {
	input = normalizeInput(input)
	prompt := strings.TrimSpace(input.UserText)
	if section := directCapsulesText(input.Capsules); section != "" {
		prompt = strings.TrimSpace(prompt + "\n\n" + section)
	}
	return GenerationPlan{
		Prompt:           prompt,
		Size:             input.Size,
		Resolution:       input.Resolution,
		Quality:          input.Quality,
		Count:            input.Count,
		AssistantMessage: "已跳过 AI Planner，直接使用你的原始提示词生成。",
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
		input.Size = "1024x1024"
	}
	if input.Resolution == "" {
		input.Resolution = "1K"
	}
	input.Size = validSize(input.Size, "1024x1024", input.Resolution)
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
	plan.Resolution = validEnum(plan.Resolution, input.Resolution, []string{"1K", "2K", "4K"})
	plan.Size = validSize(plan.Size, input.Size, plan.Resolution)
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

func plannerCapsulesText(capsules []PlanCapsule) string {
	if len(capsules) == 0 {
		return ""
	}
	var b strings.Builder
	for _, capsule := range capsules {
		instruction := strings.TrimSpace(capsule.PlannerInstruction)
		if instruction == "" {
			instruction = strings.TrimSpace(capsule.DirectInstruction)
		}
		if instruction == "" {
			continue
		}
		b.WriteString(fmt.Sprintf("- @%s", capsule.CapsuleID))
		if strings.TrimSpace(capsule.Title) != "" {
			b.WriteString(fmt.Sprintf(" (%s)", strings.TrimSpace(capsule.Title)))
		}
		if strings.TrimSpace(capsule.Type) != "" {
			b.WriteString(fmt.Sprintf(", type: %s", strings.TrimSpace(capsule.Type)))
		}
		if len(capsule.Tags) > 0 {
			b.WriteString(fmt.Sprintf(", tags: %s", strings.Join(capsule.Tags, ", ")))
		}
		b.WriteString("\n  Instruction: ")
		b.WriteString(instruction)
		b.WriteString("\n")
	}
	return strings.TrimSpace(b.String())
}

func directCapsulesText(capsules []PlanCapsule) string {
	if len(capsules) == 0 {
		return ""
	}
	var parts []string
	for _, capsule := range capsules {
		instruction := strings.TrimSpace(capsule.DirectInstruction)
		if instruction == "" {
			instruction = strings.TrimSpace(capsule.PlannerInstruction)
		}
		if instruction != "" {
			parts = append(parts, instruction)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return "Attached capsule instructions:\n" + strings.Join(parts, "\n")
}

func defaultPlannerSystemPrompt() string {
	var b strings.Builder
	b.WriteString(`You are PicTu's Planner. Your job is to turn the user's message into a strong image generation or image editing brief, then call generate_image when the user is ready.

Core behavior:
- Follow the user's instructions carefully. Preserve requested subjects, actions, style, composition, text, exclusions, and reference-image relationships.
- Treat the final prompt as a brief for a visual designer, photographer, illustrator, or retoucher. Do not write a vague keyword list.
- If the user is still exploring, asks a question, or leaves the actual image request too unclear, continue the conversation without calling generate_image.
- If the user asks to create, draw, generate, edit, redesign, restyle, replace, add, remove, or modify an image, call generate_image.
- Use explicit task verbs in the final prompt: Generate, Draw, Create, Edit, Replace, Remove, Add, Restyle, or similar.
- For reference images, describe what each image is used for by order. Say what must be preserved and what must change.
- For multi-image edits, avoid vague combine/merge language. Use concrete instructions such as "Edit image 1 by adding the subject from image 2..."
- If there is text in the image, quote the exact text and state its approximate position and visual treatment. Also avoid adding text when none was requested.
- Do not invent brand names, logos, identities, faces, UI copy, labels, or copyrighted characters unless the user requested them or they are visible in a reference image.
- Keep safety-neutral visual details rich: subject, action/state, environment, time of day, lighting, material, mood, composition, lens/camera angle, color palette, and intended use.

Capsules:
- Attached capsules are reusable prompt assets selected by the user.
- Treat capsule instructions as intentional requirements. Blend them into the final prompt naturally instead of copying them as a separate checklist.
- If multiple capsules overlap, preserve the user's latest message and combine compatible capsule details. If there is a conflict, prefer the user's message and the most specific capsule.
- Do not mention capsule IDs in the final prompt unless the user explicitly asks for the asset name.

Final prompt shape:
Generate/Edit [image type] of [subject] [action/state],
in [scene/environment], with [composition/camera/viewpoint],
using [style/medium/material/lighting/color].
Must include: [required elements].
Preserve: [reference elements that must stay].
Avoid: [unwanted elements].
Text, if any: [exact text, placement, font feeling].
Use case: [poster/product image/avatar/UI asset/book illustration/etc.].

Tool and parameter rules:
- CURRENT SETTINGS are a reference baseline, not a hard rule. Keep them unless the user's creative goal benefits from a better size, resolution, quality, or count.
- When calling generate_image, fill every tool argument: prompt, size, resolution, quality, count, and assistant_message. If you keep a current setting, repeat its value explicitly.
- If tool arguments differ from CURRENT SETTINGS, the UI will ask the user to confirm before generating.
- Put size, resolution, quality, output count, file format, compression, and background mode in tool parameters when parameters exist. Do not rely on the prompt for those.
- The prompt should be complete enough that the image model can act without reading the conversation.
- assistant_message should be brief, natural, and in the user's language. Mention notable parameter changes only when useful.`)
	return b.String()
}

func plannerSystemPrompt(customPrompt string, canSeeImages bool, input PlanInput) string {
	base := strings.TrimSpace(customPrompt)
	if base == "" {
		base = defaultPlannerSystemPrompt()
	}
	base = renderPlannerPromptTemplate(base, input)
	var b strings.Builder
	b.WriteString(base)
	b.WriteString("\n\nRuntime capability:\n")
	if canSeeImages {
		b.WriteString("- Reference images may be attached. You can inspect them directly and should use their visual content, order, and relationships when relevant.\n")
	} else {
		b.WriteString("- You cannot see pixels in uploaded images. You only know image order, file names, and what the user says about them.\n")
	}
	return b.String()
}

func renderPlannerPromptTemplate(prompt string, input PlanInput) string {
	if !strings.Contains(prompt, "{{") {
		return prompt
	}
	replacements := map[string]string{
		"{{capsules}}":         plannerPromptCapsulesBlock(input.Capsules),
		"{{user_message}}":     strings.TrimSpace(input.UserText),
		"{{current_settings}}": fmt.Sprintf("size: %s\nresolution: %s\nquality: %s\ncount: %d", input.Size, input.Resolution, input.Quality, input.Count),
		"{{reference_images}}": strings.Join(input.ImageNames, "\n"),
	}
	out := prompt
	for tag, value := range replacements {
		out = strings.ReplaceAll(out, tag, value)
	}
	return out
}

func plannerPromptCapsulesBlock(capsules []PlanCapsule) string {
	text := plannerCapsulesText(capsules)
	if text == "" {
		return "No capsules are attached."
	}
	return text
}

func userPlanningPrompt(input PlanInput) string {
	var b strings.Builder
	b.WriteString("CURRENT SETTINGS (reference baseline; you may adjust if the request benefits from it):\n")
	b.WriteString(fmt.Sprintf("- size: %s\n- resolution: %s\n- quality: %s\n- count: %d\n", input.Size, input.Resolution, input.Quality, input.Count))
	b.WriteString("AVAILABLE TOOL PARAMETER VALUES:\n")
	b.WriteString("- size: explicit pixels like 1024x1024, 1024x1536, 1536x1024, 1344x1792. Keep both sides as multiples of 16.\n")
	b.WriteString("- resolution: 1K, 2K, 4K\n")
	b.WriteString("- quality: low, medium, high\n")
	b.WriteString("- count: integer 1 to 4\n")
	if len(input.ImageNames) > 0 {
		b.WriteString("REFERENCE IMAGES:\n")
		for i, name := range input.ImageNames {
			b.WriteString(fmt.Sprintf("- image %d: %s\n", i+1, name))
		}
	}
	if section := plannerCapsulesText(input.Capsules); section != "" {
		b.WriteString("ATTACHED CAPSULES:\n")
		b.WriteString(section)
		b.WriteString("\n")
	}
	b.WriteString("USER MESSAGE:\n")
	b.WriteString(input.UserText)
	return b.String()
}

func userPlanningContent(input PlanInput, supportsVision bool) any {
	if !supportsVision || len(input.ImageURLs) == 0 {
		return userPlanningPrompt(input)
	}
	content := []chatContentPart{{Type: "text", Text: userPlanningPrompt(input)}}
	for _, url := range input.ImageURLs {
		if strings.TrimSpace(url) == "" {
			continue
		}
		content = append(content, chatContentPart{
			Type: "image_url",
			ImageURL: &chatImageURLPart{
				URL:    url,
				Detail: "auto",
			},
		})
	}
	return content
}

func generateImageTool() toolDef {
	return toolDef{
		Type: "function",
		Function: functionDef{
			Name:        "generate_image",
			Description: "Create or edit an image with GPT Image 2. Call this only when the user is ready to generate.",
			Parameters: map[string]any{
				"type":     "object",
				"required": []string{"prompt", "size", "resolution", "quality", "count", "assistant_message"},
				"properties": map[string]any{
					"prompt": map[string]any{
						"type":        "string",
						"description": "Final image generation/editing prompt. Include reference image usage by order when relevant.",
					},
					"size": map[string]any{
						"type":        "string",
						"description": "Selected output size in pixels, such as 1024x1024, 1024x1536, or 1536x1024. Keep both dimensions as multiples of 16.",
					},
					"resolution": map[string]any{
						"type":        "string",
						"enum":        []string{"1K", "2K", "4K"},
						"description": "Selected resolution tier. Use current setting as a reference, but choose the best value for the request.",
					},
					"quality": map[string]any{
						"type":        "string",
						"enum":        []string{"low", "medium", "high"},
						"description": "Selected quality. Use current setting as a reference. Choose high when fidelity matters, low for cheap drafts, medium for normal output.",
					},
					"count": map[string]any{
						"type":        "integer",
						"minimum":     1,
						"maximum":     4,
						"description": "Selected number of outputs from 1 to 4. Use current setting as a reference, but adjust if variety is useful.",
					},
					"assistant_message": map[string]any{
						"type":        "string",
						"description": "Brief message shown to the user before/with the generated prompt. Mention notable parameter changes naturally if you made any.",
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

func appendChatMessageContent(current any, next string) any {
	if next == "" {
		return current
	}
	switch value := current.(type) {
	case string:
		return value + next
	case nil:
		return next
	default:
		return next
	}
}

func messageText(content any) string {
	if text, ok := content.(string); ok {
		return text
	}
	return ""
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

func validSize(value, fallback, resolution string) string {
	if normalized, ok := normalizePixelSize(value); ok {
		return normalized
	}
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		return rightCodesImageSize(trimmed, resolution)
	}
	if normalized, ok := normalizePixelSize(fallback); ok {
		return normalized
	}
	if trimmed := strings.TrimSpace(fallback); trimmed != "" {
		return rightCodesImageSize(trimmed, resolution)
	}
	return rightCodesImageSize("auto", resolution)
}
