const { expect } = require('chai');
const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const { createFactsRouter } = require('../facts-api');

function openDatabase() {
  const db = new sqlite3.Database(':memory:');
  db.run_ = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function onRun(error) {
    if (error) reject(error); else resolve(this);
  }));
  db.get_ = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => {
    if (error) reject(error); else resolve(row);
  }));
  db.all_ = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => {
    if (error) reject(error); else resolve(rows);
  }));
  return db;
}

async function startTestServer() {
  const db = openDatabase();
  await db.run_(`CREATE TABLE facts (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    icon TEXT,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    secret INTEGER NOT NULL DEFAULT 0,
    hint TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const notifications = [];
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'facts-test', resave: false, saveUninitialized: false }));
  app.post('/test/login', (req, res) => {
    req.session.authenticated = true;
    res.json({ ok: true });
  });
  const requireAuth = (req, res, next) => {
    if (req.session.userId || req.session.authenticated) return next();
    res.status(401).json({ error: 'Unauthorized' });
  };
  app.use('/api/facts', requireAuth);
  app.use('/api/facts', createFactsRouter({
    db,
    notifyMutation: async (action, fact) => { notifications.push({ action, fact }); },
  }));

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { db, notifications, server, baseUrl };
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/test/login`, { method: 'POST' });
  return response.headers.get('set-cookie').split(';')[0];
}

function request(baseUrl, path, cookie, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
}

describe('/api/facts', () => {
  let context;

  beforeEach(async () => { context = await startTestServer(); });
  afterEach(async () => {
    await new Promise((resolve) => context.server.close(resolve));
    await new Promise((resolve) => context.db.close(resolve));
  });

  it('rejects every unauthenticated CRUD method', async () => {
    const calls = [
      ['GET', '/api/facts'],
      ['GET', '/api/facts/missing'],
      ['POST', '/api/facts'],
      ['PUT', '/api/facts/missing'],
      ['PATCH', '/api/facts/missing'],
      ['DELETE', '/api/facts/missing'],
    ];
    for (const [method, path] of calls) {
      const response = await request(context.baseUrl, path, null, { method });
      expect(response.status, `${method} ${path}`).to.equal(401);
      expect(await response.json()).to.deep.equal({ error: 'Unauthorized' });
    }
  });

  it('supports create, ordered list, read, full update, partial update, and delete', async () => {
    const cookie = await login(context.baseUrl);
    const createdResponse = await request(context.baseUrl, '/api/facts', cookie, {
      method: 'POST',
      body: JSON.stringify({
        id: 'beta-fact', category: 'Testing', icon: '🧪', title: 'Beta', detail: 'Line one\nLine two',
        secret: 'true', hint: 'Ask Meshmesh', sort_order: 20,
      }),
    });
    expect(createdResponse.status).to.equal(201);
    const created = await createdResponse.json();
    expect(created).to.include({ id: 'beta-fact', secret: true, sort_order: 20 });

    await request(context.baseUrl, '/api/facts', cookie, {
      method: 'POST',
      body: JSON.stringify({ id: 'alpha-fact', category: 'Testing', title: 'Alpha', detail: 'Visible', secret: false, sort_order: 5 }),
    });

    const listResponse = await request(context.baseUrl, '/api/facts', cookie);
    expect(listResponse.status).to.equal(200);
    expect((await listResponse.json()).map((fact) => fact.id)).to.deep.equal(['alpha-fact', 'beta-fact']);

    const getResponse = await request(context.baseUrl, '/api/facts/beta-fact', cookie);
    expect((await getResponse.json()).detail).to.equal('Line one\nLine two');

    const putResponse = await request(context.baseUrl, '/api/facts/beta-fact', cookie, {
      method: 'PUT',
      body: JSON.stringify({ category: 'Updated', icon: null, title: 'Beta two', detail: 'Replacement', secret: 'false', hint: null, sort_order: 2 }),
    });
    expect(putResponse.status).to.equal(200);
    expect(await putResponse.json()).to.include({ category: 'Updated', title: 'Beta two', secret: false, sort_order: 2 });

    const patchResponse = await request(context.baseUrl, '/api/facts/beta-fact', cookie, {
      method: 'PATCH',
      body: JSON.stringify({ secret: 1, hint: 'Protected' }),
    });
    expect(patchResponse.status).to.equal(200);
    expect(await patchResponse.json()).to.include({ title: 'Beta two', secret: true, hint: 'Protected' });

    const deleteResponse = await request(context.baseUrl, '/api/facts/beta-fact', cookie, { method: 'DELETE' });
    expect(deleteResponse.status).to.equal(204);
    expect((await request(context.baseUrl, '/api/facts/beta-fact', cookie)).status).to.equal(404);
    expect(context.notifications.map((entry) => entry.action)).to.deep.equal(['created', 'created', 'updated', 'updated', 'deleted']);
  });

  it('returns validation and conflict errors without mutating data', async () => {
    const cookie = await login(context.baseUrl);
    const invalidCases = [
      { payload: { id: 'Bad ID', category: 'Test', title: 'Title', detail: 'Detail' }, error: 'id must be a lowercase slug' },
      { payload: { id: 'missing-category', category: ' ', title: 'Title', detail: 'Detail' }, error: 'category is required' },
      { payload: { id: 'missing-title', category: 'Test', title: '', detail: 'Detail' }, error: 'title is required' },
      { payload: { id: 'missing-detail', category: 'Test', title: 'Title', detail: '\n' }, error: 'detail is required' },
      { payload: { id: 'bad-secret', category: 'Test', title: 'Title', detail: 'Detail', secret: 'maybe' }, error: 'secret must be a boolean' },
      { payload: { id: 'bad-sort', category: 'Test', title: 'Title', detail: 'Detail', sort_order: 1.5 }, error: 'sort_order must be an integer' },
    ];
    for (const testCase of invalidCases) {
      const response = await request(context.baseUrl, '/api/facts', cookie, { method: 'POST', body: JSON.stringify(testCase.payload) });
      expect(response.status).to.equal(400);
      expect((await response.json()).error).to.contain(testCase.error);
    }

    const valid = { id: 'valid-fact', category: 'Test', title: 'Title', detail: 'Detail' };
    expect((await request(context.baseUrl, '/api/facts', cookie, { method: 'POST', body: JSON.stringify(valid) })).status).to.equal(201);
    expect((await request(context.baseUrl, '/api/facts', cookie, { method: 'POST', body: JSON.stringify(valid) })).status).to.equal(409);

    const emptyPatch = await request(context.baseUrl, '/api/facts/valid-fact', cookie, { method: 'PATCH', body: '{}' });
    expect(emptyPatch.status).to.equal(400);
    const invalidPatch = await request(context.baseUrl, '/api/facts/valid-fact', cookie, { method: 'PATCH', body: JSON.stringify({ title: ' ' }) });
    expect(invalidPatch.status).to.equal(400);
    const incompletePut = await request(context.baseUrl, '/api/facts/valid-fact', cookie, { method: 'PUT', body: JSON.stringify({ title: 'Only title' }) });
    expect(incompletePut.status).to.equal(400);
  });
});
