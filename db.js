const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'antar.db');
const db = new sqlite3.Database(DB_PATH);

// Promisify helpers
db.run_ = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(err) { if (err) rej(err); else res(this); }));
db.get_ = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (err, row) => { if (err) rej(err); else res(row); }));
db.all_ = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (err, rows) => { if (err) rej(err); else res(rows); }));

// Init schema
db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT DEFAULT '', created_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL DEFAULT 'New Chat',
    session_id TEXT NOT NULL, telegram_session_key TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, attachments TEXT DEFAULT '[]', created_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL, password_hash TEXT, created_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'accord',
    created_at INTEGER NOT NULL,
    created_by TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`ALTER TABLE chats ADD COLUMN owner_id TEXT`, (e) => { if (e && !e.message.includes('duplicate')) console.error('alter owner_id:', e.message); });
  db.run(`ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1`, (e) => { if (e && !e.message.includes('duplicate')) console.error('alter active:', e.message); });
  db.run(`ALTER TABLE projects ADD COLUMN guardrails TEXT DEFAULT ''`, (e) => { if (e && !e.message.includes('duplicate')) console.error('alter guardrails:', e.message); });
  db.run(`CREATE TABLE IF NOT EXISTS project_access (
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    granted_by TEXT,
    granted_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, user_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS guest_permissions (
    user_id TEXT NOT NULL,
    permission TEXT NOT NULL,
    granted_by TEXT,
    granted_at INTEGER NOT NULL,
    requires_approval TEXT,
    PRIMARY KEY (user_id, permission)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_chats_project_id ON chats(project_id)`);
  db.run(`CREATE TABLE IF NOT EXISTS project_files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    mimetype TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_project_files_project_id ON project_files(project_id)`);
  db.run(`CREATE TABLE IF NOT EXISTS project_links (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    link_type TEXT NOT NULL DEFAULT 'doc',
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_project_links_project_id ON project_links(project_id)`);

  // Phase 3 migrations
  db.run(`ALTER TABLE messages ADD COLUMN user_id TEXT`, (e) => { if (e && !e.message.includes('duplicate')) console.error('alter messages.user_id:', e.message); });
  db.run(`ALTER TABLE messages ADD COLUMN display_name TEXT`, (e) => { if (e && !e.message.includes('duplicate')) console.error('alter messages.display_name:', e.message); });
  db.run(`ALTER TABLE chats ADD COLUMN is_open INTEGER NOT NULL DEFAULT 0`, (e) => { if (e && !e.message.includes('duplicate')) console.error('alter chats.is_open:', e.message); });
  db.run(`CREATE TABLE IF NOT EXISTS chat_invites (
    token TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    active INTEGER NOT NULL DEFAULT 1
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS chat_participants (
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_chat_participants_chat_id ON chat_participants(chat_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_chat_invites_chat_id ON chat_invites(chat_id)`);

  // Phase 4 migrations
  db.run(`CREATE TABLE IF NOT EXISTS permission_approvals (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    guest_user_id TEXT NOT NULL,
    permission TEXT NOT NULL,
    action_name TEXT,
    action_payload TEXT,
    requires_approval TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by TEXT,
    decided_at INTEGER,
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_permission_approvals_chat_id ON permission_approvals(chat_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_permission_approvals_guest_user_id ON permission_approvals(guest_user_id)`);

  // Phase 5 migrations
  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    actor_user_id TEXT,
    actor_email TEXT,
    action TEXT NOT NULL,
    target TEXT,
    details TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp)`);
});

module.exports = db;
