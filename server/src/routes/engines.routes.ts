import { Router } from 'express';
import { engineController } from '../controllers/engine.controller';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();
router.use(requireAuth);
router.use(requireRole('admin'));

router.get('/', engineController.list);
router.post('/', engineController.create);
router.post('/test', engineController.testTransient);
router.get('/:id', engineController.getById);
router.patch('/:id', engineController.update);
router.delete('/:id', engineController.delete);
router.post('/:id/test', engineController.testExisting);
router.post('/:id/set-default', engineController.setDefault);

export default router;
