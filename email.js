'use strict';

/**
 * email.js — SMTP transport for meshmesh-web (Antar).
 *
 * This module was referenced by server.js since the project invite / password-reset
 * features were added, but the file never existed. Result: every outbound email
 * failed with "Cannot find module './email'" and invites silently went nowhere.
 *
 * Configuration is read from the process environment (see .env):
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, GMAIL_APP_PASSWORD
 *   SMTP_FROM_EMAIL, SMTP_FROM_NAME
 *
 * Compatibility: also accepts SMTP_PASS / SMTP_PASSWORD in place of GMAIL_APP_PASSWORD,
 * and any SMTP_URL as an override.
 */

const nodemailer = require('nodemailer');

let transporter = null;

function getTransport() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure =
    process.env.SMTP_SECURE != null
      ? String(process.env.SMTP_SECURE).toLowerCase() === 'true'
      : port === 465;
  const user = process.env.SMTP_USER;
  const pass =
    process.env.GMAIL_APP_PASSWORD ||
    process.env.SMTP_PASS ||
    process.env.SMTP_PASSWORD;

  if (!host || !user || !pass) {
    throw new Error(
      'SMTP is not configured: need SMTP_HOST, SMTP_USER and GMAIL_APP_PASSWORD (or SMTP_PASS) in .env'
    );
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    // Gmail submit-port quirks: allow self-signed handling like most SMTP relays need
    tls: { rejectUnauthorized: false },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });

  return transporter;
}

/**
 * Send an email.
 * @param {Object} opts
 * @param {string} opts.to       Recipient address (required)
 * @param {string} opts.subject  Subject line
 * @param {string} [opts.body]   Plain-text body
 * @param {string} [opts.bodyHtml] HTML body (falls back to plain text)
 * @param {string} [opts.text]   Alias for body
 * @param {string} [opts.html]   Alias for bodyHtml
 * @param {string} [opts.from]   Override From
 * @param {string} [opts.replyTo]
 * @returns {Promise<{messageId:string, accepted:string[], rejected:string[]}>}
 */
async function sendEmail(opts = {}) {
  const to = opts.to;
  if (!to) throw new Error('sendEmail: "to" is required');

  const text = opts.body || opts.text || '';
  const html = opts.bodyHtml || opts.html || (text ? undefined : undefined);

  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  const fromName = process.env.SMTP_FROM_NAME || '';
  const from = opts.from || (fromName ? `"${fromName}" <${fromEmail}>` : fromEmail);

  const info = await getTransport().sendMail({
    from,
    to,
    subject: opts.subject || '',
    text: text || undefined,
    html: html || undefined,
    replyTo: opts.replyTo || undefined,
  });

  return {
    messageId: info.messageId,
    accepted: info.accepted || [],
    rejected: info.rejected || [],
  };
}

/** Verify the transport can authenticate. Useful for diagnostics. */
async function verifyEmailConfig() {
  await getTransport().verify();
  return { ok: true, host: process.env.SMTP_HOST, port: process.env.SMTP_PORT, user: process.env.SMTP_USER };
}

module.exports = { sendEmail, verifyEmailConfig, getTransport };

// Allow `node email.js <to>` for a manual smoke test.
if (require.main === module) {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: node email.js <recipient@example.com>');
    process.exit(1);
  }
  (async () => {
    console.log('Config:', await verifyEmailConfig());
    const r = await sendEmail({
      to,
      subject: 'meshmesh-web SMTP test',
      body: 'If you can read this, the meshmesh-web mailer works.',
    });
    console.log('Sent:', r);
  })().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
  });
}
