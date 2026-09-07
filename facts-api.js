const express = require('express');

const SLUG_PATTERN = /^[a-z0-9-]+$/;
const WRITABLE_FIELDS = ['category', 'icon', 'title', 'detail', 'secret', 'hint', 'sort_order'];

function serializeFact(row) {
  if (!row) return null;
  return { ...row, secret: Boolean(row.secret) };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function coerceSecret(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false' || value == null) return false;
  throw new Error('secret must be a boolean');
}

function normalizeFields(body, { partial = false } = {}) {
  const normalized = {};
  for (const field of WRITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) normalized[field] = body[field];
  }

  if (!partial || Object.prototype.hasOwnProperty.call(normalized, 'category')) {
    if (!nonEmptyString(normalized.category)) throw new Error('category is required and must not be empty');
    normalized.category = normalized.category.trim();
  }
  if (!partial || Object.prototype.hasOwnProperty.call(normalized, 'title')) {
    if (!nonEmptyString(normalized.title)) throw new Error('title is required and must not be empty');
    normalized.title = normalized.title.trim();
  }
  if (!partial || Object.prototype.hasOwnProperty.call(normalized, 'detail')) {
    if (!nonEmptyString(normalized.detail)) throw new Error('detail is required and must not be empty');
    normalized.detail = normalized.detail.trim();
  }
  if (!partial || Object.prototype.hasOwnProperty.call(normalized, 'secret')) {
    normalized.secret = coerceSecret(normalized.secret) ? 1 : 0;
  }
  if (!partial || Object.prototype.hasOwnProperty.call(normalized, 'sort_order')) {
    const value = normalized.sort_order == null || normalized.sort_order === '' ? 0 : Number(normalized.sort_order);
    if (!Number.isInteger(value)) throw new Error('sort_order must be an integer');
    normalized.sort_order = value;
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'icon')) {
    normalized.icon = normalized.icon == null || normalized.icon === '' ? null : String(normalized.icon).trim();
  } else if (!partial) {
    normalized.icon = null;
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'hint')) {
    normalized.hint = normalized.hint == null || normalized.hint === '' ? null : String(normalized.hint).trim();
  } else if (!partial) {
    normalized.hint = null;
  }
  return normalized;
}

function createFactsRouter({ db, notifyMutation = async () => {} }) {
  const router = express.Router();

  router.param('id', (req, res, next, id) => {
    if (!SLUG_PATTERN.test(id)) return res.status(400).json({ error: 'id must be a lowercase slug containing only a-z, 0-9, and hyphens' });
    next();
  });

  const notify = (action, fact) => {
    Promise.resolve(notifyMutation(action, serializeFact(fact))).catch((error) => {
      console.error(`[facts] Agent notification failed after ${action}:`, error.message);
    });
  };

  router.get('/', async (_req, res) => {
    try {
      const rows = await db.all_('SELECT * FROM facts ORDER BY sort_order ASC, id ASC');
      res.json(rows.map(serializeFact));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const fact = await db.get_('SELECT * FROM facts WHERE id = ?', [req.params.id]);
      if (!fact) return res.status(404).json({ error: 'Fact not found' });
      res.json(serializeFact(fact));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const body = req.body || {};
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!SLUG_PATTERN.test(id)) return res.status(400).json({ error: 'id must be a lowercase slug containing only a-z, 0-9, and hyphens' });
      const fields = normalizeFields(body);
      await db.run_(`INSERT INTO facts
        (id, category, icon, title, detail, secret, hint, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, fields.category, fields.icon, fields.title, fields.detail, fields.secret, fields.hint, fields.sort_order]);
      const fact = await db.get_('SELECT * FROM facts WHERE id = ?', [id]);
      notify('created', fact);
      res.status(201).json(serializeFact(fact));
    } catch (error) {
      if (error.message.includes('UNIQUE constraint failed')) return res.status(409).json({ error: 'A fact with that id already exists' });
      if (!error.message.startsWith('SQLITE')) return res.status(400).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const body = req.body || {};
      if (body.id !== undefined && body.id !== req.params.id) return res.status(400).json({ error: 'id cannot be changed' });
      const existing = await db.get_('SELECT id FROM facts WHERE id = ?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Fact not found' });
      const fields = normalizeFields(body);
      await db.run_(`UPDATE facts SET category = ?, icon = ?, title = ?, detail = ?, secret = ?, hint = ?,
        sort_order = ?, updated_at = datetime('now') WHERE id = ?`,
      [fields.category, fields.icon, fields.title, fields.detail, fields.secret, fields.hint, fields.sort_order, req.params.id]);
      const fact = await db.get_('SELECT * FROM facts WHERE id = ?', [req.params.id]);
      notify('updated', fact);
      res.json(serializeFact(fact));
    } catch (error) {
      if (!error.message.startsWith('SQLITE')) return res.status(400).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  router.patch('/:id', async (req, res) => {
    try {
      const body = req.body || {};
      if (body.id !== undefined && body.id !== req.params.id) return res.status(400).json({ error: 'id cannot be changed' });
      const existing = await db.get_('SELECT * FROM facts WHERE id = ?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Fact not found' });
      const fields = normalizeFields(body, { partial: true });
      const keys = Object.keys(fields);
      if (!keys.length) return res.status(400).json({ error: 'At least one fact field is required' });
      const assignments = keys.map((key) => `${key} = ?`).join(', ');
      await db.run_(`UPDATE facts SET ${assignments}, updated_at = datetime('now') WHERE id = ?`,
        [...keys.map((key) => fields[key]), req.params.id]);
      const fact = await db.get_('SELECT * FROM facts WHERE id = ?', [req.params.id]);
      notify('updated', fact);
      res.json(serializeFact(fact));
    } catch (error) {
      if (!error.message.startsWith('SQLITE')) return res.status(400).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const fact = await db.get_('SELECT * FROM facts WHERE id = ?', [req.params.id]);
      if (!fact) return res.status(404).json({ error: 'Fact not found' });
      await db.run_('DELETE FROM facts WHERE id = ?', [req.params.id]);
      notify('deleted', fact);
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createFactsRouter, normalizeFields, serializeFact, SLUG_PATTERN };
