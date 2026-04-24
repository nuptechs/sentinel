// ─────────────────────────────────────────────
// Sentinel — Debug Probe Webhook Receiver
//
// Ingests webhook deliveries from Debug Probe (session.created,
// session.completed, session.error, session.deleted).
//
// Auth model: HMAC-SHA256 signature verification (NOT API key).
// The Probe signs `${timestamp}.${rawBody}` with a shared secret
// and sends `X-Probe-Signature: sha256=<hex>`. Timestamps older
// than 5 minutes are rejected (anti-replay).
//
// Persistence: every accepted delivery is recorded in the storage
// adapter (`recordProbeWebhook`) keyed by deliveryId (idempotent —
// replays become no-ops). A small in-memory ring is kept as a cache
// for low-latency GET inspection and as a fallback when storage
// isn't wired (e.g. isolated tests).
//
// Side effects: for `session.created` and `session.completed`
// events we mirror the Probe's session into Sentinel's own
// SessionService (best-effort; failures are logged but never
// fail the webhook ACK — we don't want the Probe to retry
// legitimate deliveries just because our downstream hiccuped).
// ─────────────────────────────────────────────

import { Router, raw as expressRaw } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_BUFFER = 100;
const MAX_SKEW_SECONDS = 300; // 5 minutes
const MAX_BODY_BYTES = 1_048_576; // 1MB
// NOTE: no silent fallback here — if SENTINEL_PROBE_PROJECT_ID is unset we
// must not quietly mirror sessions into a shared hardcoded project id
// (would leak across tenants / hide misconfiguration). Resolved at call time
// so tests and runtime env changes are honored. See mirrorSession.
let missingProjectIdWarned = false;

function sign(secret, timestamp, rawBody) {
  const hmac = createHmac('sha256', secret);
  hmac.update(`${timestamp}.${rawBody}`);
  return `sha256=${hmac.digest('hex')}`;
}

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * @param {object} [deps]
 * @param {import('../../core/ports/storage.port.js').StoragePort} [deps.storage]
 * @param {{sessions?: any}} [deps.services]
 * @param {{info?: Function, warn?: Function, error?: Function}} [deps.logger]
 */
export function createProbeWebhookRoutes({ storage = null, services = null, logger = console } = {}) {
  const router = Router();
  const secret = process.env.PROBE_WEBHOOK_SECRET;

  // Ring buffer — cache for GET + fallback when storage is absent.
  const buffer = [];
  let receivedTotal = 0;
  let rejectedTotal = 0;

  function pushBuffer(entry) {
    buffer.unshift(entry);
    if (buffer.length > MAX_BUFFER) buffer.length = MAX_BUFFER;
  }

  async function mirrorSession(event, payload) {
    if (!services?.sessions || typeof services.sessions.getOrCreate !== 'function') return;
    const sessionId = payload?.data?.sessionId;
    if (!sessionId) return;

    const projectId = process.env.SENTINEL_PROBE_PROJECT_ID;
    if (!projectId) {
      // Refuse to mirror without an explicit project id. Log once so the
      // misconfiguration is visible but don't crash the webhook pipeline.
      if (!missingProjectIdWarned) {
        missingProjectIdWarned = true;
        if (typeof logger.error === 'function') {
          logger.error(
            '[Probe Webhook] SENTINEL_PROBE_PROJECT_ID is not set — session mirroring DISABLED. ' +
            'Set SENTINEL_PROBE_PROJECT_ID to the Sentinel project id that should own Debug Probe sessions.',
          );
        } else {
          console.error(
            '[Probe Webhook] SENTINEL_PROBE_PROJECT_ID is not set — session mirroring DISABLED.',
          );
        }
      }
      return;
    }

    try {
      if (event === 'session.created') {
        await services.sessions.getOrCreate(sessionId, {
          projectId,
          source: 'debug-probe',
        });
      } else if (event === 'session.completed') {
        await services.sessions.getOrCreate(sessionId, {
          projectId,
          source: 'debug-probe',
        });
        if (typeof services.sessions.complete === 'function') {
          await services.sessions.complete(sessionId).catch(() => {});
        }
      }
    } catch (err) {
      if (typeof logger.warn === 'function') {
        logger.warn(
          { event, sessionId, err: err.message },
          '[Probe Webhook] session mirror failed (non-fatal)',
        );
      }
    }
  }

  // GET /api/probe-webhooks — inspect recent deliveries
  router.get('/', async (_req, res) => {
    let events = buffer;
    let totalPersisted = null;

    if (storage && typeof storage.listProbeWebhooks === 'function') {
      try {
        events = await storage.listProbeWebhooks({ limit: MAX_BUFFER });
        totalPersisted = await storage.countProbeWebhooks?.().catch(() => null);
      } catch (err) {
        if (typeof logger.warn === 'function') {
          logger.warn({ err: err.message }, '[Probe Webhook] storage GET failed, using buffer');
        }
        events = buffer;
      }
    }

    res.json({
      success: true,
      data: {
        configured: Boolean(secret),
        persistent: Boolean(storage && typeof storage.recordProbeWebhook === 'function'),
        receivedTotal,
        rejectedTotal,
        bufferSize: buffer.length,
        totalPersisted,
        events,
      },
    });
  });

  // POST /api/probe-webhooks — receive a delivery (auth = HMAC, not API key)
  router.post(
    '/',
    expressRaw({ type: '*/*', limit: MAX_BODY_BYTES }),
    async (req, res) => {
      if (!secret) {
        rejectedTotal += 1;
        return res.status(503).json({ success: false, error: 'PROBE_WEBHOOK_SECRET not configured' });
      }

      const signature = req.get('X-Probe-Signature') || '';
      const timestamp = req.get('X-Probe-Timestamp') || '';
      const event = req.get('X-Probe-Event') || 'unknown';
      const deliveryId = req.get('X-Probe-Delivery') || '';

      if (!signature || !timestamp) {
        rejectedTotal += 1;
        return res.status(400).json({ success: false, error: 'Missing signature or timestamp header' });
      }

      const tsSeconds = Number.parseInt(timestamp, 10);
      if (!Number.isFinite(tsSeconds)) {
        rejectedTotal += 1;
        return res.status(400).json({ success: false, error: 'Invalid timestamp' });
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSeconds - tsSeconds) > MAX_SKEW_SECONDS) {
        rejectedTotal += 1;
        return res.status(401).json({ success: false, error: 'Timestamp outside acceptable window' });
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const expected = sign(secret, timestamp, rawBody);

      if (!timingSafeEqualStrings(signature, expected)) {
        rejectedTotal += 1;
        return res.status(401).json({ success: false, error: 'Invalid signature' });
      }

      let payload;
      try {
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        rejectedTotal += 1;
        return res.status(400).json({ success: false, error: 'Invalid JSON body' });
      }

      const entry = {
        event,
        deliveryId,
        timestamp: tsSeconds,
        receivedAt: Date.now(),
        payload,
      };

      // Always keep the cache populated
      pushBuffer(entry);
      receivedTotal += 1;

      // Persist (idempotent); failures must not reject the delivery.
      if (storage && typeof storage.recordProbeWebhook === 'function') {
        try {
          await storage.recordProbeWebhook(entry);
        } catch (err) {
          if (typeof logger.warn === 'function') {
            logger.warn({ err: err.message, deliveryId }, '[Probe Webhook] persist failed (non-fatal)');
          }
        }
      }

      // Mirror domain side-effects (best-effort, non-blocking)
      mirrorSession(event, payload).catch(() => {});

      if (typeof logger.info === 'function') {
        logger.info({ event, deliveryId }, '[Probe Webhook] delivered');
      }

      res.status(200).json({ success: true, deliveryId });
    },
  );

  return router;
}
