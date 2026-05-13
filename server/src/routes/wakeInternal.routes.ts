import { Router } from 'express';
import { db } from '../db';
import { sleepService } from '../services/sleep.service';
import { logger } from '../utils/logger';

/**
 * Internal wake endpoints — called by nginx-served waking page (via /__oblihub_internal/ proxy).
 * No session auth: nginx is the trust boundary (only requests from the proxy container reach this path).
 * We DO require a shared secret header to prevent direct external probing.
 *
 * Routes:
 *   POST /wake?host=<proxyHostId>            — initiate wake (idempotent)
 *   GET  /wake/status?host=<proxyHostId>     — { state, elapsedMs, message }
 */

const router = Router();

const INTERNAL_TOKEN = process.env.OBLIHUB_INTERNAL_TOKEN || 'oblihub-internal';

router.use((req, res, next) => {
  if (req.headers['x-oblihub-internal'] !== INTERNAL_TOKEN) {
    res.status(403).json({ success: false, error: 'forbidden' });
    return;
  }
  next();
});

async function resolveContainer(proxyHostId: number): Promise<number | null> {
  const row = await db('proxy_hosts').where({ id: proxyHostId }).select('wake_container_id').first();
  return (row?.wake_container_id as number) ?? null;
}

router.post('/wake', async (req, res) => {
  const proxyHostId = parseInt((req.query.host as string) || '', 10);
  if (!proxyHostId) { res.status(400).json({ success: false, error: 'missing host' }); return; }
  const containerId = await resolveContainer(proxyHostId);
  if (!containerId) { res.status(404).json({ success: false, error: 'no wake target' }); return; }
  // Fire-and-forget; idempotent via sleepService.wake's in-flight map.
  sleepService.wake(containerId).catch(err => logger.warn({ err, containerId }, 'wake failed'));
  res.json({ success: true });
});

router.get('/wake/status', async (req, res) => {
  const proxyHostId = parseInt((req.query.host as string) || '', 10);
  if (!proxyHostId) { res.status(400).json({ success: false, error: 'missing host' }); return; }
  const containerId = await resolveContainer(proxyHostId);
  if (!containerId) { res.status(404).json({ success: false, error: 'no wake target' }); return; }
  const status = await sleepService.getWakeStatus(containerId);
  // Map sleep_state to a simpler frontend signal
  const ready = status.state === 'awake';
  res.json({ success: true, data: { ready, state: status.state, elapsedMs: status.elapsedMs, message: status.message } });
});

export default router;
