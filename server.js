const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { exec, execFile } = require('child_process');
// Track active agent child processes for abort: { chatId: { child, aiMsgId } }
const activeAgentProcesses = {};

// Per-chat message queue — holds messages that arrive while the agent is busy
// chatQueues: Map<chatId, Array<{chat, message, attachments, aiMsgId}>>
const chatQueues = new Map();
// chatGatewayBusy: Set<chatId> — chats with an in-flight agent call
const chatGatewayBusy = new Set();

function enqueueMessage(chat, message, attachments, aiMsgId) {
  if (!chatQueues.has(chat.id)) chatQueues.set(chat.id, []);
  chatQueues.get(chat.id).push({ chat, message, attachments, aiMsgId });
  console.log(`[queue] Enqueued for chat ${chat.id}, depth=${chatQueues.get(chat.id).length}`);
}

function drainQueue(chatId) {
  if (chatGatewayBusy.has(chatId)) return; // still busy — will drain when it finishes
  const queue = chatQueues.get(chatId);
  if (!queue || queue.length === 0) return;
  const next = queue.shift();
  if (queue.length === 0) chatQueues.delete(chatId);
  console.log(`[queue] Draining for chat ${chatId}, remaining=${chatQueues.get(chatId)?.length ?? 0}`);
  chatGatewayBusy.add(chatId);
  runAgent(next.chat, next.message, next.attachments, next.aiMsgId).finally(() => {
    chatGatewayBusy.delete(chatId);
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
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: __dirname }),
  secret: 'openclaw-web-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// --- Init password ---
setTimeout(async () => {
  const row = await db.get_('SELECT value FROM settings WHERE key = ?', ['password_hash']);
  if (!row) {
    const hash = bcrypt.hashSync('changeme123', 10);
    await db.run_('INSERT INTO settings (key, value) VALUES (?, ?)', ['password_hash', hash]);
    console.log('Default password set: changeme123');
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

// --- Auth middleware ---
const requireAuth = (req, res, next) => {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
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

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ authenticated: !!req.session.authenticated }));

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
  res.json(await db.all_('SELECT * FROM projects ORDER BY created_at DESC'));
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
  const { project_id } = req.query;
  if (project_id) {
    res.json(await db.all_('SELECT * FROM chats WHERE project_id = ? ORDER BY updated_at DESC', [project_id]));
  } else {
    res.json(await db.all_('SELECT * FROM chats ORDER BY updated_at DESC'));
  }
});

app.post('/api/chats', async (req, res) => {
  const { project_id, title, telegram_session_key } = req.body;
  const id = uuidv4(), session_id = `web-${id}`, now = Date.now();
  await db.run_(
    'INSERT INTO chats (id, project_id, title, session_id, telegram_session_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, project_id || null, title || 'New Chat', session_id, telegram_session_key || null, now, now]
  );
  res.json(await db.get_('SELECT * FROM chats WHERE id = ?', [id]));
});

app.put('/api/chats/:id', async (req, res) => {
  const { title, project_id, telegram_session_key } = req.body;
  await db.run_(
    'UPDATE chats SET title = ?, project_id = ?, telegram_session_key = ?, updated_at = ? WHERE id = ?',
    [title, project_id || null, telegram_session_key || null, Date.now(), req.params.id]
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

    const { message } = req.body;
    const files = req.files || [];
    const now = Date.now();
    const attachments = files.map(f => ({ name: f.originalname, path: f.path, size: f.size, mimetype: f.mimetype }));

    // Save user message
    const userMsgId = uuidv4();
    await db.run_(
      'INSERT INTO messages (id, chat_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [userMsgId, chat.id, 'user', message || '', JSON.stringify(attachments), now]
    );

    // Update chat
    await db.run_('UPDATE chats SET updated_at = ? WHERE id = ?', [now, chat.id]);

    // Create thinking placeholder
    const aiMsgId = uuidv4();
    await db.run_(
      'INSERT INTO messages (id, chat_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [aiMsgId, chat.id, 'assistant', '...thinking...', '[]', now + 1]
    );

    res.json({ userMsgId, aiMsgId, status: 'processing' });

    // Run agent async — queue if a response is already in flight for this chat
    if (chatGatewayBusy.has(chat.id)) {
      enqueueMessage(chat, message || '', attachments, aiMsgId);
    } else {
      chatGatewayBusy.add(chat.id);
      runAgent(chat, message, attachments, aiMsgId);
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
      if (project && project.instructions) {
        fullMessage = `[Project context: ${project.instructions}]\n\n` + fullMessage;
      }
      if (project) {
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
  } finally {
    // Always release busy lock and drain queue, no matter what
    chatGatewayBusy.delete(chat.id);
    drainQueue(chat.id);
  }
}

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
  try {
    const OpenAI = require('openai');
    // Get API key from env
    const apiKey = process.env.OPENAI_API_KEY || process.env.LITELLM_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'No OpenAI API key configured' });
    const openai = new OpenAI({ apiKey });
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: 'whisper-1',
    });
    res.json({ text: transcription.text });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
app.put('/api/settings/password', async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password too short' });
  const hash = bcrypt.hashSync(password, 10);
  await db.run_('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['password_hash', hash]);
  res.json({ ok: true });
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
  console.log(`   Web UI running on port 8080`);
  console.log(`   Default password: changeme123\n`);
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled rejection:', reason); });
