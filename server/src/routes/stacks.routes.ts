import { Router } from 'express';
import { stackController } from '../controllers/stack.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.get('/', stackController.list);
router.get('/:id', stackController.getById);
router.patch('/:id', stackController.update);
router.delete('/:id', stackController.delete);
router.post('/:id/check', stackController.check);
router.post('/:id/update', stackController.triggerUpdate);
router.post('/:id/restart', stackController.restart);
router.get('/:id/history', stackController.getHistory);

export default router;
