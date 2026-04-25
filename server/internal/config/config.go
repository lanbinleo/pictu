package config

import (
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/pelletier/go-toml/v2"
)

type Config struct {
	Server   ServerConfig   `toml:"server"`
	Database DatabaseConfig `toml:"database"`
	Storage  StorageConfig  `toml:"storage"`
	Upload   UploadConfig   `toml:"upload"`
	Billing  BillingConfig  `toml:"billing"`
	Evolink  EvolinkConfig  `toml:"evolink"`
	LLM      LLMConfig      `toml:"llm"`
}

type ServerConfig struct {
	Host         string `toml:"host"`
	Port         int    `toml:"port"`
	FrontendDist string `toml:"frontend_dist"`
	JWTSecret    string `toml:"jwt_secret"`
}

type DatabaseConfig struct {
	Path string `toml:"path"`
}

type StorageConfig struct {
	GeneratedDir string `toml:"generated_dir"`
	PublicPrefix string `toml:"public_prefix"`
}

type UploadConfig struct {
	DefaultProvider string              `toml:"default_provider"`
	Providers       map[string]Provider `toml:"providers"`
}

type Provider struct {
	Type       string `toml:"type"`
	BaseURL    string `toml:"base_url"`
	Token      string `toml:"token"`
	StrategyID int    `toml:"strategy_id"`
}

type BillingConfig struct {
	SignupCredits         int     `toml:"signup_credits"`
	ImageBaseCost         int     `toml:"image_base_cost"`
	ImageInputCost        int     `toml:"image_input_cost"`
	HighQualityMultiplier float64 `toml:"high_quality_multiplier"`
	LowQualityMultiplier  float64 `toml:"low_quality_multiplier"`
}

type EvolinkConfig struct {
	APIKey              string `toml:"api_key"`
	BaseURL             string `toml:"base_url"`
	FilesBaseURL        string `toml:"files_base_url"`
	Model               string `toml:"model"`
	PollIntervalSeconds int    `toml:"poll_interval_seconds"`
	PollTimeoutSeconds  int    `toml:"poll_timeout_seconds"`
}

type LLMConfig struct {
	Provider           string `toml:"provider"`
	BaseURL            string `toml:"base_url"`
	APIKey             string `toml:"api_key"`
	Model              string `toml:"model"`
	PlannerModel       string `toml:"planner_model"`
	TitleModel         string `toml:"title_model"`
	TimeoutSeconds     int    `toml:"timeout_seconds"`
	MaxContextMessages int    `toml:"max_context_messages"`
}

func Load() (Config, error) {
	path := os.Getenv("PICTU_CONFIG")
	if path == "" {
		for _, candidate := range []string{"../config.toml", "config.toml"} {
			if _, err := os.Stat(candidate); err == nil {
				path = candidate
				break
			}
		}
	}
	if path == "" {
		return Config{}, errors.New("config.toml not found; copy config.example.toml first")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}

	var cfg Config
	if err := toml.Unmarshal(data, &cfg); err != nil {
		return Config{}, err
	}
	cfg.applyDefaults()
	cfg.Server.FrontendDist = cleanRelative(path, cfg.Server.FrontendDist)
	cfg.Database.Path = cleanRelative(path, cfg.Database.Path)
	cfg.Storage.GeneratedDir = cleanRelative(path, cfg.Storage.GeneratedDir)
	return cfg, nil
}

func (c *Config) applyDefaults() {
	if c.Server.Host == "" {
		c.Server.Host = "0.0.0.0"
	}
	if c.Server.Port == 0 {
		c.Server.Port = 8080
	}
	if c.Server.JWTSecret == "" {
		c.Server.JWTSecret = "dev-secret-change-me"
	}
	if c.Server.FrontendDist == "" {
		c.Server.FrontendDist = "../web/dist"
	}
	if c.Database.Path == "" {
		c.Database.Path = "../pictu.db"
	}
	if c.Storage.GeneratedDir == "" {
		c.Storage.GeneratedDir = "generated"
	}
	if c.Storage.PublicPrefix == "" {
		c.Storage.PublicPrefix = "/generated"
	}
	if c.Upload.DefaultProvider == "" {
		c.Upload.DefaultProvider = "evolink"
	}
	if c.Upload.Providers == nil {
		c.Upload.Providers = map[string]Provider{}
	}
	if _, ok := c.Upload.Providers["evolink"]; !ok {
		c.Upload.Providers["evolink"] = Provider{Type: "evolink"}
	}
	if _, ok := c.Upload.Providers["maxqi"]; !ok {
		c.Upload.Providers["maxqi"] = Provider{Type: "lsky", BaseURL: "https://p.maxqi.top/api/v1"}
	}
	if c.Billing.SignupCredits == 0 {
		c.Billing.SignupCredits = 20
	}
	if c.Billing.ImageBaseCost == 0 {
		c.Billing.ImageBaseCost = 2
	}
	if c.Billing.ImageInputCost == 0 {
		c.Billing.ImageInputCost = 1
	}
	if c.Billing.HighQualityMultiplier == 0 {
		c.Billing.HighQualityMultiplier = 4
	}
	if c.Billing.LowQualityMultiplier == 0 {
		c.Billing.LowQualityMultiplier = 0.25
	}
	if c.Evolink.BaseURL == "" {
		c.Evolink.BaseURL = "https://api.evolink.ai"
	}
	if c.Evolink.FilesBaseURL == "" {
		c.Evolink.FilesBaseURL = "https://files-api.evolink.ai"
	}
	if c.Evolink.Model == "" {
		c.Evolink.Model = "gpt-image-2"
	}
	if c.Evolink.PollIntervalSeconds == 0 {
		c.Evolink.PollIntervalSeconds = 3
	}
	if c.Evolink.PollTimeoutSeconds == 0 {
		c.Evolink.PollTimeoutSeconds = 180
	}
	if c.LLM.Provider == "" {
		c.LLM.Provider = "builtin"
	}
	if c.LLM.PlannerModel == "" {
		c.LLM.PlannerModel = c.LLM.Model
	}
	if c.LLM.TitleModel == "" {
		c.LLM.TitleModel = c.LLM.Model
	}
	if c.LLM.TimeoutSeconds == 0 {
		c.LLM.TimeoutSeconds = 45
	}
	if c.LLM.MaxContextMessages == 0 {
		c.LLM.MaxContextMessages = 12
	}
}

func cleanRelative(configPath, value string) string {
	if value == "" || filepath.IsAbs(value) {
		return value
	}
	return filepath.Clean(filepath.Join(filepath.Dir(configPath), value))
}

func (e EvolinkConfig) PollInterval() time.Duration {
	return time.Duration(e.PollIntervalSeconds) * time.Second
}

func (e EvolinkConfig) PollTimeout() time.Duration {
	return time.Duration(e.PollTimeoutSeconds) * time.Second
}
