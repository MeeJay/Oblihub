import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { managedStackController } from '../controllers/managed-stack.controller';
import { requireAuth } from '../middleware/auth';
import { config } from '../config';

const router = Router();

router.use(requireAuth);
router.use((_req: Request, res: Response, next: NextFunction) => {
  if (!config.allowStack) { res.status(403).json({ success: false, error: 'Stack management is disabled' }); return; }
  next();
});

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
router.post('/:id/cancel', managedStackController.cancel);

export default router;
