import { Router } from 'express';
import { stackController } from '../controllers/stack.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.patch('/:id', stackController.setContainerExcluded);
router.post('/:id/check', stackController.checkContainer);

export default router;
