package api

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"

	"pictu/server/internal/config"
	"pictu/server/internal/store"
)

const runtimeSettingsKey = "runtime"

type RuntimeSettings struct {
	Billing         RuntimeBilling          `json:"billing"`
	Defaults        RuntimeDefaults         `json:"defaults"`
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
	ID               string  `json:"id"`
	Name             string  `json:"name"`
	Type             string  `json:"type"`
	BaseURL          string  `json:"base_url"`
	FilesBaseURL     string  `json:"files_base_url"`
	APIKey           string  `json:"api_key"`
	Model            string  `json:"model"`
	CreditMultiplier float64 `json:"credit_multiplier"`
	Enabled          bool    `json:"enabled"`
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
			Enabled:            true,
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
			Enabled:          true,
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

func plannerConfig(settings RuntimeSettings, providerID, model string) (config.LLMConfig, RuntimeLLMProvider) {
	if providerID == "" {
		providerID = settings.Defaults.PlannerProvider
	}
	provider, ok := settings.llmProvider(providerID)
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
		Provider:           provider.Type,
		BaseURL:            provider.BaseURL,
		APIKey:             provider.APIKey,
		PlannerModel:       model,
		TitleModel:         provider.TitleModel,
		TimeoutSeconds:     provider.TimeoutSeconds,
		MaxContextMessages: provider.MaxContextMessages,
	}
	return cfg, provider
}

func titleConfig(settings RuntimeSettings) config.LLMConfig {
	provider, ok := settings.llmProvider(settings.Defaults.TitleProvider)
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
