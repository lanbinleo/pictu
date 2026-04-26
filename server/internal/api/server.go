package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/mail"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"

	"pictu/server/internal/auth"
	"pictu/server/internal/config"
	"pictu/server/internal/evolink"
	"pictu/server/internal/store"
)

type Server struct {
	cfg     config.Config
	store   *store.Store
	evolink *evolink.Client
	planner *Planner
	router  *gin.Engine
}

func New(cfg config.Config, st *store.Store, ev *evolink.Client) *Server {
	s := &Server{cfg: cfg, store: st, evolink: ev, planner: NewPlanner(cfg.LLM)}
	s.router = s.routes()
	return s
}

func (s *Server) Run() error {
	addr := fmt.Sprintf("%s:%d", s.cfg.Server.Host, s.cfg.Server.Port)
	return s.router.Run(addr)
}

func (s *Server) routes() *gin.Engine {
	r := gin.Default()
	r.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"http://localhost:5173", "http://127.0.0.1:5173"},
		AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Authorization"},
		AllowCredentials: true,
		MaxAge:           12 * time.Hour,
	}))

	api := r.Group("/api")
	api.GET("/healthz", s.healthz)
	api.POST("/auth/register", s.register)
	api.POST("/auth/login", s.login)

	protected := api.Group("")
	protected.Use(s.authMiddleware())
	protected.GET("/me", s.me)
	protected.PUT("/me", s.updateMe)
	protected.PUT("/me/password", s.updatePassword)
	protected.POST("/me/avatar", s.uploadAvatar)
	protected.GET("/sessions", s.listSessions)
	protected.GET("/sessions/manage", s.listAllSessions)
	protected.POST("/sessions", s.createSession)
	protected.GET("/sessions/:id", s.getSession)
	protected.PUT("/sessions/:id", s.updateSession)
	protected.POST("/sessions/:id/archive", s.archiveSession)
	protected.POST("/sessions/:id/unarchive", s.unarchiveSession)
	protected.DELETE("/sessions/:id", s.deleteSession)
	protected.GET("/assets", s.listAssets)
	protected.POST("/sessions/:id/assets", s.uploadAsset)
	protected.POST("/sessions/:id/assets/:asset_id/use", s.useAsset)
	protected.DELETE("/assets/:asset_id", s.deleteAsset)
	protected.POST("/sessions/:id/generate", s.generate)
	protected.POST("/sessions/:id/generate/stream", s.generateStream)
	protected.GET("/tasks/:id", s.getTask)
	protected.GET("/usage", s.usage)

	admin := protected.Group("/admin")
	admin.Use(requireAdmin())
	admin.GET("/users", s.adminUsers)
	admin.POST("/users/:id/credits", s.adminAdjustCredits)

	s.serveFrontend(r)
	return r
}

func (s *Server) healthz(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) register(c *gin.Context) {
	var req struct {
		Email       string `json:"email" binding:"required"`
		Password    string `json:"password" binding:"required"`
		DisplayName string `json:"display_name"`
	}
	if !bind(c, &req) {
		return
	}
	if len(req.Password) < 8 {
		fail(c, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	user, err := s.store.CreateUserWithTenant(c, req.Email, hash, req.DisplayName, s.cfg.Billing.SignupCredits)
	if err != nil {
		fail(c, http.StatusBadRequest, err.Error())
		return
	}
	token, err := auth.Sign(s.cfg.Server.JWTSecret, user.ID, user.TenantID, user.Email, user.Role)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"token": token, "user": user})
}

func (s *Server) login(c *gin.Context) {
	var req struct {
		Email    string `json:"email" binding:"required"`
		Password string `json:"password" binding:"required"`
	}
	if !bind(c, &req) {
		return
	}
	user, err := s.store.GetUserByEmail(c, req.Email)
	if err != nil || !auth.CheckPassword(user.Password, req.Password) {
		fail(c, http.StatusUnauthorized, "invalid email or password")
		return
	}
	token, err := auth.Sign(s.cfg.Server.JWTSecret, user.ID, user.TenantID, user.Email, user.Role)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"token": token, "user": user})
}

func (s *Server) me(c *gin.Context) {
	user := currentUser(c)
	fresh, err := s.store.GetUserByID(c, user.ID)
	if err != nil {
		fail(c, http.StatusUnauthorized, "user not found")
		return
	}
	c.JSON(http.StatusOK, gin.H{"user": fresh})
}

func (s *Server) updateMe(c *gin.Context) {
	var req struct {
		Email       string `json:"email" binding:"required"`
		DisplayName string `json:"display_name"`
	}
	if !bind(c, &req) {
		return
	}
	if _, err := mail.ParseAddress(req.Email); err != nil {
		fail(c, http.StatusBadRequest, "invalid email")
		return
	}
	user, err := s.store.UpdateUserProfile(c, currentUser(c), req.Email, req.DisplayName)
	if err != nil {
		fail(c, http.StatusBadRequest, err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"user": user})
}

func (s *Server) updatePassword(c *gin.Context) {
	var req struct {
		CurrentPassword string `json:"current_password" binding:"required"`
		NewPassword     string `json:"new_password" binding:"required"`
	}
	if !bind(c, &req) {
		return
	}
	if len(req.NewPassword) < 8 {
		fail(c, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}
	user := currentUser(c)
	fresh, err := s.store.GetUserByID(c, user.ID)
	if err != nil {
		statusFromErr(c, err)
		return
	}
	if !auth.CheckPassword(fresh.Password, req.CurrentPassword) {
		fail(c, http.StatusUnauthorized, "current password is incorrect")
		return
	}
	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.store.UpdateUserPassword(c, fresh, hash); err != nil {
		statusFromErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) uploadAvatar(c *gin.Context) {
	file, err := c.FormFile("file")
	if err != nil {
		fail(c, http.StatusBadRequest, "file is required")
		return
	}
	if file.Size > 5*1024*1024 {
		fail(c, http.StatusBadRequest, "file must be under 5MB")
		return
	}
	if !validImage(file) {
		fail(c, http.StatusBadRequest, "supported formats: jpeg, png, webp")
		return
	}
	src, err := file.Open()
	if err != nil {
		fail(c, http.StatusBadRequest, err.Error())
		return
	}
	defer src.Close()
	data, err := io.ReadAll(src)
	if err != nil {
		fail(c, http.StatusBadRequest, err.Error())
		return
	}
	url, err := s.backupAvatarImage(data, currentUser(c), file.Filename, file.Header.Get("Content-Type"))
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	user, err := s.store.UpdateUserAvatar(c, currentUser(c), url)
	if err != nil {
		statusFromErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"user": user})
}

func (s *Server) listSessions(c *gin.Context) {
	items, err := s.store.ListSessions(c, currentUser(c))
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"sessions": items})
}

func (s *Server) listAllSessions(c *gin.Context) {
	items, err := s.store.ListAllSessions(c, currentUser(c))
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"sessions": items})
}

func (s *Server) createSession(c *gin.Context) {
	var req struct {
		Title string `json:"title"`
	}
	_ = c.ShouldBindJSON(&req)
	session, err := s.store.CreateSession(c, currentUser(c), req.Title)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"session": session})
}

func (s *Server) archiveSession(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	if err := s.store.ArchiveSession(c, currentUser(c), id); err != nil {
		statusFromErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) unarchiveSession(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	session, err := s.store.UnarchiveSession(c, currentUser(c), id)
	if err != nil {
		statusFromErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"session": session})
}

func (s *Server) deleteSession(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	if err := s.store.DeleteSession(c, currentUser(c), id); err != nil {
		statusFromErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) updateSession(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	var req struct {
		Title string `json:"title" binding:"required"`
	}
	if !bind(c, &req) {
		return
	}
	session, err := s.store.UpdateSessionTitle(c, currentUser(c), id, req.Title)
	if err != nil {
		statusFromErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"session": session})
}

func (s *Server) getSession(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	detail, err := s.store.GetSessionDetail(c, currentUser(c), id)
	if err != nil {
		statusFromErr(c, err)
		return
	}
	c.JSON(http.StatusOK, detail)
}

func (s *Server) listAssets(c *gin.Context) {
	assets, err := s.store.ListUserAssets(c, currentUser(c), 200)
	if err != nil {
		statusFromErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"assets": assets})
}

func (s *Server) uploadAsset(c *gin.Context) {
	sessionID, ok := pathID(c)
	if !ok {
		return
	}
	file, err := c.FormFile("file")
	if err != nil {
		fail(c, http.StatusBadRequest, "file is required")
		return
	}
	if file.Size > 50*1024*1024 {
		fail(c, http.StatusBadRequest, "file must be under 50MB")
		return
	}
	if !validImage(file) {
		fail(c, http.StatusBadRequest, "supported formats: jpeg, png, webp")
		return
	}
	src, err := file.Open()
	if err != nil {
		fail(c, http.StatusBadRequest, err.Error())
		return
	}
	defer src.Close()
	data, err := io.ReadAll(src)
	if err != nil {
		fail(c, http.StatusBadRequest, err.Error())
		return
	}
	provider := s.normalizedUploadProvider(c.PostForm("provider"))
	contentHash := sha256Hex(data)
	user := currentUser(c)
	localURL, err := s.backupReferenceImage(data, user, sessionID, file.Filename, file.Header.Get("Content-Type"), contentHash)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	if existing, err := s.store.FindAssetByHash(c, user, sessionID, provider, contentHash); err == nil {
		if existing.LocalURL == "" && localURL != "" {
			if err := s.store.SetAssetLocalURL(c, user, existing.ID, localURL); err == nil {
				existing.LocalURL = localURL
			}
		}
		c.JSON(http.StatusOK, gin.H{"asset": existing, "deduped": true})
		return
	}
	uploaded, err := s.uploadReferenceImage(c, provider, file.Filename, file.Header.Get("Content-Type"), file.Size, bytes.NewReader(data))
	if err != nil {
		fail(c, http.StatusBadGateway, err.Error())
		return
	}
	asset, err := s.store.SaveAsset(c, user, sessionID, uploaded.FileName, uploaded.MIMEType, uploaded.URL, localURL, uploaded.SizeBytes, provider, contentHash)
	if err != nil {
		statusFromErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"asset": asset})
}

func (s *Server) useAsset(c *gin.Context) {
	sessionID, ok := pathID(c)
	if !ok {
		return
	}
	assetID, err := strconv.ParseInt(c.Param("asset_id"), 10, 64)
	if err != nil {
		fail(c, http.StatusBadRequest, "invalid asset id")
		return
	}
	user := currentUser(c)
	source, err := s.store.GetAsset(c, user, assetID)
	if err != nil {
		statusFromErr(c, err)
		return
	}
	if source.SessionID == sessionID {
		c.JSON(http.StatusOK, gin.H{"asset": source})
		return
	}
	if existing, err := s.store.FindAssetByHash(c, user, sessionID, source.Provider, source.ContentHash); err == nil {
		c.JSON(http.StatusOK, gin.H{"asset": existing, "deduped": true})
		return
	}
	asset, err := s.store.SaveAsset(c, user, sessionID, source.FileName, source.MIMEType, source.URL, source.LocalURL, source.SizeBytes, source.Provider, source.ContentHash)
	if err != nil {
		statusFromErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"asset": asset})
}

func (s *Server) deleteAsset(c *gin.Context) {
	assetID, err := strconv.ParseInt(c.Param("asset_id"), 10, 64)
	if err != nil {
		fail(c, http.StatusBadRequest, "invalid asset id")
		return
	}
	if err := s.store.DeleteAsset(c, currentUser(c), assetID); err != nil {
		statusFromErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) generate(c *gin.Context) {
	sessionID, ok := pathID(c)
	if !ok {
		return
	}
	var req struct {
		Message          string  `json:"message" binding:"required"`
		AssetIDs         []int64 `json:"asset_ids"`
		Size             string  `json:"size"`
		Resolution       string  `json:"resolution"`
		Quality          string  `json:"quality"`
		Count            int     `json:"count"`
		Confirmed        bool    `json:"confirmed"`
		Prompt           string  `json:"prompt"`
		AssistantMessage string  `json:"assistant_message"`
		UsePlanner       *bool   `json:"use_planner"`
	}
	if !bind(c, &req) {
		return
	}
	user := currentUser(c)
	assets, err := s.assetsByID(c, user, req.AssetIDs)
	if err != nil {
		statusFromErr(c, err)
		return
	}
	var imageURLs []string
	var imageNames []string
	for i, asset := range assets {
		imageURLs = append(imageURLs, asset.URL)
		imageNames = append(imageNames, fmt.Sprintf("image %d (%s)", i+1, asset.FileName))
	}
	userMessageContent := messageWithReferences(req.Message, assets)
	contextMessages, err := s.store.ListMessages(c, user, sessionID)
	if err != nil {
		statusFromErr(c, err)
		return
	}
	input := PlanInput{
		UserText:        req.Message,
		ImageNames:      imageNames,
		Size:            req.Size,
		Resolution:      req.Resolution,
		Quality:         req.Quality,
		Count:           req.Count,
		ContextMessages: contextMessages,
	}
	var plan GenerationPlan
	usePlanner := req.UsePlanner == nil || *req.UsePlanner
	if !usePlanner {
		plan = DirectPlan(input)
	} else if req.Confirmed && req.Prompt != "" {
		plan = sanitizePlan(GenerationPlan{
			Prompt:           req.Prompt,
			Size:             req.Size,
			Resolution:       req.Resolution,
			Quality:          req.Quality,
			Count:            req.Count,
			AssistantMessage: req.AssistantMessage,
			ToolCalled:       true,
		}, input)
	} else {
		plan, err = s.planner.Plan(c, input)
		if err != nil {
			plan = BuildPlan(input)
		}
	}
	if !plan.ToolCalled {
		if err := s.store.ReserveCredits(c, user, 1, "llm_reply", ""); err != nil {
			if errors.Is(err, store.ErrInsufficientCredits) {
				fail(c, http.StatusPaymentRequired, "not enough credits")
				return
			}
			fail(c, http.StatusInternalServerError, err.Error())
			return
		}
		_, _ = s.store.AddMessage(c, user, sessionID, "user", userMessageContent, "", "")
		msg, _ := s.store.AddMessage(c, user, sessionID, "assistant", plan.AssistantMessage, "", "")
		s.maybeTitleSession(c, user, sessionID, contextMessages, req.Message, plan.AssistantMessage)
		c.JSON(http.StatusOK, gin.H{"plan": plan, "message": msg, "generated": false})
		return
	}
	if !req.Confirmed {
		changes := settingChanges(input, plan)
		if len(changes) > 0 {
			c.JSON(http.StatusOK, gin.H{"requires_confirmation": true, "plan": plan, "setting_changes": changes})
			return
		}
	}
	cost := EstimateCost(s.cfg.Billing.ImageBaseCost, s.cfg.Billing.ImageInputCost, s.cfg.Billing.LowQualityMultiplier, s.cfg.Billing.HighQualityMultiplier, plan.Quality, len(imageURLs), plan.Count)
	if err := s.store.ReserveCredits(c, user, cost, "image_generation", ""); err != nil {
		if errors.Is(err, store.ErrInsufficientCredits) {
			fail(c, http.StatusPaymentRequired, "not enough credits")
			return
		}
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	_, _ = s.store.AddMessage(c, user, sessionID, "user", userMessageContent, "", "")

	evReq := evolink.ImageRequest{
		Prompt:     plan.Prompt,
		ImageURLs:  imageURLs,
		Size:       plan.Size,
		Resolution: plan.Resolution,
		Quality:    plan.Quality,
		N:          plan.Count,
	}
	task, err := s.evolink.CreateImage(c, evReq)
	if err != nil {
		_ = s.store.AddCredits(context.Background(), user, cost, "generation_refund", "")
		fail(c, http.StatusBadGateway, err.Error())
		return
	}
	reqJSON, _ := json.Marshal(evReq)
	localTask, err := s.store.CreateTask(c, user, sessionID, task.ID, task.Status, task.Progress, cost, plan.Prompt, string(reqJSON))
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	msg, _ := s.store.AddMessage(c, user, sessionID, "assistant", plan.AssistantMessage, plan.Prompt, task.ID)
	s.maybeTitleSession(c, user, sessionID, contextMessages, req.Message, plan.AssistantMessage)
	go s.pollTask(task.ID)
	c.JSON(http.StatusOK, gin.H{"plan": plan, "task": localTask, "message": msg, "generated": true})
}

func (s *Server) generateStream(c *gin.Context) {
	sessionID, ok := pathID(c)
	if !ok {
		return
	}
	var req struct {
		Message    string  `json:"message" binding:"required"`
		AssetIDs   []int64 `json:"asset_ids"`
		Size       string  `json:"size"`
		Resolution string  `json:"resolution"`
		Quality    string  `json:"quality"`
		Count      int     `json:"count"`
		UsePlanner *bool   `json:"use_planner"`
	}
	if !bind(c, &req) {
		return
	}
	user := currentUser(c)
	assets, err := s.assetsByID(c, user, req.AssetIDs)
	if err != nil {
		statusFromErr(c, err)
		return
	}
	var imageURLs []string
	var imageNames []string
	for i, asset := range assets {
		imageURLs = append(imageURLs, asset.URL)
		imageNames = append(imageNames, fmt.Sprintf("image %d (%s)", i+1, asset.FileName))
	}
	userMessageContent := messageWithReferences(req.Message, assets)
	contextMessages, err := s.store.ListMessages(c, user, sessionID)
	if err != nil {
		statusFromErr(c, err)
		return
	}
	input := PlanInput{
		UserText:        req.Message,
		ImageNames:      imageNames,
		Size:            req.Size,
		Resolution:      req.Resolution,
		Quality:         req.Quality,
		Count:           req.Count,
		ContextMessages: contextMessages,
	}

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	flush := func(event string, payload any) error {
		data, _ := json.Marshal(payload)
		if _, err := fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", event, data); err != nil {
			return err
		}
		c.Writer.Flush()
		return nil
	}

	var streamedToolArgs string
	usePlanner := req.UsePlanner == nil || *req.UsePlanner
	var plan GenerationPlan
	if usePlanner {
		plan, err = s.planner.PlanStream(c.Request.Context(), input, func(ev PlanStreamEvent) error {
			if ev.Type == "tool" {
				streamedToolArgs += ev.Text
				phase := "preparing"
				if ev.Text == "" {
					return flush("tool", gin.H{"phase": phase})
				}
				prompt := promptFromToolArguments(streamedToolArgs)
				return flush("tool", gin.H{"phase": phase, "text": ev.Text, "prompt": prompt})
			}
			return flush(ev.Type, gin.H{"text": ev.Text})
		})
		if err != nil {
			_ = flush("error", gin.H{"error": err.Error()})
			return
		}
	} else {
		plan = DirectPlan(input)
		if plan.AssistantMessage != "" {
			_ = flush("content", gin.H{"text": plan.AssistantMessage})
		}
	}
	if !plan.ToolCalled {
		if err := s.store.ReserveCredits(c, user, 1, "llm_reply", ""); err != nil {
			_ = flush("error", gin.H{"error": err.Error()})
			return
		}
		_, _ = s.store.AddMessage(c, user, sessionID, "user", userMessageContent, "", "")
		msg, _ := s.store.AddMessage(c, user, sessionID, "assistant", plan.AssistantMessage, "", "")
		s.maybeTitleSession(c, user, sessionID, contextMessages, req.Message, plan.AssistantMessage)
		_ = flush("done", gin.H{"plan": plan, "message": msg, "generated": false})
		return
	}
	changes := settingChanges(input, plan)
	if len(changes) > 0 {
		_ = flush("confirm", gin.H{"requires_confirmation": true, "plan": plan, "setting_changes": changes})
		return
	}
	cost := EstimateCost(s.cfg.Billing.ImageBaseCost, s.cfg.Billing.ImageInputCost, s.cfg.Billing.LowQualityMultiplier, s.cfg.Billing.HighQualityMultiplier, plan.Quality, len(imageURLs), plan.Count)
	if err := s.store.ReserveCredits(c, user, cost, "image_generation", ""); err != nil {
		_ = flush("error", gin.H{"error": err.Error()})
		return
	}
	_, _ = s.store.AddMessage(c, user, sessionID, "user", userMessageContent, "", "")
	evReq := evolink.ImageRequest{
		Prompt:     plan.Prompt,
		ImageURLs:  imageURLs,
		Size:       plan.Size,
		Resolution: plan.Resolution,
		Quality:    plan.Quality,
		N:          plan.Count,
	}
	_ = flush("tool", gin.H{"phase": "calling", "prompt": plan.Prompt})
	task, err := s.evolink.CreateImage(c, evReq)
	if err != nil {
		_ = s.store.AddCredits(context.Background(), user, cost, "generation_refund", "")
		_ = flush("error", gin.H{"error": err.Error()})
		return
	}
	reqJSON, _ := json.Marshal(evReq)
	localTask, err := s.store.CreateTask(c, user, sessionID, task.ID, task.Status, task.Progress, cost, plan.Prompt, string(reqJSON))
	if err != nil {
		_ = flush("error", gin.H{"error": err.Error()})
		return
	}
	msg, _ := s.store.AddMessage(c, user, sessionID, "assistant", plan.AssistantMessage, plan.Prompt, task.ID)
	s.maybeTitleSession(c, user, sessionID, contextMessages, req.Message, plan.AssistantMessage)
	go s.pollTask(task.ID)
	_ = flush("done", gin.H{"plan": plan, "task": localTask, "message": msg, "generated": true})
}

func (s *Server) getTask(c *gin.Context) {
	user := currentUser(c)
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		fail(c, http.StatusBadRequest, "invalid task id")
		return
	}
	task, err := s.store.GetTaskByLocalID(c, user, id)
	if err != nil {
		statusFromErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"task": task})
}

func (s *Server) usage(c *gin.Context) {
	user := currentUser(c)
	fresh, err := s.store.GetUserByID(c, user.ID)
	if err != nil {
		fail(c, http.StatusUnauthorized, "user not found")
		return
	}
	summary, err := s.store.UsageSummary(c, fresh)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	ledger, err := s.store.ListLedger(c, fresh, 80)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	assets, err := s.store.ListUserAssets(c, fresh, 100)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"summary": summary, "ledger": ledger, "assets": assets})
}

func (s *Server) adminUsers(c *gin.Context) {
	users, err := s.store.AdminListUsers(c)
	if err != nil {
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"users": users})
}

func (s *Server) adminAdjustCredits(c *gin.Context) {
	userID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		fail(c, http.StatusBadRequest, "invalid user id")
		return
	}
	var req struct {
		Delta  int    `json:"delta" binding:"required"`
		Reason string `json:"reason"`
	}
	if !bind(c, &req) {
		return
	}
	user, err := s.store.AdminAdjustCredits(c, currentUser(c), userID, req.Delta, req.Reason)
	if err != nil {
		if errors.Is(err, store.ErrInsufficientCredits) {
			fail(c, http.StatusBadRequest, "credit balance cannot be negative")
			return
		}
		statusFromErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"user": user})
}

func (s *Server) pollTask(providerTaskID string) {
	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.Evolink.PollTimeout())
	defer cancel()
	ticker := time.NewTicker(s.cfg.Evolink.PollInterval())
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			_ = s.store.UpdateTask(context.Background(), providerTaskID, "failed", 0, "", "task polling timed out")
			_ = s.store.RefundTaskCredits(context.Background(), providerTaskID)
			return
		case <-ticker.C:
			task, err := s.evolink.GetTask(ctx, providerTaskID)
			if err != nil {
				continue
			}
			resultJSON, _ := json.Marshal(task)
			taskErr := ""
			if task.Error != nil {
				taskErr = task.Error.Message
			}
			if task.Status == "completed" {
				resultJSON = []byte(s.archiveTaskImages(ctx, providerTaskID, string(resultJSON)))
			}
			_ = s.store.UpdateTask(context.Background(), providerTaskID, task.Status, task.Progress, string(resultJSON), taskErr)
			if task.Status == "completed" || task.Status == "failed" {
				if task.Status == "failed" {
					_ = s.store.RefundTaskCredits(context.Background(), providerTaskID)
				}
				return
			}
		}
	}
}

func (s *Server) assetsByID(ctx context.Context, user store.User, ids []int64) ([]store.Asset, error) {
	if len(ids) > 16 {
		return nil, fmt.Errorf("at most 16 reference images are supported")
	}
	var assets []store.Asset
	for _, id := range ids {
		asset, err := s.store.GetAsset(ctx, user, id)
		if err != nil {
			return nil, err
		}
		assets = append(assets, asset)
	}
	return assets, nil
}

func (s *Server) maybeTitleSession(ctx context.Context, user store.User, sessionID int64, previous []store.Message, userText, assistantText string) {
	if len(previous) > 0 {
		return
	}
	title, err := s.planner.Title(ctx, userText, assistantText, time.Now())
	if err != nil || strings.TrimSpace(title) == "" {
		return
	}
	_, _ = s.store.UpdateSessionTitle(ctx, user, sessionID, title)
}

func settingChanges(input PlanInput, plan GenerationPlan) []gin.H {
	var changes []gin.H
	add := func(field string, current any, recommended any) {
		if fmt.Sprint(current) == fmt.Sprint(recommended) {
			return
		}
		changes = append(changes, gin.H{
			"field":       field,
			"current":     current,
			"recommended": recommended,
		})
	}
	add("size", input.Size, plan.Size)
	add("resolution", input.Resolution, plan.Resolution)
	add("quality", input.Quality, plan.Quality)
	add("count", input.Count, plan.Count)
	return changes
}

func promptFromToolArguments(raw string) string {
	var args struct {
		Prompt string `json:"prompt"`
	}
	if err := json.Unmarshal([]byte(raw), &args); err == nil {
		return strings.TrimSpace(args.Prompt)
	}
	key := `"prompt"`
	start := strings.Index(raw, key)
	if start < 0 {
		return ""
	}
	afterKey := raw[start+len(key):]
	colon := strings.Index(afterKey, ":")
	if colon < 0 {
		return ""
	}
	value := strings.TrimLeft(afterKey[colon+1:], " \t\r\n")
	if !strings.HasPrefix(value, `"`) {
		return ""
	}
	value = value[1:]
	var b strings.Builder
	escaped := false
	for _, r := range value {
		if escaped {
			switch r {
			case 'n':
				b.WriteRune('\n')
			case 't':
				b.WriteRune('\t')
			default:
				b.WriteRune(r)
			}
			escaped = false
			continue
		}
		if r == '\\' {
			escaped = true
			continue
		}
		if r == '"' {
			break
		}
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}

func (s *Server) normalizedUploadProvider(provider string) string {
	provider = strings.TrimSpace(provider)
	if provider == "" {
		provider = s.cfg.Upload.DefaultProvider
	}
	return provider
}

func (s *Server) backupReferenceImage(data []byte, user store.User, sessionID int64, fileName, mimeType, contentHash string) (string, error) {
	if len(data) == 0 || s.cfg.Storage.GeneratedDir == "" {
		return "", nil
	}
	ext := referenceImageExt(fileName, mimeType)
	hashPart := contentHash
	if len(hashPart) > 20 {
		hashPart = hashPart[:20]
	}
	relDir := filepath.Join("reference-backups", fmt.Sprintf("tenant-%d", user.TenantID), fmt.Sprintf("session-%d", sessionID))
	targetDir := filepath.Join(s.cfg.Storage.GeneratedDir, relDir)
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return "", err
	}
	name := hashPart + ext
	target := filepath.Join(targetDir, name)
	if _, err := os.Stat(target); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(target, data, 0644); err != nil {
			return "", err
		}
	} else if err != nil {
		return "", err
	}
	urlPath := path.Join(filepath.ToSlash(relDir), name)
	return strings.TrimRight(s.cfg.Storage.PublicPrefix, "/") + "/" + urlPath, nil
}

func (s *Server) backupAvatarImage(data []byte, user store.User, fileName, mimeType string) (string, error) {
	if len(data) == 0 || s.cfg.Storage.GeneratedDir == "" {
		return "", nil
	}
	ext := referenceImageExt(fileName, mimeType)
	hashPart := sha256Hex(data)
	if len(hashPart) > 20 {
		hashPart = hashPart[:20]
	}
	relDir := filepath.Join("avatars", fmt.Sprintf("tenant-%d", user.TenantID))
	targetDir := filepath.Join(s.cfg.Storage.GeneratedDir, relDir)
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return "", err
	}
	name := fmt.Sprintf("user-%d-%s%s", user.ID, hashPart, ext)
	target := filepath.Join(targetDir, name)
	if _, err := os.Stat(target); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(target, data, 0644); err != nil {
			return "", err
		}
	} else if err != nil {
		return "", err
	}
	urlPath := path.Join(filepath.ToSlash(relDir), name)
	return strings.TrimRight(s.cfg.Storage.PublicPrefix, "/") + "/" + urlPath, nil
}

func referenceImageExt(fileName, mimeType string) string {
	switch strings.ToLower(strings.Split(mimeType, ";")[0]) {
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/jpeg", "image/jpg":
		return ".jpg"
	}
	switch strings.ToLower(filepath.Ext(fileName)) {
	case ".png", ".webp", ".jpg", ".jpeg":
		return strings.ToLower(filepath.Ext(fileName))
	default:
		return ".jpg"
	}
}

func messageWithReferences(text string, assets []store.Asset) string {
	if len(assets) == 0 {
		return text
	}
	var refs []string
	for i, asset := range assets {
		url := asset.LocalURL
		if strings.TrimSpace(url) == "" {
			url = asset.URL
		}
		if strings.TrimSpace(url) == "" {
			continue
		}
		refs = append(refs, fmt.Sprintf("![图%d](%s)", i+1, url))
	}
	if len(refs) == 0 {
		return text
	}
	return strings.TrimSpace(text) + "\n\n" + strings.Join(refs, " ")
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (s *Server) authMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		if !strings.HasPrefix(header, "Bearer ") {
			fail(c, http.StatusUnauthorized, "missing bearer token")
			c.Abort()
			return
		}
		claims, err := auth.Parse(s.cfg.Server.JWTSecret, strings.TrimPrefix(header, "Bearer "))
		if err != nil {
			fail(c, http.StatusUnauthorized, "invalid token")
			c.Abort()
			return
		}
		user, err := s.store.GetUserByID(c, claims.UserID)
		if err != nil {
			fail(c, http.StatusUnauthorized, "user not found")
			c.Abort()
			return
		}
		c.Set("user", user)
		c.Next()
	}
}

func requireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		if currentUser(c).Role != "admin" {
			fail(c, http.StatusForbidden, "admin access required")
			c.Abort()
			return
		}
		c.Next()
	}
}

func (s *Server) serveFrontend(r *gin.Engine) {
	if s.cfg.Storage.GeneratedDir != "" {
		r.Static(strings.TrimRight(s.cfg.Storage.PublicPrefix, "/"), s.cfg.Storage.GeneratedDir)
	}
	dist := s.cfg.Server.FrontendDist
	if info, err := os.Stat(dist); err == nil && info.IsDir() {
		r.Static("/assets", filepath.Join(dist, "assets"))
		r.NoRoute(func(c *gin.Context) {
			if strings.HasPrefix(c.Request.URL.Path, "/api/") {
				c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
				return
			}
			c.File(filepath.Join(dist, "index.html"))
		})
	}
}

func currentUser(c *gin.Context) store.User {
	user, _ := c.Get("user")
	return user.(store.User)
}

func bind(c *gin.Context, out any) bool {
	if err := c.ShouldBindJSON(out); err != nil {
		fail(c, http.StatusBadRequest, err.Error())
		return false
	}
	return true
}

func pathID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		fail(c, http.StatusBadRequest, "invalid id")
		return 0, false
	}
	return id, true
}

func fail(c *gin.Context, status int, msg string) {
	c.JSON(status, gin.H{"error": msg})
}

func statusFromErr(c *gin.Context, err error) {
	if errors.Is(err, store.ErrNotFound) {
		fail(c, http.StatusNotFound, "not found")
		return
	}
	fail(c, http.StatusInternalServerError, err.Error())
}

func validImage(file *multipart.FileHeader) bool {
	contentType := file.Header.Get("Content-Type")
	switch contentType {
	case "image/jpeg", "image/png", "image/webp":
		return true
	}
	ext := strings.ToLower(filepath.Ext(file.Filename))
	return ext == ".jpg" || ext == ".jpeg" || ext == ".png" || ext == ".webp"
}
