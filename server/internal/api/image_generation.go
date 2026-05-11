package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"pictu/server/internal/evolink"
	"pictu/server/internal/store"
)

func (s *Server) createImageTask(ctx context.Context, provider RuntimeImageProvider, req evolink.ImageRequest) (evolink.TaskResponse, error) {
	switch provider.Type {
	case "", "evolink":
		client := evolink.New(runtimeEvolinkConfig(s.cfg.Evolink, provider))
		return client.CreateImage(ctx, req)
	case "right_codes":
		return createRightCodesImageTask(ctx, provider, req)
	default:
		return evolink.TaskResponse{}, fmt.Errorf("unsupported image provider type: %s", provider.Type)
	}
}

func createRightCodesImageTask(ctx context.Context, provider RuntimeImageProvider, req evolink.ImageRequest) (evolink.TaskResponse, error) {
	body := rightCodesImageRequest{
		Model:          provider.Model,
		Prompt:         req.Prompt,
		Image:          append([]string(nil), req.ImageURLs...),
		Size:           rightCodesImageSize(req.Size, req.Resolution),
		N:              req.N,
		ResponseFormat: "url",
	}
	if body.Model == "" {
		body.Model = "gpt-image-2"
	}
	if body.N <= 0 {
		body.N = 1
	}
	if len(body.Image) == 0 {
		body.Image = nil
	}

	data, err := json.Marshal(body)
	if err != nil {
		return evolink.TaskResponse{}, err
	}
	url := strings.TrimRight(provider.BaseURL, "/") + "/v1/images/generations"
	reqHTTP, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return evolink.TaskResponse{}, err
	}
	reqHTTP.Header.Set("Authorization", "Bearer "+provider.APIKey)
	reqHTTP.Header.Set("Content-Type", "application/json")
	reqHTTP.Header.Set("Accept", "application/json")

	client := http.Client{Timeout: 90 * time.Second}
	resp, err := client.Do(reqHTTP)
	if err != nil {
		return evolink.TaskResponse{}, err
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return evolink.TaskResponse{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return evolink.TaskResponse{}, fmt.Errorf("right codes image api error %d: %s", resp.StatusCode, strings.TrimSpace(string(payload)))
	}
	var out rightCodesImageResponse
	if err := json.Unmarshal(payload, &out); err != nil {
		return evolink.TaskResponse{}, err
	}
	results := make([]string, 0, len(out.Data))
	for _, item := range out.Data {
		if strings.TrimSpace(item.URL) != "" {
			results = append(results, item.URL)
		}
	}
	return evolink.TaskResponse{
		Created:  out.Created,
		ID:       uuid.NewString(),
		Model:    body.Model,
		Object:   "image_generation",
		Progress: 100,
		Results:  results,
		Status:   "completed",
		Type:     "image",
		Usage:    out.Usage,
	}, nil
}

func (s *Server) storeCompletedImageTask(ctx context.Context, user store.User, sessionID int64, task evolink.TaskResponse) string {
	resultJSON, _ := json.Marshal(task)
	archived, finished := s.archiveTaskImages(ctx, task.ID, string(resultJSON))
	for _, item := range archived {
		if existing, err := s.store.FindAssetByHash(ctx, user, sessionID, "generated", item.ContentHash); err == nil {
			_ = s.store.TouchAssetsUsed(ctx, user, []int64{existing.ID})
			continue
		}
		_, _ = s.store.SaveAsset(ctx, user, sessionID, item.FileName, item.MIMEType, item.URL, item.LocalURL, item.SizeBytes, "generated", item.ContentHash)
	}
	_ = s.store.UpdateTask(ctx, task.ID, task.Status, task.Progress, finished, "")
	return finished
}

type rightCodesImageRequest struct {
	Model          string   `json:"model,omitempty"`
	Prompt         string   `json:"prompt"`
	Image          []string `json:"image,omitempty"`
	Size           string   `json:"size,omitempty"`
	N              int      `json:"n,omitempty"`
	ResponseFormat string   `json:"response_format,omitempty"`
}

type rightCodesImageResponse struct {
	Created int64 `json:"created"`
	Data    []struct {
		URL string `json:"url"`
	} `json:"data"`
	Usage any `json:"usage,omitempty"`
}

func rightCodesImageSize(size, resolution string) string {
	if normalized, ok := normalizePixelSize(size); ok {
		return normalized
	}
	base := 1024
	switch strings.ToUpper(strings.TrimSpace(resolution)) {
	case "2K":
		base = 2048
	case "4K":
		base = 4096
	}
	ratio := strings.TrimSpace(size)
	if ratio == "" || strings.EqualFold(ratio, "auto") || ratio == "1:1" {
		return fmt.Sprintf("%dx%d", base, base)
	}
	parts := strings.Split(ratio, ":")
	if len(parts) != 2 {
		return fmt.Sprintf("%dx%d", base, base)
	}
	w, err1 := parseFloat(parts[0])
	h, err2 := parseFloat(parts[1])
	if err1 != nil || err2 != nil || w <= 0 || h <= 0 {
		return fmt.Sprintf("%dx%d", base, base)
	}
	if w >= h {
		width := roundToMultipleFloat(float64(base)*(w/h), 16)
		if width <= 0 {
			width = base
		}
		return fmt.Sprintf("%dx%d", width, base)
	}
	height := roundToMultipleFloat(float64(base)*(h/w), 16)
	if height <= 0 {
		height = base
	}
	return fmt.Sprintf("%dx%d", base, height)
}

func normalizePixelSize(value string) (string, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", false
	}
	parts := strings.FieldsFunc(trimmed, func(r rune) bool { return r == 'x' || r == 'X' || r == '×' })
	if len(parts) != 2 {
		return "", false
	}
	width, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
	height, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err1 != nil || err2 != nil || width <= 0 || height <= 0 {
		return "", false
	}
	return fmt.Sprintf("%dx%d", roundToMultiple(width, 16), roundToMultiple(height, 16)), true
}

func roundToMultiple(value, multiple int) int {
	if multiple <= 0 {
		multiple = 16
	}
	if value < 64 {
		return 64
	}
	remainder := value % multiple
	if remainder == 0 {
		return value
	}
	lower := value - remainder
	upper := lower + multiple
	if value-lower < upper-value {
		return lower
	}
	return upper
}

func roundToMultipleFloat(value float64, multiple int) int {
	return roundToMultiple(int(value+0.5), multiple)
}

func parseFloat(value string) (float64, error) {
	return strconv.ParseFloat(strings.TrimSpace(value), 64)
}
