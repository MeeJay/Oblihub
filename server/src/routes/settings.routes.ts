import { Router } from 'express';
import { appConfigService } from '../services/appConfig.service';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();
router.use(requireAuth);
router.use(requireRole('admin'));

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
    for (const [key, value] of Object.entries(entries)) {
      // Don't overwrite API key with masked value
      if (key === 'obligate_api_key' && value === '••••••••') continue;
      await appConfigService.set(key, value);
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
