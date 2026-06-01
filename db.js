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
});

module.exports = db;
