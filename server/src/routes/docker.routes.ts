import { Router } from 'express';
import { dockerController } from '../controllers/docker.controller';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permissions';

const router = Router();

router.use(requireAuth);

// Images
router.get('/images', requirePermission('docker.images'), dockerController.listImages);
router.post('/images/pull', requirePermission('docker.images'), dockerController.pullImage);
router.post('/images/prune', requirePermission('docker.prune'), dockerController.pruneImages);
router.delete('/images/:id', requirePermission('docker.images'), dockerController.removeImage);

// Networks
router.get('/networks', requirePermission('docker.networks'), dockerController.listNetworks);
router.post('/networks', requirePermission('docker.networks'), dockerController.createNetwork);
router.post('/networks/prune', requirePermission('docker.prune'), dockerController.pruneNetworks);
router.delete('/networks/:id', requirePermission('docker.networks'), dockerController.removeNetwork);
router.post('/networks/:id/connect', requirePermission('docker.networks'), dockerController.connectNetwork);
router.post('/networks/:id/disconnect', requirePermission('docker.networks'), dockerController.disconnectNetwork);

// Volumes
router.get('/volumes', requirePermission('docker.volumes'), dockerController.listVolumes);
router.post('/volumes', requirePermission('docker.volumes'), dockerController.createVolume);
router.post('/volumes/prune', requirePermission('docker.prune'), dockerController.pruneVolumes);
router.delete('/volumes/:name', requirePermission('docker.volumes'), dockerController.removeVolume);

export default router;
