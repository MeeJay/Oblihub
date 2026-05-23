import { Router } from 'express';
import { stackController } from '../controllers/stack.controller';
import { sleepController } from '../controllers/sleep.controller';
import { requireAuth } from '../middleware/auth';
import { requirePermission, requireContainerAccess } from '../middleware/permissions';

const router = Router();

router.use(requireAuth);

router.patch('/:id', requirePermission('stacks.manage'), requireContainerAccess(), stackController.setContainerExcluded);
router.post('/:id/check', requirePermission('stacks.check'), requireContainerAccess(), stackController.checkContainer);
router.post('/:id/restart', requirePermission('stacks.restart'), requireContainerAccess(), stackController.restartContainer);
router.post('/:id/stop', requirePermission('stacks.stop'), requireContainerAccess(), stackController.stopContainer);
router.post('/:id/start', requirePermission('stacks.stop'), requireContainerAccess(), stackController.startContainer);
router.delete('/:id', requirePermission('stacks.manage'), requireContainerAccess(), stackController.removeContainer);
router.get('/:id/inspect', requirePermission('containers.inspect'), requireContainerAccess(), stackController.inspectContainer);
router.post('/:id/cancel-update', requirePermission('stacks.update'), requireContainerAccess(), stackController.cancelContainerUpdate);

// Sleep mode
router.patch('/:id/sleep-config', requirePermission('stacks.manage'), requireContainerAccess(), sleepController.updateConfig);
router.post('/:id/sleep', requirePermission('stacks.stop'), requireContainerAccess(), sleepController.sleepNow);
router.post('/:id/wake', requirePermission('stacks.stop'), requireContainerAccess(), sleepController.wakeNow);
router.get('/:id/wake-status', requirePermission('stacks.view'), requireContainerAccess(), sleepController.wakeStatus);

export default router;
