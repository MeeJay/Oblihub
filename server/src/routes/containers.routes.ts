import { Router } from 'express';
import { stackController } from '../controllers/stack.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.patch('/:id', stackController.setContainerExcluded);
router.post('/:id/check', stackController.checkContainer);
router.post('/:id/restart', stackController.restartContainer);
router.post('/:id/stop', stackController.stopContainer);
router.post('/:id/start', stackController.startContainer);

export default router;
