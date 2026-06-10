/**
 * gateway-client.js
 * Reusable OpenClaw Gateway WebSocket client.
 * Handles auth handshake and exposes request/subscribe helpers.
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
const OPENCLAW_JSON = path.join(HOME, '.openclaw', 'openclaw.json');
const DEVICE_JSON   = path.join(HOME, '.openclaw', 'identity', 'device.json');
const GATEWAY_WS    = 'ws://127.0.0.1:18789/';

const SCOPES = [
  'operator.admin','operator.read','operator.write',
  'operator.approvals','operator.pairing','operator.talk.secrets'
];

function normalizeDeviceMeta(v) {
  if (!v || typeof v !== 'string') return '';
  return v.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

function buildAuthPayload(params) {
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
 * Create an authenticated gateway connection.
 * Returns a client object with:
 *   - request(method, params) → Promise<payload>
 *   - on(eventName, handler)  — listen to broadcast events
 *   - close()
 *   - ready                  — Promise that resolves when connected+authed
 */
function createGatewayClient() {
  const config = JSON.parse(fs.readFileSync(OPENCLAW_JSON, 'utf8'));
  const TOKEN  = config.gateway?.auth?.token;
  const device = JSON.parse(fs.readFileSync(DEVICE_JSON, 'utf8'));

  const ws = new WS(GATEWAY_WS, { headers: { Authorization: `Bearer ${TOKEN}` } });

  let reqId = 0;
  const pending  = new Map();
  const handlers = new Map(); // eventName → Set<fn>

  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });

  ws.on('error', (e) => {
    rejectReady(e);
    for (const [, h] of pending) h.reject(e);
    pending.clear();
  });

  ws.on('close', () => {
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
      const nonce = frame.payload?.nonce;
      const signedAtMs = Date.now();
      const payloadStr = buildAuthPayload({ deviceId: device.deviceId, token: TOKEN, nonce, signedAtMs });
      const signature  = signPayload(device.privateKeyPem, payloadStr);
      try {
        await _request('connect', {
          minProtocol: 4, maxProtocol: 4,
          client: { id: 'cli', version: '2026.5.28', platform: 'linux', mode: 'cli' },
          auth: { token: TOKEN }, scopes: SCOPES, role: 'operator',
          device: {
            id: device.deviceId,
            publicKey: publicKeyRawBase64Url(device.publicKeyPem),
            signature, signedAt: signedAtMs, nonce,
          },
        });
        resolveReady();
      } catch (e) { rejectReady(e); }
      return;
    }

    // --- Broadcast event ---
    if (frame.type === 'event') {
      const set = handlers.get(frame.event);
      if (set) for (const fn of set) fn(frame.payload, frame);
      // Also fire wildcard
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
    ready,
    async request(method, params) {
      await ready;
      return _request(method, params);
    },
    on(eventName, handler) {
      if (!handlers.has(eventName)) handlers.set(eventName, new Set());
      handlers.get(eventName).add(handler);
      return () => handlers.get(eventName)?.delete(handler); // returns unsubscribe fn
    },
    close() { try { ws.close(); } catch {} },
  };
}

module.exports = { createGatewayClient };
