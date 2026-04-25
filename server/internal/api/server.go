package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"os"
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
	router  *gin.Engine
}

func New(cfg config.Config, st *store.Store, ev *evolink.Client) *Server {
	s := &Server{cfg: cfg, store: st, evolink: ev}
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
	api.POST("/auth/register", s.register)
	api.POST("/auth/login", s.login)

	protected := api.Group("")
	protected.Use(s.authMiddleware())
	protected.GET("/me", s.me)
	protected.GET("/sessions", s.listSessions)
	protected.POST("/sessions", s.createSession)
	protected.GET("/sessions/:id", s.getSession)
	protected.POST("/sessions/:id/assets", s.uploadAsset)
	protected.POST("/sessions/:id/generate", s.generate)
	protected.GET("/tasks/:id", s.getTask)

	s.serveFrontend(r)
	return r
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

func (s *Server) listSessions(c *gin.Context) {
	items, err := s.store.ListSessions(c, currentUser(c))
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
	uploaded, err := s.evolink.UploadStream(c, file.Filename, file.Header.Get("Content-Type"), src)
	if err != nil {
		fail(c, http.StatusBadGateway, err.Error())
		return
	}
	user := currentUser(c)
	asset, err := s.store.SaveAsset(c, user, sessionID, uploaded.OriginalName, uploaded.MIMEType, uploaded.FileURL, uploaded.FileSize)
	if err != nil {
		statusFromErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"asset": asset})
}

func (s *Server) generate(c *gin.Context) {
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
	plan := BuildPlan(PlanInput{
		UserText:   req.Message,
		ImageNames: imageNames,
		Size:       req.Size,
		Resolution: req.Resolution,
		Quality:    req.Quality,
		Count:      req.Count,
	})
	cost := EstimateCost(s.cfg.Billing.ImageBaseCost, s.cfg.Billing.ImageInputCost, s.cfg.Billing.LowQualityMultiplier, s.cfg.Billing.HighQualityMultiplier, plan.Quality, len(imageURLs), plan.Count)
	if err := s.store.ReserveCredits(c, user, cost, "image_generation", ""); err != nil {
		if errors.Is(err, store.ErrInsufficientCredits) {
			fail(c, http.StatusPaymentRequired, "not enough credits")
			return
		}
		fail(c, http.StatusInternalServerError, err.Error())
		return
	}
	_, _ = s.store.AddMessage(c, user, sessionID, "user", req.Message, "", "")

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
	assistantText := "I optimized your prompt and started the image task."
	msg, _ := s.store.AddMessage(c, user, sessionID, "assistant", assistantText, plan.Prompt, task.ID)
	go s.pollTask(task.ID)
	c.JSON(http.StatusOK, gin.H{"plan": plan, "task": localTask, "message": msg})
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

func (s *Server) pollTask(providerTaskID string) {
	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.Evolink.PollTimeout())
	defer cancel()
	ticker := time.NewTicker(s.cfg.Evolink.PollInterval())
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			_ = s.store.UpdateTask(context.Background(), providerTaskID, "failed", 0, "", "task polling timed out")
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
			_ = s.store.UpdateTask(context.Background(), providerTaskID, task.Status, task.Progress, string(resultJSON), taskErr)
			if task.Status == "completed" || task.Status == "failed" {
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

func (s *Server) serveFrontend(r *gin.Engine) {
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
