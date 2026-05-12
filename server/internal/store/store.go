package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
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
	AvatarURL   string    `json:"avatar_url"`
	Role        string    `json:"role"`
	Credits     int       `json:"credits"`
	CreatedAt   time.Time `json:"created_at"`
}

type Session struct {
	ID          int64      `json:"id"`
	PublicID    string     `json:"public_id"`
	TenantID    int64      `json:"tenant_id"`
	UserID      int64      `json:"user_id"`
	Title       string     `json:"title"`
	Kind        string     `json:"kind"`
	CanvasState string     `json:"canvas_state,omitempty"`
	TaskStatus  string     `json:"task_status,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	ArchivedAt  *time.Time `json:"archived_at,omitempty"`
}

type Asset struct {
	ID          int64     `json:"id"`
	SessionID   int64     `json:"session_id"`
	UserID      int64     `json:"user_id"`
	FileName    string    `json:"file_name"`
	MIMEType    string    `json:"mime_type"`
	URL         string    `json:"url"`
	LocalURL    string    `json:"local_url,omitempty"`
	SizeBytes   int64     `json:"size_bytes"`
	Provider    string    `json:"provider"`
	ContentHash string    `json:"content_hash"`
	CreatedAt   time.Time `json:"created_at"`
	LastUsedAt  string    `json:"last_used_at,omitempty"`
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
	Provider       string    `json:"provider"`
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

func (s *Store) ensureColumn(ctx context.Context, table, column, definition string) error {
	rows, err := s.db.QueryContext(ctx, fmt.Sprintf(`pragma table_info(%s)`, table))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull int
		var defaultValue any
		var pk int
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
			return err
		}
		if name == column {
			return rows.Err()
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, fmt.Sprintf(`alter table %s add column %s %s`, table, column, definition))
	return err
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
			public_id text not null unique,
			tenant_id integer not null references tenants(id) on delete cascade,
			user_id integer not null references users(id) on delete cascade,
			title text not null,
			kind text not null default 'chat',
			canvas_state text not null default '',
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
			last_used_at text not null default '',
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
			provider text not null default '',
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
		`create table if not exists system_settings (
			key text primary key,
			value text not null,
			updated_at datetime not null default current_timestamp
		)`,
	}
	for _, stmt := range stmts {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	if err := s.ensureColumn(ctx, "sessions", "archived_at", "datetime"); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "sessions", "public_id", "text not null default ''"); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "sessions", "kind", "text not null default 'chat'"); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "sessions", "canvas_state", "text not null default ''"); err != nil {
		return err
	}
	if err := s.backfillSessionPublicIDs(ctx); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `create unique index if not exists idx_sessions_public_id on sessions(public_id)`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "assets", "provider", "text not null default ''"); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "assets", "content_hash", "text not null default ''"); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "assets", "local_url", "text not null default ''"); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "assets", "last_used_at", "text not null default ''"); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "users", "avatar_url", "text not null default ''"); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "tasks", "provider", "text not null default ''"); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `update users set role = 'admin'
		where id = (select min(id) from users)
		and not exists (select 1 from users where role = 'admin')`); err != nil {
		return err
	}
	return nil
}

func (s *Store) backfillSessionPublicIDs(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `select id from sessions where public_id = ''`)
	if err != nil {
		return err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := s.db.ExecContext(ctx, `update sessions set public_id = ? where id = ?`, uuid.NewString(), id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) GetSystemSetting(ctx context.Context, key string) (string, error) {
	var value string
	err := s.db.QueryRowContext(ctx, `select value from system_settings where key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return value, err
}

func (s *Store) SaveSystemSetting(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx, `insert into system_settings (key, value, updated_at) values (?, ?, current_timestamp)
		on conflict(key) do update set value = excluded.value, updated_at = current_timestamp`, key, value)
	return err
}

func (s *Store) EnsureSystemSetting(ctx context.Context, key, value string) error {
	var existing int
	if err := s.db.QueryRowContext(ctx, `select count(*) from system_settings where key = ?`, key).Scan(&existing); err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}
	return s.SaveSystemSetting(ctx, key, value)
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
	err := s.db.QueryRowContext(ctx, `select id, tenant_id, email, password_hash, display_name, avatar_url, role, credits, created_at from users where email = ?`, strings.ToLower(strings.TrimSpace(email))).
		Scan(&u.ID, &u.TenantID, &u.Email, &u.Password, &u.DisplayName, &u.AvatarURL, &u.Role, &u.Credits, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return u, err
}

func (s *Store) GetUserByID(ctx context.Context, id int64) (User, error) {
	var u User
	err := s.db.QueryRowContext(ctx, `select id, tenant_id, email, password_hash, display_name, avatar_url, role, credits, created_at from users where id = ?`, id).
		Scan(&u.ID, &u.TenantID, &u.Email, &u.Password, &u.DisplayName, &u.AvatarURL, &u.Role, &u.Credits, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return u, err
}

func (s *Store) UpdateUserProfile(ctx context.Context, user User, email, displayName string) (User, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	displayName = strings.TrimSpace(displayName)
	if email == "" {
		return User{}, errors.New("email is required")
	}
	if displayName == "" {
		displayName = strings.Split(email, "@")[0]
	}
	res, err := s.db.ExecContext(ctx, `update users set email = ?, display_name = ? where id = ? and tenant_id = ?`, email, displayName, user.ID, user.TenantID)
	if err != nil {
		return User{}, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return User{}, err
	}
	if affected == 0 {
		return User{}, ErrNotFound
	}
	return s.GetUserByID(ctx, user.ID)
}

func (s *Store) UpdateUserPassword(ctx context.Context, user User, passwordHash string) error {
	res, err := s.db.ExecContext(ctx, `update users set password_hash = ? where id = ? and tenant_id = ?`, passwordHash, user.ID, user.TenantID)
	if err != nil {
		return err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) UpdateUserAvatar(ctx context.Context, user User, avatarURL string) (User, error) {
	res, err := s.db.ExecContext(ctx, `update users set avatar_url = ? where id = ? and tenant_id = ?`, strings.TrimSpace(avatarURL), user.ID, user.TenantID)
	if err != nil {
		return User{}, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return User{}, err
	}
	if affected == 0 {
		return User{}, ErrNotFound
	}
	return s.GetUserByID(ctx, user.ID)
}

func (s *Store) CreateSession(ctx context.Context, user User, title, kind string) (Session, error) {
	kind = strings.TrimSpace(kind)
	if kind == "" {
		kind = "chat"
	}
	if strings.TrimSpace(title) == "" {
		if kind == "canvas" {
			title = "新建画布"
		} else {
			title = "未命名会话"
		}
	}
	if err := s.DeleteEmptySessions(ctx, user); err != nil {
		return Session{}, err
	}
	res, err := s.db.ExecContext(ctx, `insert into sessions (public_id, tenant_id, user_id, title, kind) values (?, ?, ?, ?, ?)`, uuid.NewString(), user.TenantID, user.ID, title, kind)
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
	var archivedAt sql.NullTime
	err := s.db.QueryRowContext(ctx, `select id, public_id, tenant_id, user_id, title, kind, canvas_state, '', created_at, updated_at, archived_at from sessions where id = ? and tenant_id = ? and archived_at is null`, id, user.TenantID).
		Scan(&session.ID, &session.PublicID, &session.TenantID, &session.UserID, &session.Title, &session.Kind, &session.CanvasState, &session.TaskStatus, &session.CreatedAt, &session.UpdatedAt, &archivedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	if archivedAt.Valid {
		session.ArchivedAt = &archivedAt.Time
	}
	return session, err
}

func (s *Store) ListSessions(ctx context.Context, user User) ([]Session, error) {
	rows, err := s.db.QueryContext(ctx, `select s.id, s.public_id, s.tenant_id, s.user_id, s.title, s.kind, s.canvas_state,
		coalesce((select t.status from tasks t where t.session_id = s.id order by t.id desc limit 1), '') as task_status,
		s.created_at, s.updated_at, s.archived_at from sessions s where s.tenant_id = ? and s.archived_at is null order by s.updated_at desc`, user.TenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSessions(rows)
}

func (s *Store) ListAllSessions(ctx context.Context, user User) ([]Session, error) {
	rows, err := s.db.QueryContext(ctx, `select s.id, s.public_id, s.tenant_id, s.user_id, s.title, s.kind, s.canvas_state,
		coalesce((select t.status from tasks t where t.session_id = s.id order by t.id desc limit 1), '') as task_status,
		s.created_at, s.updated_at, s.archived_at from sessions s where s.tenant_id = ? order by coalesce(s.archived_at, s.updated_at) desc`, user.TenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSessions(rows)
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

func (s *Store) UpdateSessionCanvasState(ctx context.Context, user User, id int64, canvasState string) (Session, error) {
	res, err := s.db.ExecContext(ctx, `update sessions set canvas_state = ?, updated_at = current_timestamp where id = ? and tenant_id = ?`, canvasState, id, user.TenantID)
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

func (s *Store) ArchiveSession(ctx context.Context, user User, id int64) error {
	res, err := s.db.ExecContext(ctx, `update sessions set archived_at = current_timestamp, updated_at = current_timestamp where id = ? and tenant_id = ? and archived_at is null`, id, user.TenantID)
	if err != nil {
		return err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) UnarchiveSession(ctx context.Context, user User, id int64) (Session, error) {
	res, err := s.db.ExecContext(ctx, `update sessions set archived_at = null, updated_at = current_timestamp where id = ? and tenant_id = ?`, id, user.TenantID)
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

func (s *Store) DeleteSession(ctx context.Context, user User, id int64) error {
	res, err := s.db.ExecContext(ctx, `delete from sessions where id = ? and tenant_id = ?`, id, user.TenantID)
	if err != nil {
		return err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteEmptySessions(ctx context.Context, user User) error {
	_, err := s.db.ExecContext(ctx, `delete from sessions
		where tenant_id = ? and user_id = ? and archived_at is null
		and title in ('未命名会话', 'New image session')
		and not exists (select 1 from messages where messages.session_id = sessions.id)
		and not exists (select 1 from assets where assets.session_id = sessions.id)
		and not exists (select 1 from tasks where tasks.session_id = sessions.id)`, user.TenantID, user.ID)
	return err
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

func (s *Store) SaveAsset(ctx context.Context, user User, sessionID int64, fileName, mimeType, url, localURL string, sizeBytes int64, provider, contentHash string) (Asset, error) {
	if _, err := s.GetSession(ctx, user, sessionID); err != nil {
		return Asset{}, err
	}
	res, err := s.db.ExecContext(ctx, `insert into assets (tenant_id, session_id, user_id, file_name, mime_type, url, local_url, size_bytes, provider, content_hash, last_used_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, current_timestamp)`,
		user.TenantID, sessionID, user.ID, fileName, mimeType, url, localURL, sizeBytes, provider, contentHash)
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
	err := s.db.QueryRowContext(ctx, assetSelectSQL()+` where id = ? and tenant_id = ?`, id, user.TenantID).
		Scan(scanAssetDest(&asset)...)
	if errors.Is(err, sql.ErrNoRows) {
		return Asset{}, ErrNotFound
	}
	return asset, err
}

func (s *Store) FindAssetByHash(ctx context.Context, user User, sessionID int64, provider, contentHash string) (Asset, error) {
	if strings.TrimSpace(provider) == "" || strings.TrimSpace(contentHash) == "" {
		return Asset{}, ErrNotFound
	}
	var asset Asset
	err := s.db.QueryRowContext(ctx, assetSelectSQL()+` where session_id = ? and tenant_id = ? and provider = ? and content_hash = ? order by id desc limit 1`,
		sessionID, user.TenantID, provider, contentHash).
		Scan(scanAssetDest(&asset)...)
	if errors.Is(err, sql.ErrNoRows) {
		return Asset{}, ErrNotFound
	}
	return asset, err
}

func (s *Store) SetAssetLocalURL(ctx context.Context, user User, id int64, localURL string) error {
	if strings.TrimSpace(localURL) == "" {
		return nil
	}
	res, err := s.db.ExecContext(ctx, `update assets set local_url = ? where id = ? and tenant_id = ?`, localURL, id, user.TenantID)
	if err != nil {
		return err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListAssets(ctx context.Context, user User, sessionID int64) ([]Asset, error) {
	rows, err := s.db.QueryContext(ctx, assetSelectSQL()+` where session_id = ? and tenant_id = ? order by coalesce(nullif(last_used_at, ''), created_at) desc, id desc`, sessionID, user.TenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanAssets(rows)
}

func (s *Store) ListUserAssets(ctx context.Context, user User, limit int) ([]Asset, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := s.db.QueryContext(ctx, assetSelectSQL()+` where tenant_id = ? order by coalesce(nullif(last_used_at, ''), created_at) desc, id desc limit ?`, user.TenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanAssets(rows)
}

func (s *Store) ListPendingDownloads(ctx context.Context, limit int) ([]Asset, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `select a.id, a.session_id, a.user_id, a.file_name, a.mime_type, a.url, a.local_url, a.size_bytes, a.provider, a.content_hash, a.created_at, a.last_used_at
		from assets a where a.local_url = '' and a.url != '' and a.url like 'http%' order by a.id desc limit ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []Asset
	for rows.Next() {
		var item Asset
		if err := rows.Scan(scanAssetDest(&item)...); err != nil {
			continue
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) SetAssetLocalURLByID(ctx context.Context, id int64, localURL string) error {
	_, err := s.db.ExecContext(ctx, `update assets set local_url = ? where id = ?`, localURL, id)
	return err
}

func (s *Store) TouchAssetsUsed(ctx context.Context, user User, ids []int64) error {
	seen := map[int64]bool{}
	for _, id := range ids {
		if id <= 0 || seen[id] {
			continue
		}
		seen[id] = true
		if _, err := s.db.ExecContext(ctx, `update assets set last_used_at = current_timestamp where id = ? and tenant_id = ?`, id, user.TenantID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) DeleteAsset(ctx context.Context, user User, id int64) error {
	var sessionID int64
	err := s.db.QueryRowContext(ctx, `select session_id from assets where id = ? and tenant_id = ?`, id, user.TenantID).Scan(&sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	res, err := s.db.ExecContext(ctx, `delete from assets where id = ? and tenant_id = ?`, id, user.TenantID)
	if err != nil {
		return err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrNotFound
	}
	_ = s.touchSession(ctx, sessionID)
	return nil
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

func (s *Store) CreateTask(ctx context.Context, user User, sessionID int64, provider, providerTaskID, status string, progress, cost int, prompt, requestJSON string) (Task, error) {
	res, err := s.db.ExecContext(ctx, `insert into tasks (tenant_id, session_id, user_id, provider, provider_task_id, status, progress, cost, prompt, request_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		user.TenantID, sessionID, user.ID, provider, providerTaskID, status, progress, cost, prompt, requestJSON)
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
	err := s.db.QueryRowContext(ctx, `select id, session_id, provider, provider_task_id, status, progress, cost, prompt, result_json, error, created_at, updated_at from tasks where id = ? and tenant_id = ?`, id, user.TenantID).
		Scan(&task.ID, &task.SessionID, &task.Provider, &task.ProviderTaskID, &task.Status, &task.Progress, &task.Cost, &task.Prompt, &task.ResultJSON, &task.Error, &task.CreatedAt, &task.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, ErrNotFound
	}
	return task, err
}

func (s *Store) GetTaskByProviderID(ctx context.Context, providerTaskID string) (Task, User, error) {
	var task Task
	var user User
	err := s.db.QueryRowContext(ctx, `select t.id, t.session_id, t.provider, t.provider_task_id, t.status, t.progress, t.cost, t.prompt, t.result_json, t.error, t.created_at, t.updated_at,
		u.id, u.tenant_id, u.email, u.password_hash, u.display_name, u.avatar_url, u.role, u.credits, u.created_at
		from tasks t join users u on u.id = t.user_id where t.provider_task_id = ?`, providerTaskID).
		Scan(&task.ID, &task.SessionID, &task.Provider, &task.ProviderTaskID, &task.Status, &task.Progress, &task.Cost, &task.Prompt, &task.ResultJSON, &task.Error, &task.CreatedAt, &task.UpdatedAt,
			&user.ID, &user.TenantID, &user.Email, &user.Password, &user.DisplayName, &user.AvatarURL, &user.Role, &user.Credits, &user.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, User{}, ErrNotFound
	}
	return task, user, err
}

func (s *Store) ListTasks(ctx context.Context, user User, sessionID int64) ([]Task, error) {
	rows, err := s.db.QueryContext(ctx, `select id, session_id, provider, provider_task_id, status, progress, cost, prompt, result_json, error, created_at, updated_at from tasks where session_id = ? and tenant_id = ? order by id desc`, sessionID, user.TenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []Task
	for rows.Next() {
		var item Task
		if err := rows.Scan(&item.ID, &item.SessionID, &item.Provider, &item.ProviderTaskID, &item.Status, &item.Progress, &item.Cost, &item.Prompt, &item.ResultJSON, &item.Error, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) ListUserTasks(ctx context.Context, user User, limit int) ([]Task, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := s.db.QueryContext(ctx, `select id, session_id, provider, provider_task_id, status, progress, cost, prompt, result_json, error, created_at, updated_at from tasks where tenant_id = ? and user_id = ? order by id desc limit ?`, user.TenantID, user.ID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []Task
	for rows.Next() {
		var item Task
		if err := rows.Scan(&item.ID, &item.SessionID, &item.Provider, &item.ProviderTaskID, &item.Status, &item.Progress, &item.Cost, &item.Prompt, &item.ResultJSON, &item.Error, &item.CreatedAt, &item.UpdatedAt); err != nil {
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
	err := s.db.QueryRowContext(ctx, `select count(*), coalesce(sum(case when status = 'completed' then 1 else 0 end), 0), coalesce(sum(case when status = 'failed' then 1 else 0 end), 0) from tasks where tenant_id = ? and user_id = ?`, user.TenantID, user.ID).
		Scan(&summary.GeneratedTasks, &summary.CompletedTasks, &summary.FailedTasks)
	if err != nil {
		return UsageSummary{}, err
	}
	err = s.db.QueryRowContext(ctx, `select coalesce(sum(-delta), 0) from credit_ledger
		where tenant_id = ? and user_id = ? and delta < 0 and reason in ('image_generation', 'llm_planner', 'llm_reply')`, user.TenantID, user.ID).
		Scan(&summary.CreditsSpent)
	if err != nil {
		return UsageSummary{}, err
	}
	if err := s.db.QueryRowContext(ctx, `select count(*) from assets where tenant_id = ? and user_id = ?`, user.TenantID, user.ID).Scan(&summary.ReferenceImages); err != nil {
		return UsageSummary{}, err
	}
	return summary, nil
}

func (s *Store) AdminListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx, `select id, tenant_id, email, password_hash, display_name, avatar_url, role, credits, created_at from users order by id asc`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.TenantID, &u.Email, &u.Password, &u.DisplayName, &u.AvatarURL, &u.Role, &u.Credits, &u.CreatedAt); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

type AdminStats struct {
	TotalUsers    int           `json:"total_users"`
	TotalSessions int           `json:"total_sessions"`
	TotalTasks    int           `json:"total_tasks"`
	TotalCredits  int           `json:"total_credits_spent"`
	DailyUsage    []DailyBucket `json:"daily_usage"`
	UsageBuckets  []UsageBucket `json:"usage_buckets"`
}

type DailyBucket struct {
	Date    string `json:"date"`
	Tasks   int    `json:"tasks"`
	Credits int    `json:"credits"`
}

type UsageBucket struct {
	Period       string `json:"period"`
	Tasks        int    `json:"tasks"`
	Credits      int    `json:"credits"`
	TextCredits  int    `json:"text_credits"`
	ImageCredits int    `json:"image_credits"`
}

func (s *Store) AdminStats(ctx context.Context, granularity string, window int) (AdminStats, error) {
	var stats AdminStats
	if err := s.db.QueryRowContext(ctx, `select count(*) from users`).Scan(&stats.TotalUsers); err != nil {
		return stats, err
	}
	if err := s.db.QueryRowContext(ctx, `select count(*) from sessions`).Scan(&stats.TotalSessions); err != nil {
		return stats, err
	}
	if err := s.db.QueryRowContext(ctx, `select count(*) from tasks`).Scan(&stats.TotalTasks); err != nil {
		return stats, err
	}
	if err := s.db.QueryRowContext(ctx, `select coalesce(sum(-delta),0) from credit_ledger where delta < 0 and reason in ('image_generation', 'llm_planner', 'llm_reply')`).Scan(&stats.TotalCredits); err != nil {
		return stats, err
	}

	bucketExpr := "date(created_at)"
	modifier := fmt.Sprintf("-%d days", window)
	if granularity == "hour" {
		bucketExpr = "strftime('%Y-%m-%d %H:00', created_at)"
		modifier = fmt.Sprintf("-%d hours", window)
	}

	rows, err := s.db.QueryContext(ctx, fmt.Sprintf(`
		select %s as bucket,
			sum(case when reason = 'image_generation' then 1 else 0 end) as tasks,
			coalesce(sum(-delta), 0) as credits,
			coalesce(sum(case when reason in ('llm_planner', 'llm_reply') then -delta else 0 end), 0) as text_credits,
			coalesce(sum(case when reason = 'image_generation' then -delta else 0 end), 0) as image_credits
		from credit_ledger
		where delta < 0
			and reason in ('image_generation', 'llm_planner', 'llm_reply')
			and created_at >= datetime('now', ?)
		group by bucket
		order by bucket asc`, bucketExpr), modifier)
	if err != nil {
		return stats, err
	}
	defer rows.Close()
	for rows.Next() {
		var b UsageBucket
		if err := rows.Scan(&b.Period, &b.Tasks, &b.Credits, &b.TextCredits, &b.ImageCredits); err != nil {
			return stats, err
		}
		stats.UsageBuckets = append(stats.UsageBuckets, b)
		stats.DailyUsage = append(stats.DailyUsage, DailyBucket{Date: b.Period, Tasks: b.Tasks, Credits: b.Credits})
	}
	return stats, rows.Err()
}

type AdminLedgerEntry struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"user_id"`
	UserEmail string    `json:"user_email"`
	Delta     int       `json:"delta"`
	Balance   int       `json:"balance"`
	Reason    string    `json:"reason"`
	RefID     string    `json:"ref_id"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *Store) AdminListLedger(ctx context.Context, limit int) ([]AdminLedgerEntry, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := s.db.QueryContext(ctx, `
		select cl.id, cl.user_id, u.email, cl.delta, cl.balance, cl.reason, cl.ref_id, cl.created_at
		from credit_ledger cl join users u on u.id = cl.user_id
		order by cl.id desc limit ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var entries []AdminLedgerEntry
	for rows.Next() {
		var e AdminLedgerEntry
		if err := rows.Scan(&e.ID, &e.UserID, &e.UserEmail, &e.Delta, &e.Balance, &e.Reason, &e.RefID, &e.CreatedAt); err != nil {
			continue
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
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
	if err := tx.QueryRowContext(ctx, `select id, tenant_id, email, password_hash, display_name, avatar_url, role, credits, created_at from users where id = ?`, targetUserID).
		Scan(&target.ID, &target.TenantID, &target.Email, &target.Password, &target.DisplayName, &target.AvatarURL, &target.Role, &target.Credits, &target.CreatedAt); err != nil {
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

func scanSessions(rows *sql.Rows) ([]Session, error) {
	var sessions []Session
	for rows.Next() {
		var item Session
		var archivedAt sql.NullTime
		if err := rows.Scan(&item.ID, &item.PublicID, &item.TenantID, &item.UserID, &item.Title, &item.Kind, &item.CanvasState, &item.TaskStatus, &item.CreatedAt, &item.UpdatedAt, &archivedAt); err != nil {
			return nil, err
		}
		if archivedAt.Valid {
			item.ArchivedAt = &archivedAt.Time
		}
		sessions = append(sessions, item)
	}
	return sessions, rows.Err()
}

func assetSelectSQL() string {
	return `select id, session_id, user_id, file_name, mime_type, url, local_url, size_bytes, provider, content_hash, created_at, last_used_at from assets`
}

func scanAssetDest(asset *Asset) []any {
	return []any{&asset.ID, &asset.SessionID, &asset.UserID, &asset.FileName, &asset.MIMEType, &asset.URL, &asset.LocalURL, &asset.SizeBytes, &asset.Provider, &asset.ContentHash, &asset.CreatedAt, &asset.LastUsedAt}
}

func scanAssets(rows *sql.Rows) ([]Asset, error) {
	var items []Asset
	for rows.Next() {
		var item Asset
		if err := rows.Scan(scanAssetDest(&item)...); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
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
