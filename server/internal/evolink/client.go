package evolink

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"pictu/server/internal/config"
)

type Client struct {
	cfg        config.EvolinkConfig
	httpClient *http.Client
}

type ImageRequest struct {
	Model      string   `json:"model"`
	Prompt     string   `json:"prompt"`
	ImageURLs  []string `json:"image_urls,omitempty"`
	Size       string   `json:"size,omitempty"`
	Resolution string   `json:"resolution,omitempty"`
	Quality    string   `json:"quality,omitempty"`
	N          int      `json:"n,omitempty"`
}

type TaskResponse struct {
	Created  int64      `json:"created"`
	ID       string     `json:"id"`
	Model    string     `json:"model"`
	Object   string     `json:"object"`
	Progress int        `json:"progress"`
	Results  []string   `json:"results,omitempty"`
	Status   string     `json:"status"`
	Type     string     `json:"type"`
	Usage    any        `json:"usage,omitempty"`
	Error    *TaskError `json:"error,omitempty"`
}

type TaskError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Type    string `json:"type"`
}

type UploadResponse struct {
	Success bool       `json:"success"`
	Code    int        `json:"code"`
	Msg     string     `json:"msg"`
	Data    UploadData `json:"data"`
}

type UploadData struct {
	FileID       string `json:"file_id"`
	FileName     string `json:"file_name"`
	OriginalName string `json:"original_name"`
	FileSize     int64  `json:"file_size"`
	MIMEType     string `json:"mime_type"`
	FileURL      string `json:"file_url"`
	DownloadURL  string `json:"download_url"`
	ExpiresAt    string `json:"expires_at"`
}

func New(cfg config.EvolinkConfig) *Client {
	return &Client{
		cfg: cfg,
		httpClient: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

func (c *Client) CreateImage(ctx context.Context, req ImageRequest) (TaskResponse, error) {
	if req.Model == "" {
		req.Model = c.cfg.Model
	}
	if req.N == 0 {
		req.N = 1
	}
	var out TaskResponse
	if err := c.doJSON(ctx, http.MethodPost, c.cfg.BaseURL+"/v1/images/generations", req, &out); err != nil {
		return TaskResponse{}, err
	}
	return out, nil
}

func (c *Client) GetTask(ctx context.Context, taskID string) (TaskResponse, error) {
	var out TaskResponse
	if err := c.doJSON(ctx, http.MethodGet, c.cfg.BaseURL+"/v1/tasks/"+taskID, nil, &out); err != nil {
		return TaskResponse{}, err
	}
	return out, nil
}

func (c *Client) UploadStream(ctx context.Context, fileName, mimeType string, src io.Reader) (UploadData, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filepath.Base(fileName))
	if err != nil {
		return UploadData{}, err
	}
	if _, err := io.Copy(part, src); err != nil {
		return UploadData{}, err
	}
	_ = writer.WriteField("upload_path", "pictu")
	if err := writer.Close(); err != nil {
		return UploadData{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.FilesBaseURL+"/api/v1/files/upload/stream", &body)
	if err != nil {
		return UploadData{}, err
	}
	req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	if mimeType != "" {
		req.Header.Set("X-Original-Content-Type", mimeType)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return UploadData{}, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return UploadData{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return UploadData{}, fmt.Errorf("evolink upload error %d: %s", resp.StatusCode, string(data))
	}
	var out UploadResponse
	if err := json.Unmarshal(data, &out); err != nil {
		return UploadData{}, err
	}
	if !out.Success {
		return UploadData{}, fmt.Errorf("evolink upload failed: %s", out.Msg)
	}
	return out.Data, nil
}

func (c *Client) doJSON(ctx context.Context, method, url string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("evolink api error %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}
