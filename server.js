require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');
const bcrypt = require('bcrypt');
const { randomUUID: uuidv4 } = require('crypto');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { exec, execFile } = require('child_process');
// Load local version
const LOCAL_VERSION_PATH = path.join(__dirname, 'version.json');
let localVersion = { version: 'unknown', label: '' };
try { localVersion = JSON.parse(fs.readFileSync(LOCAL_VERSION_PATH, 'utf8')); } catch(e) {}

// Track active agent child processes for abort: { chatId: { child, aiMsgId } }
const activeAgentProcesses = {};

// Resolve instance config from ~/.openclaw/.env
function getInstanceConfig() {
  let name = 'Antar';
  let url = 'https://your-agent-url';
  try {
    const envPath = path.join(process.env.HOME, '.openclaw', '.env');
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const mName = line.match(/^INSTANCE_NAME=(.*)$/);
      if (mName) name = mName[1].trim().replace(/^["']|["']$/g, '');
      const mUrl = line.match(/^INSTANCE_URL=(.*)$/);
      if (mUrl) url = mUrl[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
  return { name, url };
}

// --- Phase 3: SSE Infrastructure ---
// chatSSEClients: Map<chatId, Set<res>>
const chatSSEClients = new Map();
// typingUsers: Map<chatId, Map<userId, lastSeenAt>>
const typingUsers = new Map();

// --- Global user-event SSE ---
// userSSEClients: Map<userId|'legacy', Set<res>>
const userSSEClients = new Map();

function broadcastToUser(userId, eventType, data) {
  const clients = userSSEClients.get(String(userId));
  if (!clients || clients.size === 0) return;
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => { try { res.write(payload); } catch {} });
}

// Broadcast a global event to all connected users who can see the given chat
async function broadcastChatCreated(chat, excludeUserId = null) {
  // Build list of (userId, role) currently subscribed
  // excludeUserId: skip the user who created the chat (they already have it locally)
  const excludeStr = excludeUserId ? String(excludeUserId) : null;
  for (const [uid, clients] of userSSEClients) {
    if (!clients || clients.size === 0) continue;
    // Skip the creator — their client handles insertion optimistically
    if (excludeStr && uid === excludeStr) continue;
    // Determine if this user can see the chat
    // legacy sessions (uid === 'legacy') are admin-equivalent
    if (uid === 'legacy') {
      // Only skip legacy if there's no excludeUserId (legacy = unauthenticated admin)
      if (!excludeStr) broadcastToUser('legacy', 'chat_created', { chat });
      continue;
    }
    const user = await db.get_('SELECT role FROM users WHERE id = ?', [uid]);
    if (!user) continue;
    if (user.role === 'admin' || user.role === 'accord') {
      broadcastToUser(uid, 'chat_created', { chat });
    } else if (user.role === 'guest' && chat.project_id) {
      const access = await db.get_('SELECT 1 FROM project_access WHERE project_id = ? AND user_id = ?', [chat.project_id, uid]);
      if (access) broadcastToUser(uid, 'chat_created', { chat });
    }
  }
}

function broadcastToChat(chatId, eventType, data) {
  const clients = chatSSEClients.get(chatId);
  if (!clients || clients.size === 0) return;
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => {
    try { res.write(payload); } catch {}
  });
}

// Send a single SSE event to one specific response (for on-connect state sync)
function sendToClient(res, eventType, data) {
  try { res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
}

// Clean up stale typing users every 5s
setInterval(() => {
  const now = Date.now();
  typingUsers.forEach((users, chatId) => {
    users.forEach((lastSeen, userId) => {
      if (now - lastSeen > 4000) {
        users.delete(userId);
        broadcastToChat(chatId, 'typing', { users: Array.from(users.keys()) });
      }
    });
    if (users.size === 0) typingUsers.delete(chatId);
  });
}, 3000);

// Per-chat message queue — holds messages that arrive while the agent is busy
// chatQueues: Map<chatId, Array<{chat, message, attachments, aiMsgId}>>
const chatQueues = new Map();
// chatGatewayBusy: Set<chatId> — chats with an in-flight agent call
const chatGatewayBusy = new Set();
// chatQueueMeta: Map<chatId, Array<{id, senderName, preview, enqueuedAt}>> — for broadcasting to clients
const chatQueueMeta = new Map();

function broadcastQueueUpdate(chatId) {
  const meta = chatQueueMeta.get(chatId) || [];
  broadcastToChat(chatId, 'queue_update', { queue: meta });
}

function broadcastAgentStatus(chatId, busy, explicitAiMsgId) {
  const proc = activeAgentProcesses[chatId];
  // Use explicit id (for the pre-runAgent broadcast), then fall back to active process
  const thinkingMsgId = busy ? (explicitAiMsgId || (proc ? proc.aiMsgId : null)) : null;
  broadcastToChat(chatId, 'agent_status', { busy, thinkingMsgId });
}

function enqueueMessage(chat, message, attachments, aiMsgId, senderName) {
  if (!chatQueues.has(chat.id)) chatQueues.set(chat.id, []);
  chatQueues.get(chat.id).push({ chat, message, attachments, aiMsgId });
  // Track metadata for broadcasting
  if (!chatQueueMeta.has(chat.id)) chatQueueMeta.set(chat.id, []);
  const preview = (message || '').replace(/^\[From [^\]]+\]: /, '').slice(0, 80);
  chatQueueMeta.get(chat.id).push({ id: aiMsgId, senderName: senderName || 'User', preview, enqueuedAt: Date.now() });
  console.log(`[queue] Enqueued for chat ${chat.id}, depth=${chatQueues.get(chat.id).length}`);
  broadcastQueueUpdate(chat.id);
}

function drainQueue(chatId) {
  if (chatGatewayBusy.has(chatId)) return; // still busy — will drain when it finishes
  const queue = chatQueues.get(chatId);
  if (!queue || queue.length === 0) return;
  const next = queue.shift();
  if (queue.length === 0) chatQueues.delete(chatId);
  // Remove from meta
  const meta = chatQueueMeta.get(chatId) || [];
  const metaIdx = meta.findIndex(m => m.id === next.aiMsgId);
  if (metaIdx >= 0) meta.splice(metaIdx, 1);
  if (meta.length === 0) chatQueueMeta.delete(chatId); else chatQueueMeta.set(chatId, meta);
  console.log(`[queue] Draining for chat ${chatId}, remaining=${chatQueues.get(chatId)?.length ?? 0}`);
  chatGatewayBusy.add(chatId);
  broadcastAgentStatus(chatId, true, next.aiMsgId);
  broadcastQueueUpdate(chatId);
  runAgent(next.chat, next.message, next.attachments, next.aiMsgId).finally(() => {
    chatGatewayBusy.delete(chatId);
    broadcastAgentStatus(chatId, false);
    drainQueue(chatId);
  });
}
const db = require('./db');
const { createGatewayClient } = require('./gateway-client');
const sqlite3 = require('sqlite3');
// Open a fresh sessions.db connection per lookup to avoid lock conflicts with connect-sqlite3
function getSession(sid) {
  return new Promise((resolve) => {
    const sdb = new sqlite3.Database(path.join(__dirname, 'sessions.db'), (err) => {
      if (err) { resolve(null); return; }
      sdb.get('SELECT sess FROM sessions WHERE sid = ?', [sid], (err2, row) => {
        sdb.close();
        if (err2 || !row) { resolve(null); return; }
        try { resolve(JSON.parse(row.sess)); } catch { resolve(null); }
      });
    });
  });
}

const app = express();
const PORT = 8080;
const UPLOAD_DIR = '/tmp/openclaw-web-uploads';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- Middleware ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-store'); } }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: __dirname }),
  secret: process.env.SESSION_SECRET || 'openclaw-web-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // default 24h; login sets per-session maxAge
}));

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// --- Init password + seed admin user ---
setTimeout(async () => {
  const row = await db.get_('SELECT value FROM settings WHERE key = ?', ['password_hash']);
  if (!row) {
    const hash = bcrypt.hashSync('changeme123!', 10);
    await db.run_('INSERT INTO settings (key, value) VALUES (?, ?)', ['password_hash', hash]);
    console.log('Default password set: changeme123!');
  }

  // Seed admin user if users table is empty
  try {
    const userCount = await db.get_('SELECT COUNT(*) as cnt FROM users');
    if (!userCount || userCount.cnt === 0) {
      const hashRow = await db.get_('SELECT value FROM settings WHERE key = ?', ['password_hash']);
      if (hashRow) {
        const adminId = uuidv4();
        await db.run_(
          'INSERT INTO users (id, email, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [adminId, process.env.ADMIN_EMAIL || 'admin@example.com', process.env.ADMIN_DISPLAY_NAME || 'Admin', hashRow.value, 'admin', Date.now()]
        );
        console.log('Seeded admin user: ' + (process.env.ADMIN_EMAIL || 'admin@example.com') + '');
      }
    }
  } catch (e) {
    console.error('Error seeding admin user:', e.message);
  }

  // Always ensure ' + (process.env.ADMIN_EMAIL || 'admin@example.com') + ' exists as admin (cross-agent guarantee)
  try {
    const abdo = await db.get_('SELECT id, role FROM users WHERE email = ?', [process.env.ADMIN_EMAIL || 'admin@example.com']);
    if (!abdo) {
      // Not present — create with known password
      const abdoId = uuidv4();
      const abdoHash = await bcrypt.hash('changeme123!', 10);
      await db.run_(
        'INSERT INTO users (id, email, display_name, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [abdoId, process.env.ADMIN_EMAIL || 'admin@example.com', process.env.ADMIN_DISPLAY_NAME || 'Admin', abdoHash, 'admin', 1, Date.now()]
      );
      console.log('[boot] Created ' + (process.env.ADMIN_EMAIL || 'admin@example.com') + ' as admin');
    } else if (abdo.role !== 'admin') {
      // Exists but isn't admin — promote
      await db.run_('UPDATE users SET role = ?, active = 1 WHERE email = ?', ['admin', '' + (process.env.ADMIN_EMAIL || 'admin@example.com') + '']);
      console.log('[boot] Promoted ' + (process.env.ADMIN_EMAIL || 'admin@example.com') + ' to admin');
    } else {
      // Ensure active
      await db.run_('UPDATE users SET active = 1 WHERE email = ?', [process.env.ADMIN_EMAIL || 'admin@example.com']);
    }
  } catch (e) {
    console.error('[boot] Error ensuring abdo user:', e.message);
  }

  // Seed project_access: ensure admin user has access to all existing projects
  try {
    const adminUser = await db.get_("SELECT id FROM users WHERE email = (process.env.ADMIN_EMAIL || 'admin@example.com')");
    if (adminUser) {
      const allProjects = await db.all_('SELECT id FROM projects');
      for (const proj of allProjects) {
        await db.run_(
          'INSERT OR IGNORE INTO project_access (project_id, user_id, granted_by, granted_at) VALUES (?, ?, ?, ?)',
          [proj.id, adminUser.id, adminUser.id, Date.now()]
        );
      }
      if (allProjects.length) console.log(`Seeded project_access for admin across ${allProjects.length} project(s)`);
    }
  } catch (e) {
    console.error('Error seeding project_access:', e.message);
  }

  // Clean up stuck "...thinking..." messages older than 10 minutes
  // These happen when the server restarts mid-request or an agent call fails silently
  const staleThreshold = Date.now() - 10 * 60 * 1000;
  const staleCount = await db.run_(
    "UPDATE messages SET content = '[Response lost — please resend]' WHERE content = '...thinking...' AND created_at < ?",
    [staleThreshold]
  );
  if (staleCount && staleCount.changes > 0) {
    console.log(`Cleaned up ${staleCount.changes} stuck thinking message(s)`);
  }
}, 500);

// --- Rate limiters ---
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
  skip: (req) => {
    // Skip rate limiting for internal/localhost requests in dev
    const ip = req.ip || '';
    return ip === '::1' || ip === '127.0.0.1';
  }
});

// --- Audit log helper ---
async function writeAuditLog({ actorUserId, actorEmail, action, target, details }) {
  try {
    await db.run_(
      'INSERT INTO audit_log (timestamp, actor_user_id, actor_email, action, target, details) VALUES (?, ?, ?, ?, ?, ?)',
      [Date.now(), actorUserId || null, actorEmail || null, action, target || null, details ? JSON.stringify(details) : null]
    );
  } catch (e) {
    console.error('[audit] write error:', e.message);
  }
}

// --- Auth middleware ---
const requireAuth = (req, res, next) => {
  if (req.session.userId || req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

// Get effective role for current session (handles legacy sessions)
function getSessionRole(req) {
  if (req.session.userId) return req.session.role || 'guest';
  if (req.session.authenticated) return 'admin'; // legacy session = admin
  return null;
}

// requireRole: ensure user has at least one of the specified roles (requires requireAuth first)
const requireRole = (...roles) => (req, res, next) => {
  const role = getSessionRole(req);
  if (!role) return res.status(401).json({ error: 'Unauthorized' });
  if (roles.includes(role)) return next();
  return res.status(403).json({ error: 'Forbidden: insufficient role' });
};

// --- Auth routes ---
app.post('/api/login', async (req, res) => {
  try {
    const { password } = req.body;
    const row = await db.get_('SELECT value FROM settings WHERE key = ?', ['password_hash']);
    if (!row) return res.status(500).json({ error: 'No password configured' });
    if (bcrypt.compareSync(password, row.value)) {
      req.session.authenticated = true;
      res.json({ ok: true });
    } else {
      res.status(401).json({ error: 'Wrong password' });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Shared logout handler
const handleLogout = (req, res) => { req.session.destroy(); res.json({ ok: true }); };
app.post('/api/logout', handleLogout);
app.post('/api/auth/logout', handleLogout);

app.get('/api/me', async (req, res) => {
  try {
    if (req.session.userId) {
      const user = await db.get_('SELECT id, email, display_name, role FROM users WHERE id = ?', [req.session.userId]);
      if (user) return res.json({ authenticated: true, user });
    }
    if (req.session.authenticated) {
      return res.json({ authenticated: true, user: { id: 'legacy', email: '' + (process.env.ADMIN_EMAIL || 'admin@example.com') + '', display_name: 'Abdo', role: 'admin' } });
    }
    res.json({ authenticated: false, user: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// NEW: email+password login
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password, rememberMe } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await db.get_('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    // Reject deactivated users
    if (user.active === 0) {
      return res.status(403).json({ error: 'Account is deactivated. Contact your administrator.' });
    }
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.authenticated = true;
    // Remember me: 30 days vs 24 hours
    if (rememberMe) {
      req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
    } else {
      req.session.cookie.maxAge = 24 * 60 * 60 * 1000;
    }
    res.json({ ok: true, user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// NEW: forgot password
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  res.json({ ok: true }); // Always return ok (no enumeration)
  try {
    const { email } = req.body;
    if (!email) return;
    const user = await db.get_('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (!user) return;
    const crypto = require('crypto');
    const resetToken = crypto.randomBytes(32).toString('hex');
    await db.run_(
      'INSERT INTO password_reset_tokens (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)',
      [resetToken, user.id, Date.now() + 3600000]
    );
    // Send email via Gmail API
    try {
      const { google } = require('googleapis');
      const creds = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.openclaw', 'workspace', 'google-creds.json')));
      const tokenData = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.openclaw', 'workspace', 'google-token.json')));
      const installed = creds.installed || creds.web || creds;
      const oauth2 = new google.auth.OAuth2(
        installed.client_id, installed.client_secret,
        (installed.redirect_uris || ['urn:ietf:wg:oauth:2.0:oob'])[0]
      );
      oauth2.setCredentials(tokenData);
      const gmail = google.gmail({ version: 'v1', auth: oauth2 });
      const rawEmail = [
        'From: ' + (process.env.ADMIN_EMAIL || 'admin@example.com') + '',
        `To: ${user.email}`,
        'Content-Type: text/plain; charset=utf-8',
        `Subject: Reset your ${getInstanceConfig().name} password`,
        '',
        `Reset link:\n${getInstanceConfig().url}/reset-password?token=${resetToken}\n\nExpires in 1 hour.`
      ].join('\r\n');
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw: Buffer.from(rawEmail).toString('base64url') } });
      console.log(`[auth] Password reset email sent to ${user.email}`);
    } catch (mailErr) {
      console.error('[auth] Failed to send reset email:', mailErr.message);
    }
  } catch (e) {
    console.error('[auth] forgot-password error:', e.message);
  }
});

// NEW: reset password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const tokenRow = await db.get_('SELECT * FROM password_reset_tokens WHERE token = ?', [token]);
    if (!tokenRow) return res.status(400).json({ error: 'Invalid or expired token' });
    if (tokenRow.used) return res.status(400).json({ error: 'Token already used' });
    if (tokenRow.expires_at < Date.now()) return res.status(400).json({ error: 'Token expired' });
    const hash = await bcrypt.hash(password, 10);
    await db.run_('UPDATE users SET password_hash = ? WHERE id = ?', [hash, tokenRow.user_id]);
    await db.run_('UPDATE password_reset_tokens SET used = 1 WHERE token = ?', [token]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/app-config', (req, res) => {
  const envLines = (() => { try { return fs.readFileSync(path.join(process.env.HOME || '/home/clawdbot', '.openclaw', '.env'), 'utf8').split('\n'); } catch { return []; } })();
  const extraEnv = {};
  for (const line of envLines) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) extraEnv[m[1]] = m[2].trim(); }
  const instanceName = extraEnv.INSTANCE_NAME || process.env.INSTANCE_NAME || 'My Agent';
  res.json({ instanceName });
});

// --- Protected routes ---
app.use('/api/projects', requireAuth);
app.use('/api/chats', requireAuth);
app.use('/api/messages', requireAuth);
app.use('/api/shares', requireAuth);
app.use('/api/transcribe', requireAuth);
app.use('/api/download', requireAuth);
app.use('/api/settings', requireAuth);

// --- Projects ---
app.get('/api/projects', async (req, res) => {
  try {
    const role = getSessionRole(req);
    // Guests only see projects they have explicit access to
    if (role === 'guest' && req.session.userId) {
      const rows = await db.all_(
        'SELECT p.* FROM projects p JOIN project_access pa ON pa.project_id = p.id WHERE pa.user_id = ? ORDER BY p.created_at DESC',
        [req.session.userId]
      );
      return res.json(rows);
    }
    // Admin + Accord see all projects
    res.json(await db.all_('SELECT * FROM projects ORDER BY created_at DESC'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects', async (req, res) => {
  const { name, instructions } = req.body;
  const id = uuidv4(), now = Date.now();
  await db.run_('INSERT INTO projects (id, name, instructions, created_at) VALUES (?, ?, ?, ?)',
    [id, name || 'New Project', instructions || '', now]);
  res.json(await db.get_('SELECT * FROM projects WHERE id = ?', [id]));
});

app.put('/api/projects/:id', async (req, res) => {
  const { name, instructions } = req.body;
  await db.run_('UPDATE projects SET name = ?, instructions = ? WHERE id = ?', [name, instructions, req.params.id]);
  res.json(await db.get_('SELECT * FROM projects WHERE id = ?', [req.params.id]));
});

app.delete('/api/projects/:id', async (req, res) => {
  await db.run_('DELETE FROM projects WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// --- LLM helper ---
function getOpenAIClient() {
  const envLines = (() => {
    try { return fs.readFileSync(path.join(process.env.HOME || '/home/clawdbot', '.openclaw', '.env'), 'utf8').split('\n'); }
    catch { return []; }
  })();
  const extraEnv = {};
  for (const line of envLines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) extraEnv[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const apiKey = extraEnv.LITELLM_API_KEY || extraEnv.OPENAI_API_KEY || process.env.LITELLM_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = extraEnv.OPENAI_BASE_URL || extraEnv.LITELLM_BASE_URL || process.env.OPENAI_BASE_URL || process.env.LITELLM_BASE_URL || 'http://143.198.136.126:4000';
  if (!apiKey) return null;
  const OpenAI = require('openai');
  return new OpenAI({ apiKey, baseURL });
}

async function generateChatTitle(userMessage, aiReply) {
  const openai = getOpenAIClient();
  if (!openai) return null;
  try {
    const titleRes = await openai.chat.completions.create({
      model: 'anthropic/claude-sonnet-4-6',
      max_tokens: 20,
      messages: [
        { role: 'system', content: 'Generate a short title (5 words max) for this chat. Return ONLY the title, no quotes, no punctuation at the end, no explanation.' },
        { role: 'user', content: `User: ${(userMessage || '').slice(0, 200)}\nAI: ${(aiReply || '').slice(0, 200)}` },
      ],
    });
    return titleRes.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, '').replace(/[.!?]$/, '') || null;
  } catch (e) {
    console.error('generateChatTitle error:', e.message);
    return null;
  }
}

// --- Chats ---
app.get('/api/chats', async (req, res) => {
  try {
    const { project_id } = req.query;
    const role = getSessionRole(req);
    const userId = req.session.userId;

    if (role === 'guest' && userId) {
      // Guests: only chats in their accessible projects
      if (project_id) {
        // Verify guest has access to this project
        const access = await db.get_('SELECT 1 FROM project_access WHERE project_id = ? AND user_id = ?', [project_id, userId]);
        if (!access) return res.json([]);
        return res.json(await db.all_('SELECT * FROM chats WHERE project_id = ? ORDER BY updated_at DESC', [project_id]));
      } else {
        const rows = await db.all_(
          'SELECT c.* FROM chats c JOIN project_access pa ON pa.project_id = c.project_id WHERE pa.user_id = ? ORDER BY c.updated_at DESC',
          [userId]
        );
        return res.json(rows);
      }
    }

    // Admin + Accord see all
    if (project_id) {
      res.json(await db.all_('SELECT * FROM chats WHERE project_id = ? ORDER BY updated_at DESC', [project_id]));
    } else {
      res.json(await db.all_('SELECT * FROM chats ORDER BY updated_at DESC'));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chats', async (req, res) => {
  try {
    const { project_id, title, telegram_session_key } = req.body;
    const role = getSessionRole(req);
    const userId = req.session.userId;

    // Guests must specify a project_id they have access to
    if (role === 'guest' && userId) {
      if (!project_id) return res.status(403).json({ error: 'Guests must specify a project to create a chat' });
      const access = await db.get_('SELECT 1 FROM project_access WHERE project_id = ? AND user_id = ?', [project_id, userId]);
      if (!access) return res.status(403).json({ error: 'No access to this project' });
    }

    const id = uuidv4(), session_id = `web-${id}`, now = Date.now();
    await db.run_(
      'INSERT INTO chats (id, project_id, title, session_id, telegram_session_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, project_id || null, title || 'New Chat', session_id, telegram_session_key || null, now, now]
    );
    const created = await db.get_('SELECT * FROM chats WHERE id = ?', [id]);
  // Broadcast to all OTHER connected users — exclude creator to prevent duplicate sidebar entry
  broadcastChatCreated(created, userId || null).catch(() => {});
  res.json(created);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/chats/:id', async (req, res) => {
  const body = req.body;
  const current = await db.get_('SELECT * FROM chats WHERE id = ?', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Chat not found' });
  // Only overwrite project_id / telegram_session_key if explicitly provided in the body
  // (prevents rename-only calls from nullifying project membership)
  const title = body.title !== undefined ? body.title : current.title;
  const project_id = 'project_id' in body ? (body.project_id || null) : current.project_id;
  const telegram_session_key = 'telegram_session_key' in body ? (body.telegram_session_key || null) : current.telegram_session_key;
  await db.run_(
    'UPDATE chats SET title = ?, project_id = ?, telegram_session_key = ?, updated_at = ? WHERE id = ?',
    [title, project_id, telegram_session_key, Date.now(), req.params.id]
  );
  res.json(await db.get_('SELECT * FROM chats WHERE id = ?', [req.params.id]));
});

// Touch a chat's updated_at (bumps sort order when user opens it)
app.post('/api/chats/:id/touch', requireAuth, async (req, res) => {
  await db.run_('UPDATE chats SET updated_at = ? WHERE id = ?', [Date.now(), req.params.id]);
  res.json({ ok: true });
});

// --- Chat full-text search ---
app.get('/api/chats/search', requireAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json([]);
    const like = `%${q}%`;
    // Get distinct chats with matching message content, plus best snippet
    const rows = await db.all_(
      `SELECT c.*, m.content AS snippet FROM chats c
       JOIN (
         SELECT chat_id, content,
           ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY
             CASE WHEN instr(lower(content), lower(?)) > 0 THEN 0 ELSE 1 END,
             created_at ASC) AS rn
         FROM messages
         WHERE lower(content) LIKE lower(?) AND content != '...thinking...' AND length(content) > 5
       ) m ON m.chat_id = c.id AND m.rn = 1
       ORDER BY c.updated_at DESC
       LIMIT 100`,
      [q, like]
    );
    // Build context snippet around the match
    const results = rows.map(row => {
      const raw = row.snippet || '';
      const idx = raw.toLowerCase().indexOf(q.toLowerCase());
      let snippet;
      if (idx >= 0) {
        const start = Math.max(0, idx - 40);
        const end = Math.min(raw.length, idx + q.length + 80);
        snippet = (start > 0 ? '…' : '') + raw.slice(start, end) + (end < raw.length ? '…' : '');
      } else {
        snippet = raw.slice(0, 120);
      }
      const { snippet: _, ...chat } = row;
      return { ...chat, snippet };
    });
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Update check ---
app.get('/api/update/check', requireAuth, requireRole('admin', 'accord'), async (req, res) => {
  try {
    const GH_TOKEN = process.env.GH_UPDATE_TOKEN || '';
    const API_URL = 'https://api.github.com/repos/abdelrahmanw/openclaw-web/contents/version.json';
    const remoteRaw = await new Promise((resolve, reject) => {
      https.get(API_URL, {
        headers: {
          'Authorization': `token ${GH_TOKEN}`,
          'Accept': 'application/vnd.github.v3.raw',
          'User-Agent': 'antar-web-updater'
        }
      }, (r) => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => resolve(data));
        r.on('error', reject);
      }).on('error', reject);
    });
    const remote = JSON.parse(remoteRaw);
    // Always read version.json fresh so current is never stale after a deploy
    let liveLocal = localVersion;
    try { liveLocal = JSON.parse(fs.readFileSync(LOCAL_VERSION_PATH, 'utf8')); localVersion = liveLocal; } catch(_) {}
    res.json({
      current: liveLocal.version,
      currentLabel: liveLocal.label,
      latest: remote.version,
      latestLabel: remote.label,
      latestCommit: remote.commit,
      pushedAt: remote.pushed_at,
      hasUpdate: remote.version !== liveLocal.version
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to check for updates: ' + e.message });
  }
});

// --- Rename all chats ---
app.post('/api/admin/rename-all', requireAuth, async (req, res) => {
  try {
    const chats = await db.all_('SELECT * FROM chats ORDER BY created_at ASC');
    const results = await Promise.allSettled(chats.map(async (chat) => {
      const messages = await db.all_(
        "SELECT role, content FROM messages WHERE chat_id = ? AND content != '...thinking...' AND length(content) > 10 ORDER BY created_at ASC LIMIT 4",
        [chat.id]
      );
      const firstUser = messages.find(m => m.role === 'user');
      const firstAssistant = messages.find(m => m.role === 'assistant');
      if (!firstUser) return { id: chat.id, skipped: true };
      let title = await generateChatTitle(firstUser.content, firstAssistant?.content || '');
      if (!title) title = firstUser.content.trim().split(/\s+/).slice(0, 5).join(' ');
      await db.run_('UPDATE chats SET title = ? WHERE id = ?', [title, chat.id]);
      return { id: chat.id, title };
    }));
    const renamed = results.filter(r => r.status === 'fulfilled' && !r.value?.skipped).length;
    res.json({ ok: true, renamed, total: chats.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/chats/:id', async (req, res) => {
  await db.run_('DELETE FROM chats WHERE id = ?', [req.params.id]);
  await db.run_('DELETE FROM messages WHERE chat_id = ?', [req.params.id]);
  res.json({ ok: true });
});

// --- Messages ---
app.get('/api/chats/:id/messages', async (req, res) => {
  const msgs = await db.all_('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC', [req.params.id]);
  res.json(msgs.map(m => ({ ...m, attachments: JSON.parse(m.attachments || '[]') })));
});

// --- Send message ---
app.post('/api/chats/:id/send', upload.array('files'), async (req, res) => {
  try {
    const chat = await db.get_('SELECT * FROM chats WHERE id = ?', [req.params.id]);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    const { message, voiceAudioPath, voiceAudioFilename, voiceAudioSize } = req.body;
    const files = req.files || [];
    const now = Date.now();
    const attachments = files.map(f => ({ name: f.originalname, path: f.path, size: f.size, mimetype: f.mimetype }));
    // Voice message: audio was already saved by /api/transcribe; just reference it
    if (voiceAudioPath && fs.existsSync(voiceAudioPath)) {
      attachments.unshift({
        name: voiceAudioFilename || 'voice-message.webm',
        path: voiceAudioPath,
        size: parseInt(voiceAudioSize || 0, 10),
        mimetype: 'audio/webm',
        isVoice: true,
      });
    }

    // Get display name for the user
    let senderName = null;
    let senderId = req.session.userId || null;
    if (senderId) {
      const senderUser = await db.get_('SELECT display_name FROM users WHERE id = ?', [senderId]);
      if (senderUser) senderName = senderUser.display_name;
    }

    // Save user message
    const userMsgId = uuidv4();
    await db.run_(
      'INSERT INTO messages (id, chat_id, role, content, attachments, created_at, user_id, display_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userMsgId, chat.id, 'user', message || '', JSON.stringify(attachments), now, senderId, senderName]
    );

    // Update chat
    await db.run_('UPDATE chats SET updated_at = ? WHERE id = ?', [now, chat.id]);

    // Create thinking placeholder
    const aiMsgId = uuidv4();
    await db.run_(
      'INSERT INTO messages (id, chat_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [aiMsgId, chat.id, 'assistant', '...thinking...', '[]', now + 1]
    );

    // Broadcast user message via SSE
    const userMsg = await db.get_('SELECT * FROM messages WHERE id = ?', [userMsgId]);
    broadcastToChat(chat.id, 'message', { ...userMsg, attachments: JSON.parse(userMsg.attachments || '[]') });
    // Broadcast agent-thinking indicator (clear user typing, don't re-broadcast stale user IDs)
    broadcastToChat(chat.id, 'typing', { users: [], names: [] });

    res.json({ userMsgId, aiMsgId, status: 'processing' });

    // Prefix message with sender name for collaborative chats
    let agentMessage = message || '';
    const participants = await db.all_('SELECT COUNT(*) as cnt FROM chat_participants WHERE chat_id = ?', [chat.id]);
    const isCollaborative = participants[0]?.cnt > 1;
    if (senderName && isCollaborative) {
      agentMessage = `[From ${senderName}]: ${agentMessage}`;
    }

    // Run agent async — queue if a response is already in flight for this chat
    if (chatGatewayBusy.has(chat.id)) {
      enqueueMessage(chat, agentMessage, attachments, aiMsgId, senderName);
    } else {
      chatGatewayBusy.add(chat.id);
      broadcastAgentStatus(chat.id, true, aiMsgId);
      runAgent(chat, agentMessage, attachments, aiMsgId);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Voice init: create user + AI placeholder rows WITHOUT running agent yet ---
app.post('/api/chats/:id/send-voice-init', requireAuth, async (req, res) => {
  try {
    const chat = await db.get_('SELECT * FROM chats WHERE id = ?', [req.params.id]);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const now = Date.now();
    const userMsgId = uuidv4();
    const aiMsgId = uuidv4();
    await db.run_(
      'INSERT INTO messages (id, chat_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [userMsgId, chat.id, 'user', '\ud83c\udfa4 Transcribing...', '[]', now]
    );
    await db.run_(
      'INSERT INTO messages (id, chat_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [aiMsgId, chat.id, 'assistant', '...thinking...', '[]', now + 1]
    );
    await db.run_('UPDATE chats SET updated_at = ? WHERE id = ?', [now, chat.id]);
    res.json({ userMsgId, aiMsgId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Voice reply: transcript already exists, AI placeholder already created, just run agent ---
app.post('/api/chats/:id/send-voice-reply', requireAuth, async (req, res) => {
  try {
    const chat = await db.get_('SELECT * FROM chats WHERE id = ?', [req.params.id]);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const { transcript, aiMsgId, audioPath, audioFilename } = req.body;
    if (!transcript || !aiMsgId) return res.status(400).json({ error: 'Missing transcript or aiMsgId' });

    const attachments = [];
    if (audioPath && fs.existsSync(audioPath)) {
      attachments.push({ name: audioFilename || 'voice-message.webm', path: audioPath, mimetype: 'audio/webm', isVoice: true });
    }

    res.json({ ok: true });

    if (chatGatewayBusy.has(chat.id)) {
      enqueueMessage(chat, transcript, attachments, aiMsgId, null);
    } else {
      chatGatewayBusy.add(chat.id);
      broadcastAgentStatus(chat.id, true);
      runAgent(chat, transcript, attachments, aiMsgId).finally(() => {
        chatGatewayBusy.delete(chat.id);
        broadcastAgentStatus(chat.id, false);
        drainQueue(chat.id);
      });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const OPENCLAW_BIN = '/usr/bin/openclaw';

async function runAgent(chat, userMessage, attachments, aiMsgId) {
  try {
    let fullMessage = userMessage || '';

    // Prepend attachments
    for (const att of attachments) {
      fullMessage = `[Attachment: ${att.path}]\n` + fullMessage;
    }

    // Prepend project instructions and files
    if (chat.project_id) {
      const project = await db.get_('SELECT * FROM projects WHERE id = ?', [chat.project_id]);
      if (project && project.guardrails && project.guardrails.trim()) {
        fullMessage = `[Project guardrails: ${project.guardrails}]\n\n` + fullMessage;
      }
      if (project && project.instructions) {
        fullMessage = `[Project context: ${project.instructions}]\n\n` + fullMessage;
      }
      if (project) {
        // Prepend project links (Google Docs/Sheets/Slides/Drive folders)
        const projectLinks = await db.all_('SELECT * FROM project_links WHERE project_id = ? ORDER BY created_at ASC', [project.id]);
        if (projectLinks.length > 0) {
          const linksText = projectLinks.map(l => `- ${l.title} (${l.link_type}): ${l.url}`).join('\n');
          fullMessage = `[Project linked resources:\n${linksText}]\n\n` + fullMessage;
        }

        const projectFiles = await db.all_('SELECT * FROM project_files WHERE project_id = ?', [project.id]);
        for (const pf of projectFiles) {
          try {
            if (pf.mimetype && (pf.mimetype.startsWith('text/') || pf.mimetype === 'application/json' || pf.mimetype.includes('javascript'))) {
              const content = fs.readFileSync(pf.path, 'utf8');
              fullMessage = `[Project file: ${pf.name}]\n${content.slice(0, 8000)}\n\n` + fullMessage;
            } else {
              fullMessage = `[Project file: ${pf.name} (${pf.mimetype || 'binary'}) - attached]\n[Attachment: ${pf.path}]\n` + fullMessage;
            }
          } catch {}
        }
      }
    }

    // Derive session key: use chat's telegram_session_key if set, otherwise use chat id
    const sessionKey = chat.telegram_session_key || `web-${chat.id}`;

    // Run the real OpenClaw agent via CLI — same session store as Telegram
    const reply = await new Promise((resolve, reject) => {
      const args = [
        'agent',
        '--session-id', sessionKey,
        '--message', fullMessage,
        '--json'
      ];

      // Load env from ~/.openclaw/.env
      const envLines = (() => {
        try { return fs.readFileSync(path.join(process.env.HOME || '/home/clawdbot', '.openclaw', '.env'), 'utf8').split('\n'); }
        catch { return []; }
      })();
      const extraEnv = {};
      for (const line of envLines) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) extraEnv[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }

      const child = execFile(OPENCLAW_BIN, args, {
        timeout: 300000, // 5 min
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...extraEnv }
      }, (err, stdout, stderr) => {
        delete activeAgentProcesses[chat.id]; // clean up when done
        if (err && !stdout) return reject(new Error(err.message + (stderr ? '\n' + stderr.slice(0, 500) : '')));
        // Parse JSON output
        try {
          // stdout may have config warnings before JSON
          const jsonStart = stdout.indexOf('{');
          if (jsonStart < 0) return reject(new Error('No JSON in agent output: ' + stdout.slice(0, 300)));
          const result = JSON.parse(stdout.slice(jsonStart));
          if (result.status !== 'ok') return reject(new Error('Agent status: ' + result.status));
          const texts = (result.result?.payloads || []).map(p => p.text).filter(Boolean);
          resolve(texts.join('\n\n') || 'Done.');
        } catch (parseErr) {
          // Fallback: return raw stdout stripped of config warnings
          const clean = stdout.replace(/^Config warnings:[\s\S]*?\n\n/m, '').trim();
          resolve(clean || 'Done.');
        }
      });
      activeAgentProcesses[chat.id] = { child, aiMsgId };
    });

    await db.run_('UPDATE messages SET content = ? WHERE id = ?', [reply, aiMsgId]);
    await db.run_('UPDATE chats SET updated_at = ? WHERE id = ?', [Date.now(), chat.id]);

    // Broadcast new message via SSE
    const aiMsg = await db.get_('SELECT * FROM messages WHERE id = ?', [aiMsgId]);
    broadcastToChat(chat.id, 'message', { ...aiMsg, attachments: JSON.parse(aiMsg.attachments || '[]') });
    // Clear agent-thinking indicator
    broadcastToChat(chat.id, 'typing', { users: [], names: [] });

    // Inject completion into the OpenClaw session so webchat surfaces it even on background turns.
    // Fire-and-forget — never block the main response path on this.
    (() => {
      const sessionKey = chat.telegram_session_key || `web-${chat.id}`;
      // Only inject for web sessions (Telegram has its own delivery path)
      if (!sessionKey.startsWith('web-')) return;
      const gw = createGatewayClient();
      gw.ready
        .then(() => gw.request('chat.inject', { sessionKey, message: reply }))
        .catch(() => {}) // best-effort; never throw
        .finally(() => { try { gw.close(); } catch {} });
    })();

    // Auto-title: generate after first AI reply if still 'New Chat'
    try {
      const freshChat = await db.get_('SELECT title FROM chats WHERE id = ?', [chat.id]);
      if (freshChat && freshChat.title === 'New Chat' && userMessage) {
        let title = await generateChatTitle(userMessage, reply);
        if (!title) title = userMessage.trim().split(/\s+/).slice(0, 5).join(' ');
        if (title) await db.run_('UPDATE chats SET title = ? WHERE id = ?', [title, chat.id]);
      }
    } catch (titleErr) {
      console.error('Auto-title error:', titleErr.message);
    }
  } catch (e) {
    console.error('runAgent error:', e);
    await db.run_('UPDATE messages SET content = ? WHERE id = ?', [`Error: ${e.message}`, aiMsgId]);
    // Broadcast error message via SSE so other users see it
    try {
      const errMsg = await db.get_('SELECT * FROM messages WHERE id = ?', [aiMsgId]);
      if (errMsg) broadcastToChat(chat.id, 'message', { ...errMsg, attachments: [] });
    } catch {}
  } finally {
    // Always release busy lock and drain queue, no matter what
    chatGatewayBusy.delete(chat.id);
    broadcastAgentStatus(chat.id, false);
    drainQueue(chat.id);
  }
}

// --- Project settings (admin/accord only) ---
app.get('/api/projects/:id/settings', requireAuth, requireRole('admin', 'accord'), async (req, res) => {
  try {
    const project = await db.get_('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const members = await db.all_(
      'SELECT u.id, u.email, u.display_name, u.role, pa.granted_at FROM users u JOIN project_access pa ON pa.user_id = u.id WHERE pa.project_id = ?',
      [req.params.id]
    );
    res.json({ project, members });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/projects/:id/guardrails', requireAuth, requireRole('admin', 'accord'), async (req, res) => {
  try {
    const { guardrails } = req.body;
    await db.run_('UPDATE projects SET guardrails = ? WHERE id = ?', [guardrails || '', req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Admin panel routes ---

// List all users
app.get('/api/admin/users', requireAuth, requireRole('admin', 'accord'), async (req, res) => {
  try {
    const users = await db.all_('SELECT id, email, display_name, role, active, created_at FROM users ORDER BY created_at ASC');
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Invite new user
app.post('/api/admin/users/invite', requireAuth, requireRole('admin', 'accord'), async (req, res) => {
  try {
    const { email, role, display_name } = req.body;
    if (!email || !role) return res.status(400).json({ error: 'Email and role required' });
    // Only admins can create admin users
    if (role === 'admin' && getSessionRole(req) !== 'admin') {
      return res.status(403).json({ error: 'Only admins can create admin users' });
    }
    const existing = await db.get_('SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (existing) return res.status(409).json({ error: 'User with this email already exists' });

    const crypto = require('crypto');
    const tempPassword = crypto.randomBytes(8).toString('hex');
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const id = uuidv4();
    const inviterId = req.session.userId || 'legacy';
    await db.run_(
      'INSERT INTO users (id, email, display_name, password_hash, role, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, email.toLowerCase().trim(), display_name || email.split('@')[0], passwordHash, role, Date.now(), inviterId]
    );

    // Send invite email via configured email provider/relay
    try {
      const { sendEmail } = require('./email');
      const { name: _instanceName, url: _instanceUrl } = getInstanceConfig();
      const cleanEmail = email.toLowerCase().trim();
      await sendEmail({
        to: cleanEmail,
        subject: `You've been invited to ${_instanceName}`,
        body: [
          `You've been invited to ${_instanceName}.`,
          '',
          `URL: ${_instanceUrl}`,
          `Email: ${cleanEmail}`,
          `Temporary password: ${tempPassword}`,
          '',
          'Please log in and change your password in Settings.'
        ].join('\n'),
        bodyHtml: `
          <div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111827">
            <p>You've been invited to <strong>${_instanceName}</strong>.</p>
            <p><strong>URL:</strong> <a href="${_instanceUrl}">${_instanceUrl}</a><br>
            <strong>Email:</strong> ${cleanEmail}<br>
            <strong>Temporary password:</strong> <code style="font-size:16px">${tempPassword}</code></p>
            <p>Please log in and change your password in Settings.</p>
          </div>`
      });
      console.log(`[admin] Invite email sent to ${cleanEmail}`);
    } catch (mailErr) {
      console.error('[admin] Failed to send invite email:', mailErr.message);
    }

    // Audit: user invite
    const actorUser = req.session.userId ? await db.get_('SELECT email FROM users WHERE id = ?', [req.session.userId]) : null;
    await writeAuditLog({ actorUserId: req.session.userId || 'legacy', actorEmail: actorUser?.email || 'legacy', action: 'user_invite', target: email, details: { role } });

    res.json({ ok: true, id, tempPassword });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update user (display_name, role, active)
app.put('/api/admin/users/:id', requireAuth, requireRole('admin', 'accord'), async (req, res) => {
  try {
    const { display_name, role, active } = req.body;
    const user = await db.get_('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const newDisplayName = display_name !== undefined ? display_name : user.display_name;
    const newRole = role !== undefined ? role : user.role;
    const newActive = active !== undefined ? (active ? 1 : 0) : user.active;
    await db.run_('UPDATE users SET display_name = ?, role = ?, active = ? WHERE id = ?',
      [newDisplayName, newRole, newActive, req.params.id]);

    // Audit logging
    const actorUser = req.session.userId ? await db.get_('SELECT email FROM users WHERE id = ?', [req.session.userId]) : null;
    const actorId = req.session.userId || 'legacy';
    const actorEmail = actorUser?.email || 'legacy';
    if (role !== undefined && role !== user.role) {
      await writeAuditLog({ actorUserId: actorId, actorEmail, action: 'role_change', target: user.email, details: { from: user.role, to: newRole } });
    }
    if (active !== undefined && (active ? 1 : 0) !== user.active) {
      const action = newActive ? 'user_reactivated' : 'user_deactivated';
      await writeAuditLog({ actorUserId: actorId, actorEmail, action, target: user.email });
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete user (admin only — hard delete with cascade)
app.delete('/api/admin/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const targetId = req.params.id;
    const actorId = req.session.userId || 'legacy';

    // Prevent self-delete
    if (actorId !== 'legacy' && actorId === targetId) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }

    const target = await db.get_('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!target) return res.status(404).json({ error: 'User not found' });

    // Prevent deleting the last admin
    if (target.role === 'admin') {
      const adminCount = await db.get_('SELECT COUNT(*) as cnt FROM users WHERE role = ?', ['admin']);
      if (adminCount && adminCount.cnt <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last admin account.' });
      }
    }

    // Cascade: delete related data
    await db.run_('DELETE FROM project_access WHERE user_id = ?', [targetId]);
    await db.run_('DELETE FROM guest_permissions WHERE user_id = ?', [targetId]);
    await db.run_('DELETE FROM chat_participants WHERE user_id = ?', [targetId]);
    await db.run_('DELETE FROM permission_approvals WHERE guest_user_id = ?', [targetId]);
    await db.run_('DELETE FROM password_reset_tokens WHERE user_id = ?', [targetId]);
    await db.run_('DELETE FROM users WHERE id = ?', [targetId]);

    // Audit log
    const actorUser = req.session.userId ? await db.get_('SELECT email FROM users WHERE id = ?', [actorId]) : null;
    const actorEmail = actorUser?.email || 'legacy';
    await writeAuditLog({ actorUserId: actorId, actorEmail, action: 'user_deleted', target: target.email, details: { role: target.role } });

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get guest permissions
app.get('/api/admin/guest-permissions/:userId', requireAuth, requireRole('admin', 'accord'), async (req, res) => {
  try {
    const perms = await db.all_('SELECT * FROM guest_permissions WHERE user_id = ?', [req.params.userId]);
    res.json(perms);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Set guest permissions
app.put('/api/admin/guest-permissions/:userId', requireAuth, requireRole('admin', 'accord'), async (req, res) => {
  try {
    const { permissions } = req.body; // Array of { permission, requires_approval }
    const userId = req.params.userId;
    const granterId = req.session.userId || 'legacy';
    // Get old permissions for audit diff
    const oldPerms = await db.all_('SELECT permission FROM guest_permissions WHERE user_id = ?', [userId]);
    const oldSet = new Set(oldPerms.map(p => p.permission));
    const newSet = new Set((permissions || []).map(p => p.permission));
    // Clear existing permissions for this user
    await db.run_('DELETE FROM guest_permissions WHERE user_id = ?', [userId]);
    // Insert new ones
    for (const p of (permissions || [])) {
      await db.run_(
        'INSERT INTO guest_permissions (user_id, permission, granted_by, granted_at, requires_approval) VALUES (?, ?, ?, ?, ?)',
        [userId, p.permission, granterId, Date.now(), p.requires_approval || null]
      );
    }
    // Audit: log grants and revocations
    const targetUser = await db.get_('SELECT email FROM users WHERE id = ?', [userId]);
    const actorUser = granterId !== 'legacy' ? await db.get_('SELECT email FROM users WHERE id = ?', [granterId]) : null;
    const actorEmail = actorUser?.email || 'legacy';
    for (const perm of newSet) {
      if (!oldSet.has(perm)) {
        await writeAuditLog({ actorUserId: granterId, actorEmail, action: 'permission_grant', target: targetUser?.email || userId, details: { permission: perm } });
      }
    }
    for (const perm of oldSet) {
      if (!newSet.has(perm)) {
        await writeAuditLog({ actorUserId: granterId, actorEmail, action: 'permission_revoke', target: targetUser?.email || userId, details: { permission: perm } });
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List all project access
app.get('/api/admin/project-access', requireAuth, requireRole('admin', 'accord'), async (req, res) => {
  try {
    const rows = await db.all_(
      `SELECT pa.project_id, pa.user_id, pa.granted_at,
              p.name AS project_name, u.email, u.display_name, u.role
       FROM project_access pa
       JOIN projects p ON p.id = pa.project_id
       JOIN users u ON u.id = pa.user_id
       ORDER BY p.name, u.email`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Grant project access
app.post('/api/admin/project-access', requireAuth, requireRole('admin', 'accord'), async (req, res) => {
  try {
    const { project_id, user_id } = req.body;
    if (!project_id || !user_id) return res.status(400).json({ error: 'project_id and user_id required' });
    const granterId = req.session.userId || 'legacy';
    await db.run_(
      'INSERT OR IGNORE INTO project_access (project_id, user_id, granted_by, granted_at) VALUES (?, ?, ?, ?)',
      [project_id, user_id, granterId, Date.now()]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Revoke project access
app.delete('/api/admin/project-access/:projectId/:userId', requireAuth, requireRole('admin', 'accord'), async (req, res) => {
  try {
    await db.run_('DELETE FROM project_access WHERE project_id = ? AND user_id = ?',
      [req.params.projectId, req.params.userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Audit log (admin + accord)
app.get('/api/admin/audit-log', requireAuth, requireRole('admin', 'accord'), async (req, res) => {
  try {
    const rows = await db.all_('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 200');
    res.json(rows.map(r => ({ ...r, details: r.details ? JSON.parse(r.details) : null })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PM2 status (admin only)
app.get('/api/admin/pm2-status', requireAuth, requireRole('admin'), async (req, res) => {
  exec('pm2 list --json', (err, stdout) => {
    try {
      const data = JSON.parse(stdout || '[]');
      res.json({ ok: true, processes: data });
    } catch {
      res.json({ ok: false, raw: stdout, error: err?.message });
    }
  });
});

// PM2 restart (admin only)
app.post('/api/admin/pm2-restart', requireAuth, requireRole('admin'), async (req, res) => {
  const pm2Name = process.env.PM2_APP_NAME || 'antar-web';
  exec(`pm2 restart ${pm2Name}`, (err, stdout, stderr) => {
    res.json({ ok: !err, stdout, stderr, error: err?.message });
  });
});

// Server log (admin only)
// Version info
app.get('/api/admin/version', requireAuth, requireRole('admin'), async (req, res) => {
  exec(`cd ${__dirname} && git log -1 --format="%h|%s|%ci" 2>&1`, (err, stdout) => {
    if (err || !stdout.trim()) return res.json({ ok: false, version: 'unknown' });
    const [hash, subject, date] = stdout.trim().split('|');
    // Also read version.json for the friendly version label
    let versionLabel = null;
    try {
      const vj = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'version.json'), 'utf8'));
      versionLabel = vj.version || null;
    } catch (_) {}
    res.json({ ok: true, hash: hash?.trim(), subject: subject?.trim(), date: date?.trim(), versionLabel });
  });
});

// Deploy (admin only)
app.post('/api/admin/deploy', requireAuth, requireRole('admin'), async (req, res) => {
  const pm2AppName = process.env.PM2_APP_NAME || 'antar-web';
  // Run git pull first, send response, THEN restart (so response isn't killed mid-flight)
  exec(`cd ${__dirname} && git fetch origin main && git reset --hard origin/main`, { timeout: 60000 }, (err, stdout, stderr) => {
    const pullOutput = (stdout || '') + (stderr || '');
    if (err) {
      return res.json({ ok: false, stdout, stderr, error: err?.message });
    }
    // Send success response before restarting
    res.json({ ok: true, stdout: pullOutput, stderr: '', error: null });
    // Restart after a short delay so the response has time to flush
    setTimeout(() => {
      exec(`pm2 restart ${pm2AppName}`, () => {});
    }, 500);
  });
});

// Publish routes removed in public build

// --- Invite guest directly to a project (creates user + grants access + emails) ---
app.post('/api/projects/:id/invite-guest', requireAuth, requireRole('admin', 'accord'), async (req, res) => {
  try {
    const { email, role, display_name } = req.body;
    if (!email || !role) return res.status(400).json({ error: 'Email and role required' });
    const projectId = req.params.id;
    const project = await db.get_('SELECT id, name FROM projects WHERE id = ?', [projectId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const crypto = require('crypto');
    const inviterId = req.session.userId || 'legacy';
    const cleanEmail = email.toLowerCase().trim();

    let userId;
    let isNew = false;
    const existing = await db.get_('SELECT id, active FROM users WHERE email = ?', [cleanEmail]);
    if (existing) {
      // User already exists — just grant project access
      userId = existing.id;
      if (existing.active === 0) {
        // Reactivate if deactivated
        await db.run_('UPDATE users SET active = 1 WHERE id = ?', [userId]);
      }
    } else {
      // Create new user
      const tempPassword = crypto.randomBytes(8).toString('hex');
      const passwordHash = await bcrypt.hash(tempPassword, 10);
      userId = uuidv4();
      await db.run_(
        'INSERT INTO users (id, email, display_name, password_hash, role, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, cleanEmail, display_name || cleanEmail.split('@')[0], passwordHash, role || 'guest', Date.now(), inviterId]
      );
      isNew = true;

      // Send invite email via configured email provider/relay
      try {
        const { sendEmail } = require('./email');
        const { name: _instanceName, url: _instanceUrl } = getInstanceConfig();
        await sendEmail({
          to: cleanEmail,
          subject: `You've been invited to the "${project.name}" project on ${_instanceName}`,
          body: [
            `You've been invited to collaborate on the "${project.name}" project on ${_instanceName}.`,
            '',
            `URL: ${_instanceUrl}`,
            `Email: ${cleanEmail}`,
            `Temporary password: ${tempPassword}`,
            '',
            'Please log in and change your password in Settings.'
          ].join('\n'),
          bodyHtml: `
            <div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111827">
              <p>You've been invited to collaborate on the <strong>${project.name}</strong> project on <strong>${_instanceName}</strong>.</p>
              <p><strong>URL:</strong> <a href="${_instanceUrl}">${_instanceUrl}</a><br>
              <strong>Email:</strong> ${cleanEmail}<br>
              <strong>Temporary password:</strong> <code style="font-size:16px">${tempPassword}</code></p>
              <p>Please log in and change your password in Settings.</p>
            </div>`
        });
        console.log(`[project-invite] Invite email sent to ${cleanEmail}`);
      } catch (mailErr) {
        console.error('[project-invite] Failed to send invite email:', mailErr.message);
      }

      await writeAuditLog({ actorUserId: inviterId, actorEmail: (await db.get_('SELECT email FROM users WHERE id = ?', [inviterId]))?.email || 'legacy', action: 'user_invite', target: cleanEmail, details: { role, via: 'project_invite', project: project.name } });
    }

    // Grant project access
    await db.run_(
      'INSERT OR IGNORE INTO project_access (project_id, user_id, granted_by, granted_at) VALUES (?, ?, ?, ?)',
      [projectId, userId, inviterId, Date.now()]
    );

    const user = await db.get_('SELECT id, email, display_name, role FROM users WHERE id = ?', [userId]);
    res.json({ ok: true, isNew, user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List project members (admin/accord only)
app.get('/api/projects/:id/members', requireAuth, requireRole('admin', 'accord'), async (req, res) => {
  try {
    const members = await db.all_(
      'SELECT u.id, u.email, u.display_name, u.role, pa.granted_at FROM users u JOIN project_access pa ON pa.user_id = u.id WHERE pa.project_id = ?',
      [req.params.id]
    );
    res.json(members);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Project files ---
app.get('/api/projects/:id/files', async (req, res) => {
  try {
    const files = await db.all_('SELECT * FROM project_files WHERE project_id = ? ORDER BY created_at ASC', [req.params.id]);
    res.json(files);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects/:id/files', upload.array('files'), async (req, res) => {
  try {
    const project = await db.get_('SELECT id FROM projects WHERE id = ?', [req.params.id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const saved = [];
    for (const f of (req.files || [])) {
      const id = uuidv4();
      await db.run_(
        'INSERT INTO project_files (id, project_id, name, path, size, mimetype, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, req.params.id, f.originalname, f.path, f.size, f.mimetype, Date.now()]
      );
      saved.push({ id, name: f.originalname, size: f.size, mimetype: f.mimetype });
    }
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:id/files/:fileId', async (req, res) => {
  try {
    const file = await db.get_('SELECT * FROM project_files WHERE id = ? AND project_id = ?', [req.params.fileId, req.params.id]);
    if (!file) return res.status(404).json({ error: 'File not found' });
    try { fs.unlinkSync(file.path); } catch {}
    await db.run_('DELETE FROM project_files WHERE id = ?', [file.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Project Links ---
app.get('/api/projects/:id/links', requireAuth, async (req, res) => {
  try {
    const links = await db.all_('SELECT * FROM project_links WHERE project_id = ? ORDER BY created_at ASC', [req.params.id]);
    res.json(links);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects/:id/links', requireAuth, async (req, res) => {
  try {
    const project = await db.get_('SELECT id FROM projects WHERE id = ?', [req.params.id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { url, title, link_type } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const id = require('crypto').randomUUID();
    await db.run_('INSERT INTO project_links (id, project_id, url, title, link_type, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, req.params.id, url, title || url, link_type || 'doc', Date.now()]);
    res.json(await db.get_('SELECT * FROM project_links WHERE id = ?', [id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:id/links/:linkId', requireAuth, async (req, res) => {
  try {
    const link = await db.get_('SELECT * FROM project_links WHERE id = ? AND project_id = ?', [req.params.linkId, req.params.id]);
    if (!link) return res.status(404).json({ error: 'Link not found' });
    await db.run_('DELETE FROM project_links WHERE id = ?', [link.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Chat agent status (for initial sync on page load) ---
app.get('/api/chats/:id/agent-status', requireAuth, async (req, res) => {
  const chatId = req.params.id;
  const busy = chatGatewayBusy.has(chatId);
  const queue = chatQueueMeta.get(chatId) || [];
  // Also find the in-flight aiMsgId (the ...thinking... message)
  let thinkingMsgId = null;
  if (busy) {
    const proc = activeAgentProcesses[chatId];
    if (proc) thinkingMsgId = proc.aiMsgId;
  }
  res.json({ busy, queue, thinkingMsgId });
});

// --- Get single message (for polling) ---
app.get('/api/messages/:id', async (req, res) => {
  const msg = await db.get_('SELECT * FROM messages WHERE id = ?', [req.params.id]);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  res.json({ ...msg, attachments: JSON.parse(msg.attachments || '[]') });
});

// --- Delete a specific message ---
app.delete('/api/messages/:id', requireAuth, async (req, res) => {
  await db.run_('DELETE FROM messages WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// --- Update a specific message's content ---
app.patch('/api/messages/:id', requireAuth, async (req, res) => {
  const { content } = req.body;
  await db.run_('UPDATE messages SET content = ? WHERE id = ?', [content, req.params.id]);
  const msg = await db.get_('SELECT * FROM messages WHERE id = ?', [req.params.id]);
  res.json({ ...msg, attachments: JSON.parse(msg.attachments || '[]') });
});

// --- Transcribe audio ---
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file' });
  console.log(`[transcribe] received file: ${req.file.originalname}, size: ${req.file.size}, path: ${req.file.path}`);
  try {
    const OpenAI = require('openai');
    // Whisper must go to real OpenAI, not the LiteLLM proxy
    const apiKey = process.env.OPENAI_API_KEY || process.env.LITELLM_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'No OpenAI API key configured' });
    const openai = new OpenAI({ apiKey, baseURL: 'https://api.openai.com/v1', timeout: 120000 });
    console.log(`[transcribe] calling whisper...`);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: 'whisper-1',
    });
    console.log(`[transcribe] success: "${transcription.text.slice(0, 80)}"`);
    res.json({
      text: transcription.text,
      audioPath: req.file.path,
      audioFilename: path.basename(req.file.path),
      audioSize: req.file.size,
    });
  } catch (e) {
    console.error(`[transcribe] error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- Serve uploaded audio files ---
app.get('/api/audio/:filename', requireAuth, (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Audio not found' });
  res.setHeader('Content-Type', 'audio/webm');
  res.sendFile(filePath);
});

// --- Download file ---
app.get('/api/download', (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath);
});

// --- Shares ---
app.post('/api/shares', async (req, res) => {
  const { resource_type, resource_id, password } = req.body;
  const id = uuidv4();
  const token = uuidv4().replace(/-/g, '').slice(0, 16);
  const password_hash = password ? bcrypt.hashSync(password, 10) : null;
  await db.run_(
    'INSERT INTO shares (id, resource_type, resource_id, token, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, resource_type, resource_id, token, password_hash, Date.now()]
  );
  res.json({ token, url: `/share/${token}` });
});

app.delete('/api/shares/:token', async (req, res) => {
  await db.run_('DELETE FROM shares WHERE token = ?', [req.params.token]);
  res.json({ ok: true });
});

// --- Share view ---
app.get('/share/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

app.get('/api/share/:token', async (req, res) => {
  const share = await db.get_('SELECT * FROM shares WHERE token = ?', [req.params.token]);
  if (!share) return res.status(404).json({ error: 'Share not found' });
  const { password } = req.query;
  if (share.password_hash && (!password || !bcrypt.compareSync(password, share.password_hash))) {
    return res.status(401).json({ error: 'Password required', protected: true });
  }
  if (share.resource_type === 'chat') {
    const chat = await db.get_('SELECT * FROM chats WHERE id = ?', [share.resource_id]);
    const messages = await db.all_('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC', [share.resource_id]);
    res.json({ chat, messages: messages.map(m => ({ ...m, attachments: JSON.parse(m.attachments || '[]') })) });
  } else {
    res.status(400).json({ error: 'Unsupported' });
  }
});

// --- Settings ---
app.put('/api/settings/profile', requireAuth, async (req, res) => {
  try {
    const { display_name } = req.body;
    if (!display_name || !display_name.trim()) return res.status(400).json({ error: 'Display name required' });
    if (req.session.userId) {
      await db.run_('UPDATE users SET display_name = ? WHERE id = ?', [display_name.trim(), req.session.userId]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings/password', async (req, res) => {
  try {
    const { password, current_password, new_password } = req.body;
    // New-style: current_password + new_password
    if (current_password !== undefined && new_password !== undefined) {
      if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      if (req.session.userId) {
        const user = await db.get_('SELECT * FROM users WHERE id = ?', [req.session.userId]);
        if (!user || !bcrypt.compareSync(current_password, user.password_hash)) {
          return res.status(401).json({ error: 'Current password is incorrect' });
        }
        const hash = await bcrypt.hash(new_password, 10);
        await db.run_('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.session.userId]);
        // Also update settings table for backward compat
        await db.run_('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['password_hash', hash]);
        return res.json({ ok: true });
      }
    }
    // Old-style: password field only
    const pw = password || new_password;
    if (!pw || pw.length < 6) return res.status(400).json({ error: 'Password too short' });
    const hash = bcrypt.hashSync(pw, 10);
    await db.run_('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['password_hash', hash]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Workflows ---
const WORKFLOW_DIRS = [
  { dir: path.join(process.env.HOME || '/home/clawdbot', '.openclaw', 'workspace', 'workflows'), source: 'workspace' },
];

app.get('/api/workflows', requireAuth, (req, res) => {
  const workflows = [];
  for (const { dir, source } of WORKFLOW_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      // Flat .md files directly in the workflows dir
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const filePath = path.join(dir, entry.name);
          let description = '';
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n');
            for (const line of lines) {
              const t = line.trim();
              if (!t || t.startsWith('#') || /^[-*_]{3,}$/.test(t)) continue;
              description = t.slice(0, 120);
              break;
            }
          } catch {}
          const name = entry.name.replace(/\.md$/i, '');
          workflows.push({ name, source, path: filePath, description, folder: null });
        } else if (entry.isDirectory()) {
          // Subdirectory = folder grouping; scan its .md files
          const subDir = path.join(dir, entry.name);
          try {
            const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
            for (const sub of subEntries) {
              if (!sub.isFile() || !sub.name.endsWith('.md')) continue;
              const filePath = path.join(subDir, sub.name);
              let description = '';
              try {
                const content = fs.readFileSync(filePath, 'utf8');
                const lines = content.split('\n');
                for (const line of lines) {
                  const t = line.trim();
                  if (!t || t.startsWith('#') || /^[-*_]{3,}$/.test(t)) continue;
                  description = t.slice(0, 120);
                  break;
                }
              } catch {}
              const name = sub.name.replace(/\.md$/i, '');
              workflows.push({ name, source, path: filePath, description, folder: entry.name });
            }
          } catch {}
        }
      }
    } catch {}
  }
  workflows.sort((a, b) => {
    if (a.folder && !b.folder) return -1;
    if (!a.folder && b.folder) return 1;
    if (a.folder && b.folder && a.folder !== b.folder) return a.folder.localeCompare(b.folder);
    return a.name.localeCompare(b.name);
  });
  res.json(workflows);
});

app.get('/api/workflows/content', requireAuth, (req, res) => {
  const { workflowPath } = req.query;
  if (!workflowPath) return res.status(400).json({ error: 'workflowPath required' });
  const allowed = WORKFLOW_DIRS.some(({ dir }) => workflowPath.startsWith(dir + path.sep) || workflowPath.startsWith(dir + '/'));
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(workflowPath)) return res.status(404).json({ error: 'Not found' });
  try {
    const content = fs.readFileSync(workflowPath, 'utf8');
    res.json({ content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Skills ---
const SKILL_DIRS = [
  { dir: path.join(process.env.HOME || '/home/clawdbot', '.openclaw', 'workspace', 'skills'), source: 'workspace' },
  { dir: '/usr/lib/node_modules/openclaw/skills', source: 'system' },
];

app.get('/api/skills', requireAuth, (req, res) => {
  const skills = [];
  for (const { dir, source } of SKILL_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = path.join(dir, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillMdPath)) continue;
        let description = '';
        try {
          const content = fs.readFileSync(skillMdPath, 'utf8');
          // Extract first non-empty non-heading non-rule line as description
          const lines = content.split('\n');
          for (const line of lines) {
            const t = line.trim();
            // Skip headings, horizontal rules (---, ***, ___), and empty lines
            if (!t || t.startsWith('#') || /^[-*_]{3,}$/.test(t)) continue;
            description = t.slice(0, 120);
            break;
          }
        } catch {}
        skills.push({ name: entry.name, source, path: skillMdPath, description });
      }
    } catch {}
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  res.json(skills);
});

// --- Core files API ---
const WORKSPACE_ROOT = path.join(process.env.HOME || '/home/clawdbot', '.openclaw', 'workspace');
const CORE_FILES = [
  { name: 'SOUL',      file: 'SOUL.md',      desc: 'Personality & identity' },
  { name: 'USER',      file: 'USER.md',       desc: 'Owner profile' },
  { name: 'MEMORY',    file: 'MEMORY.md',     desc: 'Working memory' },
  { name: 'AGENTS',    file: 'AGENTS.md',     desc: 'Fleet & behaviour rules' },
  { name: 'TOOLS',     file: 'TOOLS.md',      desc: 'Tool setup & credentials' },
  { name: 'HEARTBEAT', file: 'HEARTBEAT.md',  desc: 'Scheduled tasks' },
  { name: 'IDENTITY',  file: 'IDENTITY.md',   desc: 'Bot identity config' },
];

app.get('/api/core', requireAuth, (req, res) => {
  const result = CORE_FILES.map(item => {
    const filePath = path.join(WORKSPACE_ROOT, item.file);
    return {
      name: item.name,
      file: item.file,
      desc: item.desc,
      path: filePath,
      exists: fs.existsSync(filePath),
    };
  }).filter(item => item.exists);
  res.json(result);
});

app.get('/api/core/content', requireAuth, (req, res) => {
  const { filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  // Security: must be workspace root, no subdirectory traversal
  const resolved = path.resolve(filePath);
  if (path.dirname(resolved) !== WORKSPACE_ROOT) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Not found' });
  try {
    const content = fs.readFileSync(resolved, 'utf8');
    res.json({ content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/skills/content', requireAuth, (req, res) => {
  const { skillPath } = req.query;
  if (!skillPath) return res.status(400).json({ error: 'skillPath required' });
  // Security: must be inside one of the allowed skill dirs
  const allowed = SKILL_DIRS.some(({ dir }) => skillPath.startsWith(dir + path.sep) || skillPath.startsWith(dir + '/'));
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(skillPath)) return res.status(404).json({ error: 'Not found' });
  try {
    const content = fs.readFileSync(skillPath, 'utf8');
    res.json({ content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Abort active agent for a chat ---
app.post('/api/chats/:id/abort', requireAuth, async (req, res) => {
  const chatId = req.params.id;
  const proc = activeAgentProcesses[chatId];
  if (proc) {
    try {
      proc.child.kill('SIGTERM');
      setTimeout(() => { try { proc.child.kill('SIGKILL'); } catch {} }, 2000);
    } catch {}
    delete activeAgentProcesses[chatId];
    if (proc.aiMsgId) {
      await db.run_('UPDATE messages SET content = ? WHERE id = ?', ['[Stopped]', proc.aiMsgId]);
    }
    res.json({ ok: true, aborted: true });
  } else {
    res.json({ ok: true, aborted: false });
  }
});

// ============================================================
// --- Phase 3: SSE, Typing, Invite, Participants Routes ---
// ============================================================

// SSE stream endpoint
app.get('/api/chats/:id/stream', requireAuth, (req, res) => {
  const chatId = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Named heartbeat event every 15s (visible to client addEventListener)
  const heartbeat = setInterval(() => {
    try { res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`); } catch {}
  }, 15000);

  // Register client
  if (!chatSSEClients.has(chatId)) chatSSEClients.set(chatId, new Set());
  chatSSEClients.get(chatId).add(res);

  // Send connected event
  res.write(`event: connected\ndata: ${JSON.stringify({ chatId })}\n\n`);

  // State sync: if agent is currently running for this chat, tell the new/reconnected client
  if (chatGatewayBusy.has(chatId)) {
    const proc = activeAgentProcesses[chatId];
    const thinkingMsgId = proc ? proc.aiMsgId : null;
    sendToClient(res, 'agent_status', { busy: true, thinkingMsgId });
  }

  req.on('close', () => {
    clearInterval(heartbeat);
    const clients = chatSSEClients.get(chatId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) chatSSEClients.delete(chatId);
    }
  });
});

// Global user-event SSE stream — one connection per browser tab, receives cross-chat events
app.get('/api/events', requireAuth, (req, res) => {
  const userId = req.session.userId ? String(req.session.userId) : 'legacy';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (!userSSEClients.has(userId)) userSSEClients.set(userId, new Set());
  userSSEClients.get(userId).add(res);

  // Send connected event
  res.write(`event: connected\ndata: ${JSON.stringify({ userId })}\n\n`);

  // Named heartbeat event every 15s (visible to client addEventListener)
  const heartbeat = setInterval(() => {
    try { res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`); } catch {}
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const clients = userSSEClients.get(userId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) userSSEClients.delete(userId);
    }
  });
});

// Typing indicator
app.post('/api/chats/:id/typing', requireAuth, async (req, res) => {
  try {
    const chatId = req.params.id;
    const userId = req.session.userId || 'legacy';
    if (!typingUsers.has(chatId)) typingUsers.set(chatId, new Map());
    typingUsers.get(chatId).set(userId, Date.now());
    // Get display names for typing users
    const userIds = Array.from(typingUsers.get(chatId).keys());
    const names = [];
    for (const uid of userIds) {
      const u = await db.get_('SELECT display_name FROM users WHERE id = ?', [uid]);
      if (u) names.push(u.display_name);
    }
    broadcastToChat(chatId, 'typing', { users: userIds, names });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Open chat (generate invite)
app.post('/api/chats/:id/open', requireAuth, async (req, res) => {
  try {
    const chat = await db.get_('SELECT * FROM chats WHERE id = ?', [req.params.id]);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const userId = req.session.userId || 'legacy';
    // Must be owner or admin
    const role = getSessionRole(req);
    if (chat.owner_id && chat.owner_id !== userId && role !== 'admin' && role !== 'accord') {
      return res.status(403).json({ error: 'Only the chat owner can open it for collaboration' });
    }
    // Set owner if not set
    if (!chat.owner_id) {
      await db.run_('UPDATE chats SET owner_id = ? WHERE id = ?', [userId, req.params.id]);
    }
    // Invalidate old tokens
    await db.run_('UPDATE chat_invites SET active = 0 WHERE chat_id = ?', [req.params.id]);
    // Create new invite token
    const crypto = require('crypto');
    const token = crypto.randomBytes(16).toString('hex');
    await db.run_(
      'INSERT INTO chat_invites (token, chat_id, created_by, created_at, active) VALUES (?, ?, ?, ?, 1)',
      [token, req.params.id, userId, Date.now()]
    );
    // Ensure owner is in chat_participants
    await db.run_(
      'INSERT OR IGNORE INTO chat_participants (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [req.params.id, userId, 'owner', Date.now()]
    );
    await db.run_('UPDATE chats SET is_open = 1 WHERE id = ?', [req.params.id]);
    res.json({ ok: true, token, inviteUrl: `${getInstanceConfig().url}/join/${token}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Close chat
app.post('/api/chats/:id/close', requireAuth, async (req, res) => {
  try {
    const chat = await db.get_('SELECT * FROM chats WHERE id = ?', [req.params.id]);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const userId = req.session.userId || 'legacy';
    const role = getSessionRole(req);
    if (chat.owner_id && chat.owner_id !== userId && role !== 'admin' && role !== 'accord') {
      return res.status(403).json({ error: 'Only the chat owner can close it' });
    }
    await db.run_('UPDATE chat_invites SET active = 0 WHERE chat_id = ?', [req.params.id]);
    await db.run_('UPDATE chats SET is_open = 0 WHERE id = ?', [req.params.id]);
    broadcastToChat(req.params.id, 'chat_closed', { chatId: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get all platform users with participant status for this chat (owner/admin/accord only)
app.get('/api/chats/:id/all-users', requireAuth, async (req, res) => {
  try {
    const chat = await db.get_('SELECT * FROM chats WHERE id = ?', [req.params.id]);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const requesterId = req.session.userId || 'legacy';
    const role = getSessionRole(req);
    const isOwner = !chat.owner_id || chat.owner_id === requesterId;
    if (!isOwner && role !== 'admin' && role !== 'accord') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const users = await db.all_(`
      SELECT u.id, u.display_name, u.email, u.role,
             CASE WHEN cp.user_id IS NOT NULL THEN 1 ELSE 0 END as is_participant
      FROM users u
      LEFT JOIN chat_participants cp ON cp.user_id = u.id AND cp.chat_id = ?
      WHERE u.active = 1
      ORDER BY u.display_name ASC
    `, [req.params.id]);
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add participant directly (owner/admin/accord only)
app.post('/api/chats/:id/participants', requireAuth, async (req, res) => {
  try {
    const chat = await db.get_('SELECT * FROM chats WHERE id = ?', [req.params.id]);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const requesterId = req.session.userId || 'legacy';
    const role = getSessionRole(req);
    const isOwner = !chat.owner_id || chat.owner_id === requesterId;
    if (!isOwner && role !== 'admin' && role !== 'accord') {
      return res.status(403).json({ error: 'Only the chat owner can add participants' });
    }
    // Claim ownership if unclaimed
    if (!chat.owner_id) {
      await db.run_('UPDATE chats SET owner_id = ? WHERE id = ?', [requesterId, req.params.id]);
    }
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    // Ensure chat is open
    await db.run_('UPDATE chats SET is_open = 1 WHERE id = ?', [req.params.id]);
    await db.run_(
      'INSERT OR IGNORE INTO chat_participants (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [req.params.id, userId, 'member', Date.now()]
    );
    const user = await db.get_('SELECT display_name FROM users WHERE id = ?', [userId]);
    broadcastToChat(req.params.id, 'participant_joined', { userId, displayName: user?.display_name });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get chat participants
app.get('/api/chats/:id/participants', requireAuth, async (req, res) => {
  try {
    const rows = await db.all_(
      `SELECT cp.user_id, cp.role, cp.joined_at, u.display_name, u.email
       FROM chat_participants cp
       JOIN users u ON u.id = cp.user_id
       WHERE cp.chat_id = ?`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove participant (owner only)
app.delete('/api/chats/:id/participants/:userId', requireAuth, async (req, res) => {
  try {
    const chat = await db.get_('SELECT * FROM chats WHERE id = ?', [req.params.id]);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const requesterId = req.session.userId || 'legacy';
    const role = getSessionRole(req);
    const isOwner = !chat.owner_id || chat.owner_id === requesterId;
    if (!isOwner && role !== 'admin' && role !== 'accord') {
      return res.status(403).json({ error: 'Only the chat owner can remove participants' });
    }
    await db.run_('DELETE FROM chat_participants WHERE chat_id = ? AND user_id = ?',
      [req.params.id, req.params.userId]);
    const user = await db.get_('SELECT display_name FROM users WHERE id = ?', [req.params.userId]);
    broadcastToChat(req.params.id, 'participant_left', { userId: req.params.userId, displayName: user?.display_name });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Join via invite link
app.get('/join/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/join/:token', requireAuth, async (req, res) => {
  try {
    const invite = await db.get_('SELECT * FROM chat_invites WHERE token = ? AND active = 1', [req.params.token]);
    if (!invite) return res.status(404).json({ error: 'Invalid or expired invite link' });
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Must be logged in to join' });
    // Add to participants
    await db.run_(
      'INSERT OR IGNORE INTO chat_participants (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [invite.chat_id, userId, 'member', Date.now()]
    );
    const user = await db.get_('SELECT display_name FROM users WHERE id = ?', [userId]);
    broadcastToChat(invite.chat_id, 'participant_joined', { userId, displayName: user?.display_name });
    const chat = await db.get_('SELECT id, title FROM chats WHERE id = ?', [invite.chat_id]);
    res.json({ ok: true, chatId: invite.chat_id, chatTitle: chat?.title });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get active invite for a chat
app.get('/api/chats/:id/invite', requireAuth, async (req, res) => {
  try {
    const invite = await db.get_('SELECT * FROM chat_invites WHERE chat_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1', [req.params.id]);
    if (!invite) return res.json({ token: null });
    res.json({ token: invite.token, inviteUrl: `${getInstanceConfig().url}/join/${invite.token}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// Phase 4: Guest Permission Approval Flow
// ============================================================

// POST /api/chats/:id/request-action — guest requests to use a skill/workflow/mcp
app.post('/api/chats/:id/request-action', requireAuth, async (req, res) => {
  try {
    const role = getSessionRole(req);
    if (role !== 'guest') return res.status(403).json({ error: 'This endpoint is for guests only' });

    const chatId = req.params.id;
    const userId = req.session.userId;
    const { permission, actionName, actionPayload } = req.body;
    if (!permission || !actionName) return res.status(400).json({ error: 'permission and actionName required' });

    // Verify chat exists and guest has access
    const chat = await db.get_('SELECT * FROM chats WHERE id = ?', [chatId]);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    // Check guest_permissions
    const perm = await db.get_('SELECT * FROM guest_permissions WHERE user_id = ? AND permission = ?', [userId, permission]);
    if (!perm) {
      return res.json({ blocked: true, reason: 'no_permission', message: 'You do not have permission to run this action.' });
    }

    if (!perm.requires_approval) {
      return res.json({ allowed: true });
    }

    // Requires approval — create record and system message
    const approvalId = uuidv4();
    const now = Date.now();
    await db.run_(
      `INSERT INTO permission_approvals (id, chat_id, guest_user_id, permission, action_name, action_payload, requires_approval, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [approvalId, chatId, userId, permission, actionName, actionPayload || '', perm.requires_approval, now]
    );

    // Insert system message
    const sysMsgId = uuidv4();
    await db.run_(
      'INSERT INTO messages (id, chat_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [sysMsgId, chatId, 'system', `[APPROVAL_REQUEST:${approvalId}]`, '[]', now]
    );
    await db.run_('UPDATE chats SET updated_at = ? WHERE id = ?', [now, chatId]);

    // Get guest display name
    const guestUser = await db.get_('SELECT display_name FROM users WHERE id = ?', [userId]);
    const guestName = guestUser?.display_name || 'Guest';

    broadcastToChat(chatId, 'approval_request', {
      approvalId, guestName, permission, actionName, requiresApproval: perm.requires_approval
    });

    return res.json({
      allowed: false, pending: true, approvalId,
      message: 'Approval requested. You will be notified when an admin reviews your request.'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/approvals/:id/approve
app.post('/api/approvals/:id/approve', requireAuth, async (req, res) => {
  try {
    const approvalId = req.params.id;
    const callerId = req.session.userId || 'legacy';
    const callerRole = getSessionRole(req);

    if (callerRole !== 'admin' && callerRole !== 'accord') {
      return res.status(403).json({ error: 'Forbidden: must be admin or accord' });
    }

    const approval = await db.get_('SELECT * FROM permission_approvals WHERE id = ?', [approvalId]);
    if (!approval) return res.status(404).json({ error: 'Approval not found' });
    if (approval.status !== 'pending') return res.status(400).json({ error: 'Approval already decided' });

    // accord can only approve if requires_approval === 'accord'
    if (callerRole === 'accord' && approval.requires_approval !== 'accord') {
      return res.status(403).json({ error: 'Forbidden: only admin can approve this request' });
    }

    const now = Date.now();
    await db.run_(
      `UPDATE permission_approvals SET status='approved', decided_by=?, decided_at=? WHERE id=?`,
      [callerId, now, approvalId]
    );

    // Update system message
    await db.run_(
      `UPDATE messages SET content=? WHERE chat_id=? AND content=?`,
      [`[APPROVAL_RESULT:${approvalId}:approved]`, approval.chat_id, `[APPROVAL_REQUEST:${approvalId}]`]
    );
    await db.run_('UPDATE chats SET updated_at = ? WHERE id = ?', [now, approval.chat_id]);

    broadcastToChat(approval.chat_id, 'approval_decision', {
      approvalId, status: 'approved', decidedBy: callerId,
      actionPayload: approval.action_payload, guestUserId: approval.guest_user_id
    });

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/approvals/:id/deny
app.post('/api/approvals/:id/deny', requireAuth, async (req, res) => {
  try {
    const approvalId = req.params.id;
    const callerId = req.session.userId || 'legacy';
    const callerRole = getSessionRole(req);

    if (callerRole !== 'admin' && callerRole !== 'accord') {
      return res.status(403).json({ error: 'Forbidden: must be admin or accord' });
    }

    const approval = await db.get_('SELECT * FROM permission_approvals WHERE id = ?', [approvalId]);
    if (!approval) return res.status(404).json({ error: 'Approval not found' });
    if (approval.status !== 'pending') return res.status(400).json({ error: 'Approval already decided' });

    if (callerRole === 'accord' && approval.requires_approval !== 'accord') {
      return res.status(403).json({ error: 'Forbidden: only admin can deny this request' });
    }

    const now = Date.now();
    await db.run_(
      `UPDATE permission_approvals SET status='denied', decided_by=?, decided_at=? WHERE id=?`,
      [callerId, now, approvalId]
    );

    await db.run_(
      `UPDATE messages SET content=? WHERE chat_id=? AND content=?`,
      [`[APPROVAL_RESULT:${approvalId}:denied]`, approval.chat_id, `[APPROVAL_REQUEST:${approvalId}]`]
    );
    await db.run_('UPDATE chats SET updated_at = ? WHERE id = ?', [now, approval.chat_id]);

    broadcastToChat(approval.chat_id, 'approval_decision', {
      approvalId, status: 'denied', decidedBy: callerId, guestUserId: approval.guest_user_id
    });

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/approvals/:id
app.get('/api/approvals/:id', requireAuth, async (req, res) => {
  try {
    const approval = await db.get_('SELECT * FROM permission_approvals WHERE id = ?', [req.params.id]);
    if (!approval) return res.status(404).json({ error: 'Approval not found' });
    // Also get guest display name
    const guest = await db.get_('SELECT display_name FROM users WHERE id = ?', [approval.guest_user_id]);
    res.json({ ...approval, guest_display_name: guest?.display_name || 'Guest' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Internal email relay endpoint ---
app.post('/internal/send-email', async (req, res) => {
  try {
    // Auth: Bearer <EMAIL_RELAY_SECRET>
    const envLines = (() => { try { return fs.readFileSync(path.join(process.env.HOME || '/home/clawdbot', '.openclaw', '.env'), 'utf8').split('\n'); } catch { return []; } })();
    const extraEnv = {};
    for (const line of envLines) { const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (m) extraEnv[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); }
    const relaySecret = extraEnv.EMAIL_RELAY_SECRET || process.env.EMAIL_RELAY_SECRET;
    if (!relaySecret) return res.status(500).json({ error: 'EMAIL_RELAY_SECRET not configured' });

    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (token !== relaySecret) return res.status(401).json({ error: 'Unauthorized' });

    const { to, subject, body, bodyHtml } = req.body;
    if (!to || !subject) return res.status(400).json({ error: 'to and subject are required' });

    const { sendEmail } = require('./email');
    await sendEmail({ to, subject, body, bodyHtml });
    res.json({ ok: true });
  } catch (e) {
    console.error('[send-email] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- SPA catch-all: serve index.html for any non-API, non-share, non-static path ---
app.get(/^(?!\/api\/|\/share\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Start ---
const CERT_DIR = path.join(__dirname, 'certs');
const certPath = path.join(CERT_DIR, 'cert.pem');
const keyPath = path.join(CERT_DIR, 'key.pem');

// --- HTTP server (no WebSocket) ---
const httpServer = http.createServer(app);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🤖 OpenClaw Web UI`);
  console.log(`   https://your-agent-url (via Cloudflare Tunnel)`);
  console.log(`   Default password: changeme123!\n`);
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled rejection:', reason); });
