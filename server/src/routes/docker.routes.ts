import { Router } from 'express';
import { dockerController } from '../controllers/docker.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

// Images
router.get('/images', dockerController.listImages);
router.post('/images/pull', dockerController.pullImage);
router.post('/images/prune', dockerController.pruneImages);
router.delete('/images/:id', dockerController.removeImage);

// Networks
router.get('/networks', dockerController.listNetworks);
router.post('/networks', dockerController.createNetwork);
router.post('/networks/prune', dockerController.pruneNetworks);
router.delete('/networks/:id', dockerController.removeNetwork);
router.post('/networks/:id/connect', dockerController.connectNetwork);
router.post('/networks/:id/disconnect', dockerController.disconnectNetwork);

// Volumes
router.get('/volumes', dockerController.listVolumes);
router.post('/volumes', dockerController.createVolume);
router.post('/volumes/prune', dockerController.pruneVolumes);
router.delete('/volumes/:name', dockerController.removeVolume);

export default router;
