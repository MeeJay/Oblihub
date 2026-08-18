import { Router } from 'express';
import { stackController } from '../controllers/stack.controller';
import { requireAuth } from '../middleware/auth';
import { hostStatsService } from '../services/hostStats.service';

const router = Router();

router.use(requireAuth);

router.get('/', stackController.systemInfo);
router.get('/features', stackController.systemFeatures);
router.post('/discovery/refresh', stackController.refreshDiscovery);
router.get('/host-stats', async (_req, res, next) => {
  try { res.json({ success: true, data: await hostStatsService.get() }); }
  catch (err) { next(err); }
});

export default router;
