import { Router } from 'express';
import { stackController } from '../controllers/stack.controller';
import { requireAuth } from '../middleware/auth';
import { requirePermission, requireStackAccess } from '../middleware/permissions';

const router = Router();

router.use(requireAuth);

router.get('/', stackController.list); // Filtered by team in controller
router.get('/:id', requirePermission('stacks.view'), requireStackAccess(), stackController.getById);
router.patch('/:id', requirePermission('stacks.manage'), requireStackAccess(), stackController.update);
router.delete('/:id', requirePermission('stacks.manage'), requireStackAccess(), stackController.delete);
router.post('/:id/check', requirePermission('stacks.check'), requireStackAccess(), stackController.check);
router.post('/:id/update', requirePermission('stacks.update'), requireStackAccess(), stackController.triggerUpdate);
router.post('/:id/restart', requirePermission('stacks.restart'), requireStackAccess(), stackController.restart);
router.get('/:id/history', requirePermission('stacks.view'), requireStackAccess(), stackController.getHistory);

export default router;
