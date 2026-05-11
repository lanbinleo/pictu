package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strings"
	"time"

	"pictu/server/internal/config"
	"pictu/server/internal/store"
)

const runtimeSettingsKey = "runtime"

type RuntimeSettings struct {
	Billing         RuntimeBilling          `json:"billing"`
	Defaults        RuntimeDefaults         `json:"defaults"`
	Prompts         RuntimePrompts          `json:"prompts,omitempty"`
	LLMProviders    []RuntimeLLMProvider    `json:"llm_providers"`
	UploadProviders []RuntimeUploadProvider `json:"upload_providers"`
	ImageProviders  []RuntimeImageProvider  `json:"image_providers"`
}

type RuntimeBilling struct {
	SignupCredits         int     `json:"signup_credits"`
	LLMBaseCost           int     `json:"llm_base_cost"`
	ImageBaseCost         int     `json:"image_base_cost"`
	ImageInputCost        int     `json:"image_input_cost"`
	HighQualityMultiplier float64 `json:"high_quality_multiplier"`
	LowQualityMultiplier  float64 `json:"low_quality_multiplier"`
}

type RuntimeDefaults struct {
	PlannerProvider string `json:"planner_provider"`
	PlannerModel    string `json:"planner_model"`
	TitleProvider   string `json:"title_provider"`
	TitleModel      string `json:"title_model"`
	UploadProvider  string `json:"upload_provider"`
	ImageProvider   string `json:"image_provider"`
}

type RuntimePrompts struct {
	PlannerSystemPrompt string `json:"planner_system_prompt"`
}

type RuntimeLLMProvider struct {
	ID                 string  `json:"id"`
	Name               string  `json:"name"`
	Type               string  `json:"type"`
	BaseURL            string  `json:"base_url"`
	APIKey             string  `json:"api_key"`
	PlannerModel       string  `json:"planner_model"`
	TitleModel         string  `json:"title_model"`
	TimeoutSeconds     int     `json:"timeout_seconds"`
	MaxContextMessages int     `json:"max_context_messages"`
	CreditMultiplier   float64 `json:"credit_multiplier"`
	SupportsVision     bool    `json:"supports_vision"`
	AllowUserSelect    *bool   `json:"allow_user_select,omitempty"`
	Enabled            bool    `json:"enabled"`
}

type RuntimeUploadProvider struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	BaseURL    string `json:"base_url"`
	Token      string `json:"token"`
	StrategyID int    `json:"strategy_id"`
	Enabled    bool   `json:"enabled"`
}

type RuntimeImageProvider struct {
	ID                string  `json:"id"`
	Name              string  `json:"name"`
	Type              string  `json:"type"`
	BaseURL           string  `json:"base_url"`
	FilesBaseURL      string  `json:"files_base_url"`
	APIKey            string  `json:"api_key"`
	Model             string  `json:"model"`
	CreditMultiplier  float64 `json:"credit_multiplier"`
	AllowUserSelect   *bool   `json:"allow_user_select,omitempty"`
	UseBuiltinStorage bool    `json:"use_builtin_storage"`
	Enabled           bool    `json:"enabled"`
}

type RuntimeLLMModel struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	SupportsVision bool   `json:"supports_vision"`
}

func runtimeSettingsFromConfig(cfg config.Config) RuntimeSettings {
	llmID := "default"
	llmType := strings.TrimSpace(cfg.LLM.Provider)
	if llmType == "" {
		llmType = "builtin"
	}
	timeout := cfg.LLM.TimeoutSeconds
	if timeout <= 0 {
		timeout = 45
	}
	maxContext := cfg.LLM.MaxContextMessages
	if maxContext <= 0 {
		maxContext = 12
	}

	rightCodesKey := rightCodesAPIKey()
	settings := RuntimeSettings{
		Billing: RuntimeBilling{
			SignupCredits:         cfg.Billing.SignupCredits,
			LLMBaseCost:           1,
			ImageBaseCost:         cfg.Billing.ImageBaseCost,
			ImageInputCost:        cfg.Billing.ImageInputCost,
			HighQualityMultiplier: cfg.Billing.HighQualityMultiplier,
			LowQualityMultiplier:  cfg.Billing.LowQualityMultiplier,
		},
		Defaults: RuntimeDefaults{
			PlannerProvider: llmID,
			PlannerModel:    cfg.LLM.PlannerModel,
			TitleProvider:   llmID,
			TitleModel:      cfg.LLM.TitleModel,
			UploadProvider:  cfg.Upload.DefaultProvider,
			ImageProvider:   "evolink",
		},
		Prompts: RuntimePrompts{
			PlannerSystemPrompt: cfg.LLM.PlannerSystemPrompt,
		},
		LLMProviders: []RuntimeLLMProvider{{
			ID:                 llmID,
			Name:               "Default LLM",
			Type:               llmType,
			BaseURL:            cfg.LLM.BaseURL,
			APIKey:             cfg.LLM.APIKey,
			PlannerModel:       cfg.LLM.PlannerModel,
			TitleModel:         cfg.LLM.TitleModel,
			TimeoutSeconds:     timeout,
			MaxContextMessages: maxContext,
			CreditMultiplier:   1,
			SupportsVision:     cfg.LLM.SupportsVision,
			AllowUserSelect:    boolPtr(true),
			Enabled:            true,
		}, {
			ID:                 "openrouter",
			Name:               "OpenRouter",
			Type:               "openai_compatible",
			BaseURL:            "https://openrouter.ai/api/v1",
			APIKey:             "",
			PlannerModel:       "",
			TitleModel:         "",
			TimeoutSeconds:     timeout,
			MaxContextMessages: maxContext,
			CreditMultiplier:   1,
			SupportsVision:     true,
			AllowUserSelect:    boolPtr(true),
			Enabled:            false,
		}},
		ImageProviders: []RuntimeImageProvider{{
			ID:               "evolink",
			Name:             "Evolink",
			Type:             "evolink",
			BaseURL:          cfg.Evolink.BaseURL,
			FilesBaseURL:     cfg.Evolink.FilesBaseURL,
			APIKey:           cfg.Evolink.APIKey,
			Model:            cfg.Evolink.Model,
			CreditMultiplier: 1,
			AllowUserSelect:  boolPtr(true),
			Enabled:          true,
		}, {
			ID:                "right-codes",
			Name:              "Right Code 1K",
			Type:              "right_codes",
			BaseURL:           "https://www.right.codes/draw",
			APIKey:            rightCodesKey,
			Model:             "gpt-image-2",
			CreditMultiplier:  1,
			AllowUserSelect:   boolPtr(true),
			UseBuiltinStorage: true,
			Enabled:           true,
		}, {
			ID:                "right-codes-vip",
			Name:              "Right Code VIP",
			Type:              "right_codes",
			BaseURL:           "https://www.right.codes/draw",
			APIKey:            rightCodesKey,
			Model:             "gpt-image-2-vip",
			CreditMultiplier:  2,
			AllowUserSelect:   boolPtr(true),
			UseBuiltinStorage: true,
			Enabled:           true,
		}},
	}

	for id, provider := range cfg.Upload.Providers {
		settings.UploadProviders = append(settings.UploadProviders, RuntimeUploadProvider{
			ID:         id,
			Name:       id,
			Type:       provider.Type,
			BaseURL:    provider.BaseURL,
			Token:      provider.Token,
			StrategyID: provider.StrategyID,
			Enabled:    true,
		})
	}
	if len(settings.UploadProviders) == 0 {
		settings.UploadProviders = append(settings.UploadProviders, RuntimeUploadProvider{ID: "evolink", Name: "evolink", Type: "evolink", Enabled: true})
		settings.Defaults.UploadProvider = "evolink"
	}
	return normalizeRuntimeSettings(settings)
}

func (s *Server) ensureRuntimeSettings(ctx context.Context) error {
	data, err := json.Marshal(runtimeSettingsFromConfig(s.cfg))
	if err != nil {
		return err
	}
	return s.store.EnsureSystemSetting(ctx, runtimeSettingsKey, string(data))
}

func (s *Server) runtimeSettings(ctx context.Context) (RuntimeSettings, error) {
	value, err := s.store.GetSystemSetting(ctx, runtimeSettingsKey)
	if errors.Is(err, store.ErrNotFound) {
		settings := runtimeSettingsFromConfig(s.cfg)
		data, marshalErr := json.Marshal(settings)
		if marshalErr == nil {
			_ = s.store.SaveSystemSetting(ctx, runtimeSettingsKey, string(data))
		}
		return settings, nil
	}
	if err != nil {
		return RuntimeSettings{}, err
	}
	var settings RuntimeSettings
	if err := json.Unmarshal([]byte(value), &settings); err != nil {
		return RuntimeSettings{}, err
	}
	return normalizeRuntimeSettings(settings), nil
}

func (s *Server) saveRuntimeSettings(ctx context.Context, settings RuntimeSettings) (RuntimeSettings, error) {
	settings = normalizeRuntimeSettings(settings)
	data, err := json.Marshal(settings)
	if err != nil {
		return RuntimeSettings{}, err
	}
	if err := s.store.SaveSystemSetting(ctx, runtimeSettingsKey, string(data)); err != nil {
		return RuntimeSettings{}, err
	}
	return settings, nil
}

func normalizeRuntimeSettings(settings RuntimeSettings) RuntimeSettings {
	if strings.TrimSpace(settings.Prompts.PlannerSystemPrompt) == "" {
		settings.Prompts.PlannerSystemPrompt = defaultPlannerSystemPrompt()
	}
	if settings.Billing.SignupCredits < 0 {
		settings.Billing.SignupCredits = 0
	}
	if settings.Billing.LLMBaseCost <= 0 {
		settings.Billing.LLMBaseCost = 1
	}
	if settings.Billing.ImageBaseCost <= 0 {
		settings.Billing.ImageBaseCost = 1
	}
	if settings.Billing.ImageInputCost < 0 {
		settings.Billing.ImageInputCost = 0
	}
	if settings.Billing.HighQualityMultiplier <= 0 {
		settings.Billing.HighQualityMultiplier = 1
	}
	if settings.Billing.LowQualityMultiplier <= 0 {
		settings.Billing.LowQualityMultiplier = 1
	}
	for i := range settings.LLMProviders {
		settings.LLMProviders[i].ID = cleanID(settings.LLMProviders[i].ID)
		if settings.LLMProviders[i].Name == "" {
			settings.LLMProviders[i].Name = settings.LLMProviders[i].ID
		}
		if settings.LLMProviders[i].Type == "" {
			settings.LLMProviders[i].Type = "builtin"
		}
		if settings.LLMProviders[i].TimeoutSeconds <= 0 {
			settings.LLMProviders[i].TimeoutSeconds = 45
		}
		if settings.LLMProviders[i].MaxContextMessages <= 0 {
			settings.LLMProviders[i].MaxContextMessages = 12
		}
		if settings.LLMProviders[i].CreditMultiplier <= 0 {
			settings.LLMProviders[i].CreditMultiplier = 1
		}
		if settings.LLMProviders[i].AllowUserSelect == nil {
			settings.LLMProviders[i].AllowUserSelect = boolPtr(true)
		}
	}
	for i := range settings.UploadProviders {
		settings.UploadProviders[i].ID = cleanID(settings.UploadProviders[i].ID)
		if settings.UploadProviders[i].Name == "" {
			settings.UploadProviders[i].Name = settings.UploadProviders[i].ID
		}
		if settings.UploadProviders[i].Type == "" {
			settings.UploadProviders[i].Type = "evolink"
		}
	}
	for i := range settings.ImageProviders {
		settings.ImageProviders[i].ID = cleanID(settings.ImageProviders[i].ID)
		if settings.ImageProviders[i].Name == "" {
			settings.ImageProviders[i].Name = settings.ImageProviders[i].ID
		}
		if settings.ImageProviders[i].Type == "" {
			settings.ImageProviders[i].Type = "evolink"
		}
		if settings.ImageProviders[i].CreditMultiplier <= 0 {
			settings.ImageProviders[i].CreditMultiplier = 1
		}
		if settings.ImageProviders[i].AllowUserSelect == nil {
			settings.ImageProviders[i].AllowUserSelect = boolPtr(true)
		}
		if settings.ImageProviders[i].Type == "right_codes" && settings.ImageProviders[i].APIKey == "" {
			settings.ImageProviders[i].APIKey = rightCodesAPIKey()
		}
		if settings.ImageProviders[i].Type == "right_codes" && settings.ImageProviders[i].BaseURL == "" {
			settings.ImageProviders[i].BaseURL = "https://www.right.codes/draw"
		}
		if settings.ImageProviders[i].Type == "right_codes" && settings.ImageProviders[i].Model == "" {
			settings.ImageProviders[i].Model = "gpt-image-2"
		}
		if settings.ImageProviders[i].Type == "right_codes" && settings.ImageProviders[i].FilesBaseURL == "" {
			settings.ImageProviders[i].UseBuiltinStorage = true
		}
	}
	settings = ensureBuiltinImageProviders(settings)
	hasOpenRouter := false
	for _, provider := range settings.LLMProviders {
		if provider.ID == "openrouter" {
			hasOpenRouter = true
			break
		}
	}
	if !hasOpenRouter {
		settings.LLMProviders = append(settings.LLMProviders, RuntimeLLMProvider{
			ID:                 "openrouter",
			Name:               "OpenRouter",
			Type:               "openai_compatible",
			BaseURL:            "https://openrouter.ai/api/v1",
			TimeoutSeconds:     45,
			MaxContextMessages: 12,
			CreditMultiplier:   1,
			SupportsVision:     true,
			AllowUserSelect:    boolPtr(true),
			Enabled:            false,
		})
	}
	settings.Defaults.PlannerProvider = cleanID(settings.Defaults.PlannerProvider)
	settings.Defaults.TitleProvider = cleanID(settings.Defaults.TitleProvider)
	settings.Defaults.UploadProvider = cleanID(settings.Defaults.UploadProvider)
	settings.Defaults.ImageProvider = cleanID(settings.Defaults.ImageProvider)
	if settings.Defaults.PlannerProvider == "" && len(settings.LLMProviders) > 0 {
		settings.Defaults.PlannerProvider = settings.LLMProviders[0].ID
	}
	if settings.Defaults.TitleProvider == "" {
		settings.Defaults.TitleProvider = settings.Defaults.PlannerProvider
	}
	if settings.Defaults.UploadProvider == "" && len(settings.UploadProviders) > 0 {
		settings.Defaults.UploadProvider = settings.UploadProviders[0].ID
	}
	if settings.Defaults.ImageProvider == "" && len(settings.ImageProviders) > 0 {
		settings.Defaults.ImageProvider = settings.ImageProviders[0].ID
	}
	return settings
}

func ensureBuiltinImageProviders(settings RuntimeSettings) RuntimeSettings {
	rightCodesKey := rightCodesAPIKey()
	required := []RuntimeImageProvider{
		{
			ID:                "right-codes",
			Name:              "Right Code 1K",
			Type:              "right_codes",
			BaseURL:           "https://www.right.codes/draw",
			APIKey:            rightCodesKey,
			Model:             "gpt-image-2",
			CreditMultiplier:  1,
			AllowUserSelect:   boolPtr(true),
			UseBuiltinStorage: true,
			Enabled:           true,
		},
		{
			ID:                "right-codes-vip",
			Name:              "Right Code VIP",
			Type:              "right_codes",
			BaseURL:           "https://www.right.codes/draw",
			APIKey:            rightCodesKey,
			Model:             "gpt-image-2-vip",
			CreditMultiplier:  2,
			AllowUserSelect:   boolPtr(true),
			UseBuiltinStorage: true,
			Enabled:           true,
		},
	}
	existing := map[string]bool{}
	for _, provider := range settings.ImageProviders {
		existing[provider.ID] = true
	}
	for _, provider := range required {
		if !existing[provider.ID] {
			settings.ImageProviders = append(settings.ImageProviders, provider)
		}
	}
	return settings
}

func rightCodesAPIKey() string {
	for _, key := range []string{"RIGHT_CODES_API_KEY", "RIGHTCODES_API_KEY"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func boolPtr(v bool) *bool {
	return &v
}

func boolValue(v *bool) bool {
	return v != nil && *v
}

func cleanID(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, " ", "-")
	return value
}

func (settings RuntimeSettings) llmProvider(id string) (RuntimeLLMProvider, bool) {
	id = cleanID(id)
	for _, provider := range settings.LLMProviders {
		if provider.ID == id && provider.Enabled {
			return provider, true
		}
	}
	return RuntimeLLMProvider{}, false
}

func (settings RuntimeSettings) selectableLLMProvider(id string) (RuntimeLLMProvider, bool) {
	provider, ok := settings.llmProvider(id)
	if !ok {
		return RuntimeLLMProvider{}, false
	}
	if boolValue(provider.AllowUserSelect) || provider.ID == settings.Defaults.PlannerProvider {
		return provider, true
	}
	return RuntimeLLMProvider{}, false
}

func (settings RuntimeSettings) uploadProvider(id string) (RuntimeUploadProvider, bool) {
	id = cleanID(id)
	for _, provider := range settings.UploadProviders {
		if provider.ID == id && provider.Enabled {
			return provider, true
		}
	}
	return RuntimeUploadProvider{}, false
}

func (settings RuntimeSettings) imageProvider(id string) (RuntimeImageProvider, bool) {
	id = cleanID(id)
	for _, provider := range settings.ImageProviders {
		if provider.ID == id && provider.Enabled {
			return provider, true
		}
	}
	return RuntimeImageProvider{}, false
}

func (settings RuntimeSettings) selectableImageProvider(id string) (RuntimeImageProvider, bool) {
	provider, ok := settings.imageProvider(id)
	if !ok {
		return RuntimeImageProvider{}, false
	}
	if boolValue(provider.AllowUserSelect) || provider.ID == settings.Defaults.ImageProvider {
		return provider, true
	}
	return RuntimeImageProvider{}, false
}

func plannerConfig(settings RuntimeSettings, providerID, model string) (config.LLMConfig, RuntimeLLMProvider) {
	if providerID == "" {
		providerID = settings.Defaults.PlannerProvider
	}
	provider, ok := settings.selectableLLMProvider(providerID)
	if !ok {
		provider, _ = settings.llmProvider(settings.Defaults.PlannerProvider)
	}
	if model == "" {
		model = settings.Defaults.PlannerModel
	}
	if model == "" {
		model = provider.PlannerModel
	}
	cfg := config.LLMConfig{
		Provider:            provider.Type,
		BaseURL:             provider.BaseURL,
		APIKey:              provider.APIKey,
		PlannerModel:        model,
		PlannerSystemPrompt: settings.Prompts.PlannerSystemPrompt,
		TitleModel:          provider.TitleModel,
		TimeoutSeconds:      provider.TimeoutSeconds,
		MaxContextMessages:  provider.MaxContextMessages,
		SupportsVision:      provider.SupportsVision,
	}
	return cfg, provider
}

func titleConfig(settings RuntimeSettings) config.LLMConfig {
	provider, ok := settings.selectableLLMProvider(settings.Defaults.TitleProvider)
	if !ok {
		provider, _ = settings.llmProvider(settings.Defaults.PlannerProvider)
	}
	model := settings.Defaults.TitleModel
	if model == "" {
		model = provider.TitleModel
	}
	return config.LLMConfig{
		Provider:           provider.Type,
		BaseURL:            provider.BaseURL,
		APIKey:             provider.APIKey,
		PlannerModel:       provider.PlannerModel,
		TitleModel:         model,
		TimeoutSeconds:     provider.TimeoutSeconds,
		MaxContextMessages: provider.MaxContextMessages,
		SupportsVision:     false,
	}
}

func llmCost(base int, multiplier float64) int {
	if base <= 0 {
		base = 1
	}
	if multiplier <= 0 {
		multiplier = 1
	}
	cost := int(math.Ceil(float64(base) * multiplier))
	if cost < 1 {
		return 1
	}
	return cost
}

func multiplyCost(cost int, multiplier float64) int {
	if multiplier <= 0 {
		multiplier = 1
	}
	out := int(math.Ceil(float64(cost) * multiplier))
	if out < 1 {
		return 1
	}
	return out
}

func runtimeEvolinkConfig(base config.EvolinkConfig, provider RuntimeImageProvider) config.EvolinkConfig {
	if provider.APIKey != "" {
		base.APIKey = provider.APIKey
	}
	if provider.BaseURL != "" {
		base.BaseURL = provider.BaseURL
	}
	if provider.FilesBaseURL != "" {
		base.FilesBaseURL = provider.FilesBaseURL
	}
	if provider.Model != "" {
		base.Model = provider.Model
	}
	return base
}

func (provider RuntimeLLMProvider) ref(model string) string {
	if model == "" {
		model = provider.PlannerModel
	}
	if provider.ID == "" {
		return model
	}
	return provider.ID + ":" + model
}

func (settings RuntimeSettings) providerModels(ctx context.Context, providerID string, fallback RuntimeLLMProvider) ([]RuntimeLLMModel, error) {
	provider, ok := settings.selectableLLMProvider(providerID)
	if !ok {
		provider = fallback
	}
	if strings.TrimSpace(provider.BaseURL) == "" || provider.Type != "openai_compatible" {
		return nil, nil
	}
	models, err := fetchLLMModels(ctx, provider)
	if err != nil {
		return nil, err
	}
	return models, nil
}

func fetchLLMModels(ctx context.Context, provider RuntimeLLMProvider) ([]RuntimeLLMModel, error) {
	base := strings.TrimRight(provider.BaseURL, "/")
	if base == "" {
		return nil, fmt.Errorf("base url is required")
	}
	timeout := provider.TimeoutSeconds
	if timeout <= 0 {
		timeout = 30
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/models", nil)
	if err != nil {
		return nil, err
	}
	if provider.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+provider.APIKey)
	}
	if strings.Contains(strings.ToLower(base), "openrouter.ai") {
		req.Header.Set("HTTP-Referer", "http://localhost")
		req.Header.Set("X-Title", "PicTu")
	}
	client := &http.Client{Timeout: time.Duration(timeout) * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("model list error %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var raw struct {
		Data []struct {
			ID           string `json:"id"`
			Name         string `json:"name"`
			Architecture struct {
				InputModalities []string `json:"input_modalities"`
			} `json:"architecture"`
			Modalities []string `json:"modalities"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	models := make([]RuntimeLLMModel, 0, len(raw.Data))
	for _, item := range raw.Data {
		if strings.TrimSpace(item.ID) == "" {
			continue
		}
		model := RuntimeLLMModel{ID: item.ID, Name: item.Name}
		if model.Name == "" {
			model.Name = model.ID
		}
		for _, modality := range append(item.Architecture.InputModalities, item.Modalities...) {
			if strings.EqualFold(modality, "image") || strings.EqualFold(modality, "vision") {
				model.SupportsVision = true
				break
			}
		}
		models = append(models, model)
	}
	return models, nil
}
