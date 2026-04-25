package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

type Tenant struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

type User struct {
	ID          int64     `json:"id"`
	TenantID    int64     `json:"tenant_id"`
	Email       string    `json:"email"`
	Password    string    `json:"-"`
	DisplayName string    `json:"display_name"`
	Role        string    `json:"role"`
	Credits     int       `json:"credits"`
	CreatedAt   time.Time `json:"created_at"`
}

type Session struct {
	ID        int64     `json:"id"`
	TenantID  int64     `json:"tenant_id"`
	UserID    int64     `json:"user_id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Asset struct {
	ID        int64     `json:"id"`
	SessionID int64     `json:"session_id"`
	UserID    int64     `json:"user_id"`
	FileName  string    `json:"file_name"`
	MIMEType  string    `json:"mime_type"`
	URL       string    `json:"url"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
}

type Message struct {
	ID        int64     `json:"id"`
	SessionID int64     `json:"session_id"`
	Role      string    `json:"role"`
	Content   string    `json:"content"`
	Prompt    string    `json:"prompt,omitempty"`
	TaskID    string    `json:"task_id,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type Task struct {
	ID             int64     `json:"id"`
	SessionID      int64     `json:"session_id"`
	ProviderTaskID string    `json:"provider_task_id"`
	Status         string    `json:"status"`
	Progress       int       `json:"progress"`
	Cost           int       `json:"cost"`
	Prompt         string    `json:"prompt"`
	ResultJSON     string    `json:"result_json,omitempty"`
	Error          string    `json:"error,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type CreditLedger struct {
	ID        int64     `json:"id"`
	TenantID  int64     `json:"tenant_id"`
	UserID    int64     `json:"user_id"`
	Delta     int       `json:"delta"`
	Balance   int       `json:"balance"`
	Reason    string    `json:"reason"`
	RefID     string    `json:"ref_id"`
	CreatedAt time.Time `json:"created_at"`
}

type UsageSummary struct {
	Credits         int `json:"credits"`
	GeneratedTasks  int `json:"generated_tasks"`
	CompletedTasks  int `json:"completed_tasks"`
	FailedTasks     int `json:"failed_tasks"`
	CreditsSpent    int `json:"credits_spent"`
	ReferenceImages int `json:"reference_images"`
}

type SessionDetail struct {
	Session  Session   `json:"session"`
	Assets   []Asset   `json:"assets"`
	Messages []Message `json:"messages"`
	Tasks    []Task    `json:"tasks"`
}

var ErrNotFound = errors.New("not found")
var ErrInsufficientCredits = errors.New("insufficient credits")

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) migrate(ctx context.Context) error {
	stmts := []string{
		`create table if not exists tenants (
			id integer primary key autoincrement,
			name text not null,
			slug text not null unique,
			created_at datetime not null default current_timestamp
		)`,
		`create table if not exists users (
			id integer primary key autoincrement,
			tenant_id integer not null references tenants(id) on delete cascade,
			email text not null unique,
			password_hash text not null,
			display_name text not null,
			role text not null,
			credits integer not null default 0,
			created_at datetime not null default current_timestamp
		)`,
		`create table if not exists sessions (
			id integer primary key autoincrement,
			tenant_id integer not null references tenants(id) on delete cascade,
			user_id integer not null references users(id) on delete cascade,
			title text not null,
			created_at datetime not null default current_timestamp,
			updated_at datetime not null default current_timestamp
		)`,
		`create table if not exists assets (
			id integer primary key autoincrement,
			tenant_id integer not null references tenants(id) on delete cascade,
			session_id integer not null references sessions(id) on delete cascade,
			user_id integer not null references users(id) on delete cascade,
			file_name text not null,
			mime_type text not null,
			url text not null,
			size_bytes integer not null,
			created_at datetime not null default current_timestamp
		)`,
		`create table if not exists messages (
			id integer primary key autoincrement,
			tenant_id integer not null references tenants(id) on delete cascade,
			session_id integer not null references sessions(id) on delete cascade,
			user_id integer not null references users(id) on delete cascade,
			role text not null,
			content text not null,
			prompt text not null default '',
			task_id text not null default '',
			created_at datetime not null default current_timestamp
		)`,
		`create table if not exists tasks (
			id integer primary key autoincrement,
			tenant_id integer not null references tenants(id) on delete cascade,
			session_id integer not null references sessions(id) on delete cascade,
			user_id integer not null references users(id) on delete cascade,
			provider_task_id text not null unique,
			status text not null,
			progress integer not null default 0,
			cost integer not null default 0,
			prompt text not null,
			request_json text not null default '',
			result_json text not null default '',
			error text not null default '',
			created_at datetime not null default current_timestamp,
			updated_at datetime not null default current_timestamp
		)`,
		`create table if not exists credit_ledger (
			id integer primary key autoincrement,
			tenant_id integer not null references tenants(id) on delete cascade,
			user_id integer not null references users(id) on delete cascade,
			delta integer not null,
			balance integer not null,
			reason text not null,
			ref_id text not null default '',
			created_at datetime not null default current_timestamp
		)`,
	}
	for _, stmt := range stmts {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	if _, err := s.db.ExecContext(ctx, `update users set role = 'admin'
		where id = (select min(id) from users)
		and not exists (select 1 from users where role = 'admin')`); err != nil {
		return err
	}
	return nil
}

func (s *Store) CreateUserWithTenant(ctx context.Context, email, passwordHash, displayName string, signupCredits int) (User, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if displayName == "" {
		displayName = strings.Split(email, "@")[0]
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback()

	nowSlug := fmt.Sprintf("%s-%d", sanitizeSlug(strings.Split(email, "@")[0]), time.Now().Unix())
	res, err := tx.ExecContext(ctx, `insert into tenants (name, slug) values (?, ?)`, displayName+"'s workspace", nowSlug)
	if err != nil {
		return User{}, err
	}
	tenantID, err := res.LastInsertId()
	if err != nil {
		return User{}, err
	}
	var existingUsers int
	if err := tx.QueryRowContext(ctx, `select count(*) from users`).Scan(&existingUsers); err != nil {
		return User{}, err
	}
	role := "member"
	if existingUsers == 0 {
		role = "admin"
	}
	res, err = tx.ExecContext(ctx, `insert into users (tenant_id, email, password_hash, display_name, role, credits) values (?, ?, ?, ?, ?, ?)`,
		tenantID, email, passwordHash, displayName, role, signupCredits)
	if err != nil {
		return User{}, err
	}
	userID, err := res.LastInsertId()
	if err != nil {
		return User{}, err
	}
	if _, err := tx.ExecContext(ctx, `insert into credit_ledger (tenant_id, user_id, delta, balance, reason) values (?, ?, ?, ?, ?)`,
		tenantID, userID, signupCredits, signupCredits, "signup"); err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return s.GetUserByID(ctx, userID)
}

func (s *Store) GetUserByEmail(ctx context.Context, email string) (User, error) {
	var u User
	err := s.db.QueryRowContext(ctx, `select id, tenant_id, email, password_hash, display_name, role, credits, created_at from users where email = ?`, strings.ToLower(strings.TrimSpace(email))).
		Scan(&u.ID, &u.TenantID, &u.Email, &u.Password, &u.DisplayName, &u.Role, &u.Credits, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return u, err
}

func (s *Store) GetUserByID(ctx context.Context, id int64) (User, error) {
	var u User
	err := s.db.QueryRowContext(ctx, `select id, tenant_id, email, password_hash, display_name, role, credits, created_at from users where id = ?`, id).
		Scan(&u.ID, &u.TenantID, &u.Email, &u.Password, &u.DisplayName, &u.Role, &u.Credits, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return u, err
}

func (s *Store) CreateSession(ctx context.Context, user User, title string) (Session, error) {
	if strings.TrimSpace(title) == "" {
		title = "New image session"
	}
	res, err := s.db.ExecContext(ctx, `insert into sessions (tenant_id, user_id, title) values (?, ?, ?)`, user.TenantID, user.ID, title)
	if err != nil {
		return Session{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Session{}, err
	}
	return s.GetSession(ctx, user, id)
}

func (s *Store) GetSession(ctx context.Context, user User, id int64) (Session, error) {
	var session Session
	err := s.db.QueryRowContext(ctx, `select id, tenant_id, user_id, title, created_at, updated_at from sessions where id = ? and tenant_id = ?`, id, user.TenantID).
		Scan(&session.ID, &session.TenantID, &session.UserID, &session.Title, &session.CreatedAt, &session.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	return session, err
}

func (s *Store) ListSessions(ctx context.Context, user User) ([]Session, error) {
	rows, err := s.db.QueryContext(ctx, `select id, tenant_id, user_id, title, created_at, updated_at from sessions where tenant_id = ? order by updated_at desc`, user.TenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var sessions []Session
	for rows.Next() {
		var item Session
		if err := rows.Scan(&item.ID, &item.TenantID, &item.UserID, &item.Title, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		sessions = append(sessions, item)
	}
	return sessions, rows.Err()
}

func (s *Store) UpdateSessionTitle(ctx context.Context, user User, id int64, title string) (Session, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return Session{}, errors.New("title is required")
	}
	if len([]rune(title)) > 80 {
		title = string([]rune(title)[:80])
	}
	res, err := s.db.ExecContext(ctx, `update sessions set title = ?, updated_at = current_timestamp where id = ? and tenant_id = ?`, title, id, user.TenantID)
	if err != nil {
		return Session{}, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return Session{}, err
	}
	if affected == 0 {
		return Session{}, ErrNotFound
	}
	return s.GetSession(ctx, user, id)
}

func (s *Store) GetSessionDetail(ctx context.Context, user User, id int64) (SessionDetail, error) {
	session, err := s.GetSession(ctx, user, id)
	if err != nil {
		return SessionDetail{}, err
	}
	assets, err := s.ListAssets(ctx, user, id)
	if err != nil {
		return SessionDetail{}, err
	}
	messages, err := s.ListMessages(ctx, user, id)
	if err != nil {
		return SessionDetail{}, err
	}
	tasks, err := s.ListTasks(ctx, user, id)
	if err != nil {
		return SessionDetail{}, err
	}
	return SessionDetail{Session: session, Assets: assets, Messages: messages, Tasks: tasks}, nil
}

func (s *Store) SaveAsset(ctx context.Context, user User, sessionID int64, fileName, mimeType, url string, sizeBytes int64) (Asset, error) {
	if _, err := s.GetSession(ctx, user, sessionID); err != nil {
		return Asset{}, err
	}
	res, err := s.db.ExecContext(ctx, `insert into assets (tenant_id, session_id, user_id, file_name, mime_type, url, size_bytes) values (?, ?, ?, ?, ?, ?, ?)`,
		user.TenantID, sessionID, user.ID, fileName, mimeType, url, sizeBytes)
	if err != nil {
		return Asset{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Asset{}, err
	}
	_ = s.touchSession(ctx, sessionID)
	return s.GetAsset(ctx, user, id)
}

func (s *Store) GetAsset(ctx context.Context, user User, id int64) (Asset, error) {
	var asset Asset
	err := s.db.QueryRowContext(ctx, `select id, session_id, user_id, file_name, mime_type, url, size_bytes, created_at from assets where id = ? and tenant_id = ?`, id, user.TenantID).
		Scan(&asset.ID, &asset.SessionID, &asset.UserID, &asset.FileName, &asset.MIMEType, &asset.URL, &asset.SizeBytes, &asset.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Asset{}, ErrNotFound
	}
	return asset, err
}

func (s *Store) ListAssets(ctx context.Context, user User, sessionID int64) ([]Asset, error) {
	rows, err := s.db.QueryContext(ctx, `select id, session_id, user_id, file_name, mime_type, url, size_bytes, created_at from assets where session_id = ? and tenant_id = ? order by id`, sessionID, user.TenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []Asset
	for rows.Next() {
		var item Asset
		if err := rows.Scan(&item.ID, &item.SessionID, &item.UserID, &item.FileName, &item.MIMEType, &item.URL, &item.SizeBytes, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) ListUserAssets(ctx context.Context, user User, limit int) ([]Asset, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `select id, session_id, user_id, file_name, mime_type, url, size_bytes, created_at from assets where tenant_id = ? order by id desc limit ?`, user.TenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []Asset
	for rows.Next() {
		var item Asset
		if err := rows.Scan(&item.ID, &item.SessionID, &item.UserID, &item.FileName, &item.MIMEType, &item.URL, &item.SizeBytes, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) AddMessage(ctx context.Context, user User, sessionID int64, role, content, prompt, taskID string) (Message, error) {
	if _, err := s.GetSession(ctx, user, sessionID); err != nil {
		return Message{}, err
	}
	res, err := s.db.ExecContext(ctx, `insert into messages (tenant_id, session_id, user_id, role, content, prompt, task_id) values (?, ?, ?, ?, ?, ?, ?)`,
		user.TenantID, sessionID, user.ID, role, content, prompt, taskID)
	if err != nil {
		return Message{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Message{}, err
	}
	_ = s.touchSession(ctx, sessionID)
	return s.GetMessage(ctx, user, id)
}

func (s *Store) GetMessage(ctx context.Context, user User, id int64) (Message, error) {
	var msg Message
	err := s.db.QueryRowContext(ctx, `select id, session_id, role, content, prompt, task_id, created_at from messages where id = ? and tenant_id = ?`, id, user.TenantID).
		Scan(&msg.ID, &msg.SessionID, &msg.Role, &msg.Content, &msg.Prompt, &msg.TaskID, &msg.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, ErrNotFound
	}
	return msg, err
}

func (s *Store) ListMessages(ctx context.Context, user User, sessionID int64) ([]Message, error) {
	rows, err := s.db.QueryContext(ctx, `select id, session_id, role, content, prompt, task_id, created_at from messages where session_id = ? and tenant_id = ? order by id`, sessionID, user.TenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []Message
	for rows.Next() {
		var item Message
		if err := rows.Scan(&item.ID, &item.SessionID, &item.Role, &item.Content, &item.Prompt, &item.TaskID, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) CreateTask(ctx context.Context, user User, sessionID int64, providerTaskID, status string, progress, cost int, prompt, requestJSON string) (Task, error) {
	res, err := s.db.ExecContext(ctx, `insert into tasks (tenant_id, session_id, user_id, provider_task_id, status, progress, cost, prompt, request_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		user.TenantID, sessionID, user.ID, providerTaskID, status, progress, cost, prompt, requestJSON)
	if err != nil {
		return Task{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Task{}, err
	}
	_ = s.touchSession(ctx, sessionID)
	return s.GetTaskByLocalID(ctx, user, id)
}

func (s *Store) GetTaskByLocalID(ctx context.Context, user User, id int64) (Task, error) {
	var task Task
	err := s.db.QueryRowContext(ctx, `select id, session_id, provider_task_id, status, progress, cost, prompt, result_json, error, created_at, updated_at from tasks where id = ? and tenant_id = ?`, id, user.TenantID).
		Scan(&task.ID, &task.SessionID, &task.ProviderTaskID, &task.Status, &task.Progress, &task.Cost, &task.Prompt, &task.ResultJSON, &task.Error, &task.CreatedAt, &task.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, ErrNotFound
	}
	return task, err
}

func (s *Store) GetTaskByProviderID(ctx context.Context, providerTaskID string) (Task, User, error) {
	var task Task
	var user User
	err := s.db.QueryRowContext(ctx, `select t.id, t.session_id, t.provider_task_id, t.status, t.progress, t.cost, t.prompt, t.result_json, t.error, t.created_at, t.updated_at,
		u.id, u.tenant_id, u.email, u.password_hash, u.display_name, u.role, u.credits, u.created_at
		from tasks t join users u on u.id = t.user_id where t.provider_task_id = ?`, providerTaskID).
		Scan(&task.ID, &task.SessionID, &task.ProviderTaskID, &task.Status, &task.Progress, &task.Cost, &task.Prompt, &task.ResultJSON, &task.Error, &task.CreatedAt, &task.UpdatedAt,
			&user.ID, &user.TenantID, &user.Email, &user.Password, &user.DisplayName, &user.Role, &user.Credits, &user.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, User{}, ErrNotFound
	}
	return task, user, err
}

func (s *Store) ListTasks(ctx context.Context, user User, sessionID int64) ([]Task, error) {
	rows, err := s.db.QueryContext(ctx, `select id, session_id, provider_task_id, status, progress, cost, prompt, result_json, error, created_at, updated_at from tasks where session_id = ? and tenant_id = ? order by id desc`, sessionID, user.TenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []Task
	for rows.Next() {
		var item Task
		if err := rows.Scan(&item.ID, &item.SessionID, &item.ProviderTaskID, &item.Status, &item.Progress, &item.Cost, &item.Prompt, &item.ResultJSON, &item.Error, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) UpdateTask(ctx context.Context, providerTaskID, status string, progress int, resultJSON, taskError string) error {
	_, err := s.db.ExecContext(ctx, `update tasks set status = ?, progress = ?, result_json = ?, error = ?, updated_at = current_timestamp where provider_task_id = ?`,
		status, progress, resultJSON, taskError, providerTaskID)
	return err
}

func (s *Store) ReserveCredits(ctx context.Context, user User, amount int, reason, refID string) error {
	if amount <= 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var credits int
	if err := tx.QueryRowContext(ctx, `select credits from users where id = ?`, user.ID).Scan(&credits); err != nil {
		return err
	}
	if credits < amount {
		return ErrInsufficientCredits
	}
	balance := credits - amount
	if _, err := tx.ExecContext(ctx, `update users set credits = ? where id = ?`, balance, user.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `insert into credit_ledger (tenant_id, user_id, delta, balance, reason, ref_id) values (?, ?, ?, ?, ?, ?)`, user.TenantID, user.ID, -amount, balance, reason, refID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) AddCredits(ctx context.Context, user User, amount int, reason, refID string) error {
	if amount == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var credits int
	if err := tx.QueryRowContext(ctx, `select credits from users where id = ?`, user.ID).Scan(&credits); err != nil {
		return err
	}
	balance := credits + amount
	if _, err := tx.ExecContext(ctx, `update users set credits = ? where id = ?`, balance, user.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `insert into credit_ledger (tenant_id, user_id, delta, balance, reason, ref_id) values (?, ?, ?, ?, ?, ?)`, user.TenantID, user.ID, amount, balance, reason, refID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ListLedger(ctx context.Context, user User, limit int) ([]CreditLedger, error) {
	if limit <= 0 || limit > 200 {
		limit = 80
	}
	rows, err := s.db.QueryContext(ctx, `select id, tenant_id, user_id, delta, balance, reason, ref_id, created_at from credit_ledger where tenant_id = ? and user_id = ? order by id desc limit ?`, user.TenantID, user.ID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanLedger(rows)
}

func (s *Store) UsageSummary(ctx context.Context, user User) (UsageSummary, error) {
	summary := UsageSummary{Credits: user.Credits}
	err := s.db.QueryRowContext(ctx, `select count(*), coalesce(sum(case when status = 'completed' then 1 else 0 end), 0), coalesce(sum(case when status = 'failed' then 1 else 0 end), 0), coalesce(sum(cost), 0) from tasks where tenant_id = ? and user_id = ?`, user.TenantID, user.ID).
		Scan(&summary.GeneratedTasks, &summary.CompletedTasks, &summary.FailedTasks, &summary.CreditsSpent)
	if err != nil {
		return UsageSummary{}, err
	}
	if err := s.db.QueryRowContext(ctx, `select count(*) from assets where tenant_id = ? and user_id = ?`, user.TenantID, user.ID).Scan(&summary.ReferenceImages); err != nil {
		return UsageSummary{}, err
	}
	return summary, nil
}

func (s *Store) AdminListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx, `select id, tenant_id, email, password_hash, display_name, role, credits, created_at from users order by id asc`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.TenantID, &u.Email, &u.Password, &u.DisplayName, &u.Role, &u.Credits, &u.CreatedAt); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

func (s *Store) AdminAdjustCredits(ctx context.Context, admin User, targetUserID int64, delta int, reason string) (User, error) {
	if delta == 0 {
		return s.GetUserByID(ctx, targetUserID)
	}
	if strings.TrimSpace(reason) == "" {
		reason = "admin_adjustment"
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback()
	var target User
	if err := tx.QueryRowContext(ctx, `select id, tenant_id, email, password_hash, display_name, role, credits, created_at from users where id = ?`, targetUserID).
		Scan(&target.ID, &target.TenantID, &target.Email, &target.Password, &target.DisplayName, &target.Role, &target.Credits, &target.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, ErrNotFound
		}
		return User{}, err
	}
	balance := target.Credits + delta
	if balance < 0 {
		return User{}, ErrInsufficientCredits
	}
	if _, err := tx.ExecContext(ctx, `update users set credits = ? where id = ?`, balance, targetUserID); err != nil {
		return User{}, err
	}
	refID := fmt.Sprintf("admin:%d", admin.ID)
	if _, err := tx.ExecContext(ctx, `insert into credit_ledger (tenant_id, user_id, delta, balance, reason, ref_id) values (?, ?, ?, ?, ?, ?)`,
		target.TenantID, target.ID, delta, balance, reason, refID); err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return s.GetUserByID(ctx, targetUserID)
}

func (s *Store) RefundTaskCredits(ctx context.Context, providerTaskID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var tenantID, userID int64
	var cost int
	if err := tx.QueryRowContext(ctx, `select tenant_id, user_id, cost from tasks where provider_task_id = ?`, providerTaskID).Scan(&tenantID, &userID, &cost); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if cost <= 0 {
		return tx.Commit()
	}
	var existing int
	if err := tx.QueryRowContext(ctx, `select count(*) from credit_ledger where user_id = ? and reason = 'generation_refund' and ref_id = ?`, userID, providerTaskID).Scan(&existing); err != nil {
		return err
	}
	if existing > 0 {
		return tx.Commit()
	}
	var credits int
	if err := tx.QueryRowContext(ctx, `select credits from users where id = ?`, userID).Scan(&credits); err != nil {
		return err
	}
	balance := credits + cost
	if _, err := tx.ExecContext(ctx, `update users set credits = ? where id = ?`, balance, userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `insert into credit_ledger (tenant_id, user_id, delta, balance, reason, ref_id) values (?, ?, ?, ?, ?, ?)`,
		tenantID, userID, cost, balance, "generation_refund", providerTaskID); err != nil {
		return err
	}
	return tx.Commit()
}

func scanLedger(rows *sql.Rows) ([]CreditLedger, error) {
	var items []CreditLedger
	for rows.Next() {
		var item CreditLedger
		if err := rows.Scan(&item.ID, &item.TenantID, &item.UserID, &item.Delta, &item.Balance, &item.Reason, &item.RefID, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) touchSession(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `update sessions set updated_at = current_timestamp where id = ?`, id)
	return err
}

func sanitizeSlug(input string) string {
	input = strings.ToLower(input)
	var b strings.Builder
	for _, r := range input {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else if b.Len() > 0 {
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "tenant"
	}
	return out
}
