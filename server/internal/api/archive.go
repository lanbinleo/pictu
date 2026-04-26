package api

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var imageURLPattern = regexp.MustCompile(`(?i)^https?://.+\.(png|jpe?g|webp)(\?.*)?$`)

func (s *Server) archiveTaskImages(ctx context.Context, providerTaskID string, resultJSON string) string {
	urls := extractRemoteImageURLs(resultJSON)
	if len(urls) == 0 {
		return resultJSON
	}
	if err := os.MkdirAll(s.cfg.Storage.GeneratedDir, 0755); err != nil {
		return resultJSON
	}
	client := http.Client{Timeout: 90 * time.Second}
	var localURLs []string
	for i, remoteURL := range urls {
		localURL, err := s.downloadImage(ctx, client, providerTaskID, i, remoteURL)
		if err == nil && localURL != "" {
			localURLs = append(localURLs, localURL)
		}
	}
	if len(localURLs) == 0 {
		return resultJSON
	}
	var root any
	if err := json.Unmarshal([]byte(resultJSON), &root); err != nil {
		return resultJSON
	}
	if obj, ok := root.(map[string]any); ok {
		values := make([]any, 0, len(localURLs))
		for _, item := range localURLs {
			values = append(values, item)
		}
		obj["pictu_local_urls"] = values
		if data, err := json.Marshal(obj); err == nil {
			return string(data)
		}
	}
	return resultJSON
}

func (s *Server) downloadImage(ctx context.Context, client http.Client, taskID string, index int, remoteURL string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, remoteURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("download image status %d", resp.StatusCode)
	}
	ext := extensionFromURL(remoteURL, resp.Header.Get("Content-Type"))
	hash := sha1.Sum([]byte(remoteURL))
	name := fmt.Sprintf("%s-%02d-%s%s", sanitizeFilePart(taskID), index+1, hex.EncodeToString(hash[:])[:10], ext)
	target := filepath.Join(s.cfg.Storage.GeneratedDir, name)
	file, err := os.Create(target)
	if err != nil {
		return "", err
	}
	defer file.Close()
	if _, err := io.Copy(file, resp.Body); err != nil {
		return "", err
	}
	return strings.TrimRight(s.cfg.Storage.PublicPrefix, "/") + "/" + name, nil
}

func extractRemoteImageURLs(resultJSON string) []string {
	var root any
	if err := json.Unmarshal([]byte(resultJSON), &root); err != nil {
		return nil
	}
	seen := map[string]bool{}
	var urls []string
	var walk func(any)
	walk = func(value any) {
		switch typed := value.(type) {
		case string:
			if imageURLPattern.MatchString(typed) && !seen[typed] {
				seen[typed] = true
				urls = append(urls, typed)
			}
		case []any:
			for _, item := range typed {
				walk(item)
			}
		case map[string]any:
			for _, item := range typed {
				walk(item)
			}
		}
	}
	walk(root)
	return urls
}

func extensionFromURL(rawURL, contentType string) string {
	ext := strings.ToLower(path.Ext(strings.Split(rawURL, "?")[0]))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".webp":
		return ext
	}
	switch strings.ToLower(strings.Split(contentType, ";")[0]) {
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	default:
		return ".jpg"
	}
}

func sanitizeFilePart(input string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(input) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "task"
	}
	return b.String()
}

func (s *Server) BackfillLocalImages(ctx context.Context) {
	if err := os.MkdirAll(s.cfg.Storage.GeneratedDir, 0755); err != nil {
		return
	}
	assets, err := s.store.ListPendingDownloads(ctx, 50)
	if err != nil || len(assets) == 0 {
		return
	}
	client := http.Client{Timeout: 90 * time.Second}
	for _, asset := range assets {
		localURL, err := s.downloadImage(ctx, client, fmt.Sprintf("backfill-%d", asset.ID), 0, asset.URL)
		if err != nil || localURL == "" {
			continue
		}
		_ = s.store.SetAssetLocalURLByID(ctx, asset.ID, localURL)
	}
}
