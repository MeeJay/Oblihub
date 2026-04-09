import { Router } from 'express';
import { stackController } from '../controllers/stack.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.get('/', stackController.systemInfo);
router.get('/features', stackController.systemFeatures);
router.post('/discovery/refresh', stackController.refreshDiscovery);

export default router;
