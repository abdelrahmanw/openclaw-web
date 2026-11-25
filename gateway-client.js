/**
 * gateway-client.js
 * Reusable OpenClaw Gateway WebSocket client.
 * Handles auth handshake and exposes request/subscribe helpers.
 * v3: Device-identity optional. Works on OpenClaw <=2026.7 (JSON identity files)
 *     and >=2026.9 (identity moved into the state DB) without code changes.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const WS = (() => {
  // Use OpenClaw's bundled ws
  try { return require('/usr/lib/node_modules/openclaw/node_modules/ws/lib/websocket.js'); }
  catch { return require('ws'); }
})();

const HOME = process.env.HOME || '/home/clawdbot';
const STATE_DIR      = path.join(HOME, '.openclaw');
const OPENCLAW_JSON  = path.join(STATE_DIR, 'openclaw.json');
const DEVICE_JSON    = path.join(STATE_DIR, 'identity', 'device.json');
const DEVICE_AUTH_JSON = path.join(STATE_DIR, 'identity', 'device-auth.json');
const STATE_DB       = path.join(STATE_DIR, 'state', 'openclaw.sqlite');
const GATEWAY_WS    = 'ws://127.0.0.1:18789/';

const SCOPES = [
  'operator.admin','operator.read','operator.write',
  'operator.approvals','operator.pairing','operator.talk.secrets'
];

// Connection-level timeline
let connectionGeneration = 0;

function normalizeDeviceMeta(v) {
  if (!v || typeof v !== 'string') return '';
  return v.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

function buildAuthPayload(params) {
  // Must be v3 — matches buildDeviceAuthPayloadV3 in openclaw dist/client-5XIBFtwk.js
  return ['v3', params.deviceId, 'cli', 'cli', 'operator',
    SCOPES.join(','), String(params.signedAtMs),
    params.token ?? '', params.nonce,
    normalizeDeviceMeta('linux'), ''
  ].join('|');
}

function signPayload(pem, str) {
  return crypto.sign(null, Buffer.from(str), crypto.createPrivateKey(pem)).toString('base64url');
}

function publicKeyRawBase64Url(pem) {
  const raw = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return raw.slice(-32).toString('base64url');
}

/**
 * Read the gateway token. Prefers openclaw.json, falls back to the
 * device-auth.json operator token (legacy layouts).
 */
function readGatewayTokens() {
  let configToken = null;
  try {
    const config = JSON.parse(fs.readFileSync(OPENCLAW_JSON, 'utf8'));
    configToken = config?.gateway?.auth?.token || config?.gateway?.remote?.token || null;
  } catch (_) {}

  let deviceToken = null;
  try {
    const deviceAuth = JSON.parse(fs.readFileSync(DEVICE_AUTH_JSON, 'utf8'));
    deviceToken = deviceAuth?.tokens?.operator?.token || null;
  } catch (_) {}

  return {
    // Authorization header token — the config token is the gateway-wide credential.
    headerToken: configToken || deviceToken,
    // Payload/device token — legacy device-auth token wins if present.
    authToken: deviceToken || configToken,
  };
}

/**
 * Best-effort read of a device identity from the state DB (OpenClaw >= 2026.9).
 * Returns null when unavailable — never throws.
 */
function readIdentityFromDb() {
  let db = null;
  try {
    if (!fs.existsSync(STATE_DB)) return null;
    const Database = require('better-sqlite3');
    db = new Database(STATE_DB, { readonly: true, fileMustExist: true });
    const row = db
      .prepare('SELECT device_id, public_key_pem, private_key_pem FROM device_identities ORDER BY updated_at_ms DESC LIMIT 1')
      .get();
    if (!row || !row.private_key_pem || !row.device_id) return null;
    return {
      deviceId: row.device_id,
      publicKeyPem: row.public_key_pem,
      privateKeyPem: row.private_key_pem,
      source: 'db',
    };
  } catch (_) {
    return null;
  } finally {
    try { if (db) db.close(); } catch {}
  }
}

/**
 * Read the device identity from the legacy JSON file (OpenClaw <= 2026.7).
 * Returns null when the file is gone — never throws.
 */
function readIdentityFromFile() {
  try {
    const device = JSON.parse(fs.readFileSync(DEVICE_JSON, 'utf8'));
    if (!device?.deviceId || !device?.privateKeyPem) return null;
    return {
      deviceId: device.deviceId,
      publicKeyPem: device.publicKeyPem,
      privateKeyPem: device.privateKeyPem,
      source: 'file',
    };
  } catch (_) {
    return null;
  }
}

/**
 * Resolve a usable device identity, or null when we should use the
 * token-only local connect path. Never throws.
 */
function resolveDeviceIdentity() {
  if (String(process.env.OPENCLAW_GW_NO_DEVICE || '') === '1') return null;
  return readIdentityFromFile() || readIdentityFromDb();
}

/**
 * Create an authenticated gateway connection.
 * Returns a client object with:
 *   - request(method, params) → Promise<payload>
 *   - on(eventName, handler)  — listen to broadcast events
 *   - close()
 *   - ready                  — Promise that resolves when connected+authed
 *   - generation             — monotonic connection id (increments on each connect)
 *   - authMode               — 'device' | 'token'
 *
 * Throws synchronously only for unrecoverable config problems (no token at all).
 */
function createGatewayClient(opts = {}) {
  const { headerToken, authToken } = readGatewayTokens();
  if (!headerToken) {
    throw new Error('gateway token unavailable (openclaw.json gateway.auth.token missing)');
  }
  const TOKEN = authToken || headerToken;

  // Optional: device identity. Absent on OpenClaw >= 2026.9 after migration.
  const device = opts.device === null ? null : resolveDeviceIdentity();
  const authMode = device ? 'device' : 'token';

  // When we have no signing key we connect as a trusted same-process backend
  // client. That is the documented device-less loopback path (docs/gateway/
  // protocol.md): it only accepts the shared gateway token as auth.token.
  const CLIENT = device
    ? { id: 'cli', version: '2026.5.28', platform: 'linux', mode: 'cli' }
    : { id: 'gateway-client', version: '2026.10.6', platform: 'linux', mode: 'backend' };

  const generation = ++connectionGeneration;

  // Extract caps. Caps make the Gateway send extra events during agent runs.
  const caps = opts.caps || [];

  const ws = new WS(GATEWAY_WS, { headers: { Authorization: `Bearer ${headerToken}` } });

  let reqId = 0;
  const pending  = new Map();
  const handlers = new Map();
  let _closed = false;

  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });

  const timeout = setTimeout(() => {
    rejectReady(new Error('gateway connect timeout'));
  }, 15000);

  ws.on('error', (e) => {
    _closed = true;
    clearTimeout(timeout);
    rejectReady(e);
    for (const [, h] of pending) h.reject(e);
    pending.clear();
  });

  ws.on('close', () => {
    _closed = true;
    clearTimeout(timeout);
    const err = new Error('gateway ws closed');
    for (const [, h] of pending) h.reject(err);
    pending.clear();
  });

  ws.on('message', async (data) => {
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { return; }

    // --- Response to a request ---
    if (frame.type === 'res') {
      const h = pending.get(frame.id);
      if (h) {
        pending.delete(frame.id);
        frame.ok ? h.resolve(frame.payload) : h.reject(new Error(JSON.stringify(frame.error)));
      }
      return;
    }

    // --- Auth challenge ---
    if (frame.type === 'event' && frame.event === 'connect.challenge') {
      clearTimeout(timeout);
      const nonce = frame.payload?.nonce;
      const signedAtMs = Date.now();

      const connectParams = {
        minProtocol: 4, maxProtocol: 4,
        client: CLIENT,
        caps: caps.length > 0 ? caps : void 0,
        auth: { token: device ? TOKEN : headerToken },
        scopes: SCOPES, role: 'operator',
      };

      if (device) {
        const payloadStr = buildAuthPayload({ deviceId: device.deviceId, token: TOKEN, nonce, signedAtMs });
        const signature  = signPayload(device.privateKeyPem, payloadStr);
        connectParams.device = {
          id: device.deviceId,
          publicKey: publicKeyRawBase64Url(device.publicKeyPem),
          signature, signedAt: signedAtMs, nonce,
        };
      }

      try {
        await _request('connect', connectParams);
        resolveReady();
      } catch (e) {
        rejectReady(e);
      }
      return;
    }

    // --- Broadcast event ---
    if (frame.type === 'event') {
      const set = handlers.get(frame.event);
      if (set) for (const fn of set) fn(frame.payload, frame);
      const all = handlers.get('*');
      if (all) for (const fn of all) fn(frame.payload, frame);
    }
  });

  function _request(method, params) {
    const id = `r${++reqId}`;
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        pending.delete(id);
        reject(new Error(`gateway timeout: ${method}`));
      }, 30000);
    });
  }

  return {
    _ws: ws,
    ready,
    generation,
    authMode,
    deviceSource: device ? device.source : null,
    get connected() { return !_closed && ws.readyState === 1; },
    async request(method, params) {
      await ready;
      return _request(method, params);
    },
    on(eventName, handler) {
      if (!handlers.has(eventName)) handlers.set(eventName, new Set());
      handlers.get(eventName).add(handler);
      return () => handlers.get(eventName)?.delete(handler);
    },
    close() { clearTimeout(timeout); try { ws.close(); } catch {} },
  };
}

module.exports = { createGatewayClient };
