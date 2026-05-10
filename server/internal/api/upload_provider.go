package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"pictu/server/internal/config"
	"pictu/server/internal/evolink"
)

type uploadedImage struct {
	FileName  string
	MIMEType  string
	URL       string
	SizeBytes int64
}

func (s *Server) uploadReferenceImage(ctx context.Context, providerName, fileName, mimeType string, size int64, src io.Reader) (uploadedImage, error) {
	settings, err := s.runtimeSettings(ctx)
	if err != nil {
		return uploadedImage{}, err
	}
	if providerName == "" {
		providerName = settings.Defaults.UploadProvider
	}
	runtimeProvider, ok := settings.uploadProvider(providerName)
	if !ok {
		return uploadedImage{}, fmt.Errorf("unknown upload provider: %s", providerName)
	}
	provider := config.Provider{
		Type:       runtimeProvider.Type,
		BaseURL:    runtimeProvider.BaseURL,
		Token:      runtimeProvider.Token,
		StrategyID: runtimeProvider.StrategyID,
	}
	switch provider.Type {
	case "", "evolink":
		client := s.evolink
		if imageProvider, ok := settings.imageProvider(settings.Defaults.ImageProvider); ok {
			client = evolink.New(runtimeEvolinkConfig(s.cfg.Evolink, imageProvider))
		}
		data, err := client.UploadStream(ctx, fileName, mimeType, src)
		if err != nil {
			return uploadedImage{}, err
		}
		return uploadedImage{FileName: data.OriginalName, MIMEType: data.MIMEType, URL: data.FileURL, SizeBytes: data.FileSize}, nil
	case "lsky":
		return uploadToLsky(ctx, provider, fileName, mimeType, size, src)
	default:
		return uploadedImage{}, fmt.Errorf("unsupported upload provider type: %s", provider.Type)
	}
}

func uploadToLsky(ctx context.Context, provider config.Provider, fileName, mimeType string, size int64, src io.Reader) (uploadedImage, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filepath.Base(fileName))
	if err != nil {
		return uploadedImage{}, err
	}
	if _, err := io.Copy(part, src); err != nil {
		return uploadedImage{}, err
	}
	if provider.StrategyID > 0 {
		_ = writer.WriteField("strategy_id", strconv.Itoa(provider.StrategyID))
	}
	if err := writer.Close(); err != nil {
		return uploadedImage{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(provider.BaseURL, "/")+"/upload", &body)
	if err != nil {
		return uploadedImage{}, err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Accept", "application/json")
	if provider.Token != "" {
		req.Header.Set("Authorization", "Bearer "+provider.Token)
	}
	client := http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return uploadedImage{}, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return uploadedImage{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return uploadedImage{}, fmt.Errorf("upload provider error %d: %s", resp.StatusCode, string(data))
	}
	var out struct {
		Status  bool   `json:"status"`
		Message string `json:"message"`
		Data    struct {
			OriginName string  `json:"origin_name"`
			Size       float64 `json:"size"`
			MIMEType   string  `json:"mimetype"`
			Links      struct {
				URL string `json:"url"`
			} `json:"links"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return uploadedImage{}, err
	}
	if !out.Status {
		return uploadedImage{}, fmt.Errorf("upload provider failed: %s", out.Message)
	}
	sizeBytes := int64(out.Data.Size * 1024)
	if sizeBytes <= 0 {
		sizeBytes = size
	}
	name := out.Data.OriginName
	if name == "" {
		name = fileName
	}
	if out.Data.MIMEType == "" {
		out.Data.MIMEType = mimeType
	}
	return uploadedImage{FileName: name, MIMEType: out.Data.MIMEType, URL: out.Data.Links.URL, SizeBytes: sizeBytes}, nil
}
