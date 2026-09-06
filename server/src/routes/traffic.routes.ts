import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/permissions';
import { trafficController } from '../controllers/traffic.controller';

const router = Router();
router.use(requireAuth);

// Reuse the existing proxy.view permission — anyone who can see a proxy host can see its traffic.
router.get('/proxy-host/:id/timeseries', requirePermission('proxy.view'), trafficController.hostTimeSeries);
router.get('/proxy-host/:id/top-ips',    requirePermission('proxy.view'), trafficController.hostTopIps);
router.get('/proxy-host/:id/top-uris',   requirePermission('proxy.view'), trafficController.hostTopUris);
router.get('/summary',                   requirePermission('proxy.view'), trafficController.hostsSummary);
router.get('/team-cumul',                requirePermission('proxy.view'), trafficController.teamCumul);
router.get('/geo',                       requirePermission('proxy.view'), trafficController.geoAggregated);

export default router;
