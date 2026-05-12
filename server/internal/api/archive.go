package api

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
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

type archivedImage struct {
	FileName    string
	MIMEType    string
	URL         string
	LocalURL    string
	SizeBytes   int64
	ContentHash string
}

func (s *Server) archiveTaskImages(ctx context.Context, providerTaskID string, resultJSON string) ([]archivedImage, string) {
	urls := extractRemoteImageURLs(resultJSON)
	if len(urls) == 0 {
		return nil, resultJSON
	}
	if err := os.MkdirAll(s.cfg.Storage.GeneratedDir, 0755); err != nil {
		return nil, resultJSON
	}
	client := http.Client{Timeout: 90 * time.Second}
	var archived []archivedImage
	for i, remoteURL := range urls {
		item, err := s.downloadImage(ctx, client, providerTaskID, i, remoteURL)
		if err == nil && item.LocalURL != "" {
			archived = append(archived, item)
		}
	}
	if len(archived) == 0 {
		return nil, resultJSON
	}
	var root any
	if err := json.Unmarshal([]byte(resultJSON), &root); err != nil {
		return archived, resultJSON
	}
	if obj, ok := root.(map[string]any); ok {
		values := make([]any, 0, len(archived))
		for _, item := range archived {
			values = append(values, item.LocalURL)
		}
		obj["pictu_local_urls"] = values
		if data, err := json.Marshal(obj); err == nil {
			return archived, string(data)
		}
	}
	return archived, resultJSON
}

func (s *Server) downloadImage(ctx context.Context, client http.Client, taskID string, index int, remoteURL string) (archivedImage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, remoteURL, nil)
	if err != nil {
		return archivedImage{}, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return archivedImage{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return archivedImage{}, fmt.Errorf("download image status %d", resp.StatusCode)
	}
	ext := extensionFromURL(remoteURL, resp.Header.Get("Content-Type"))
	hash := sha1.Sum([]byte(remoteURL))
	name := fmt.Sprintf("%s-%02d-%s%s", sanitizeFilePart(taskID), index+1, hex.EncodeToString(hash[:])[:10], ext)
	target := filepath.Join(s.cfg.Storage.GeneratedDir, name)
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return archivedImage{}, err
	}
	if err := os.WriteFile(target, data, 0644); err != nil {
		return archivedImage{}, err
	}
	contentHash := sha256.Sum256(data)
	localURL := strings.TrimRight(s.cfg.Storage.PublicPrefix, "/") + "/" + name
	return archivedImage{
		FileName:    name,
		MIMEType:    mimeTypeForExtension(ext),
		URL:         remoteURL,
		LocalURL:    localURL,
		SizeBytes:   int64(len(data)),
		ContentHash: hex.EncodeToString(contentHash[:]),
	}, nil
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

func mimeTypeForExtension(ext string) string {
	switch strings.ToLower(ext) {
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	default:
		return "image/jpeg"
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
		archived, err := s.downloadImage(ctx, client, fmt.Sprintf("backfill-%d", asset.ID), 0, asset.URL)
		if err != nil || archived.LocalURL == "" {
			continue
		}
		_ = s.store.SetAssetLocalURLByID(ctx, asset.ID, archived.LocalURL)
	}
}
