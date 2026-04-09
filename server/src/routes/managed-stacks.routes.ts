import { Router } from 'express';
import { managedStackController } from '../controllers/managed-stack.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.get('/', managedStackController.list);
router.post('/', managedStackController.create);
router.get('/:id', managedStackController.getById);
router.put('/:id', managedStackController.update);
router.delete('/:id', managedStackController.delete);
router.post('/:id/deploy', managedStackController.deploy);
router.post('/:id/stop', managedStackController.stop);
router.post('/:id/down', managedStackController.down);
router.post('/:id/pull', managedStackController.pull);
router.post('/:id/redeploy', managedStackController.redeploy);

export default router;
