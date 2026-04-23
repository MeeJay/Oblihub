import { Router } from 'express';
import { appConfigService } from '../services/appConfig.service';
import { requireAuth, requireRole } from '../middleware/auth';
import { config } from '../config';
import { logger } from '../utils/logger';

const router = Router();
router.use(requireAuth);
router.use(requireRole('admin'));

// Keys that affect nginx config and require a proxy regenerate when changed.
const NGINX_SENSITIVE_KEYS = new Set(['default_error_page_id']);

router.get('/', async (_req, res, next) => {
  try {
    const all = await appConfigService.getAll();
    // Mask sensitive values
    if (all.obligate_api_key) all.obligate_api_key = '••••••••';
    res.json({ success: true, data: all });
  } catch (err) { next(err); }
});

router.patch('/', async (req, res, next) => {
  try {
    const entries = req.body as Record<string, string | null>;
    let nginxAffected = false;
    for (const [key, value] of Object.entries(entries)) {
      // Don't overwrite API key with masked value
      if (key === 'obligate_api_key' && value === '••••••••') continue;
      await appConfigService.set(key, value);
      if (NGINX_SENSITIVE_KEYS.has(key)) nginxAffected = true;
    }
    if (nginxAffected && config.allowNginx) {
      const { nginxService } = await import('../services/nginx.service');
      nginxService.regenerateAndReload().catch(err => logger.warn({ err }, 'Nginx regenerate after settings update failed'));
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
