import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { proxyController } from '../controllers/proxy.controller';
import { requireAuth } from '../middleware/auth';
import { config } from '../config';

const router = Router();

router.use(requireAuth);
router.use((_req: Request, res: Response, next: NextFunction) => {
  if (!config.allowNginx) {
    res.status(403).json({ success: false, error: 'Nginx proxy is disabled. Set ALLOW_NGINX=true to enable.' });
    return;
  }
  next();
});

// Proxy hosts
router.get('/hosts', proxyController.listProxyHosts);
router.get('/hosts/by-stack/:stackId', proxyController.getProxyHostsByStack);
router.post('/hosts/quick-setup', proxyController.quickSetupProxyHost);
router.get('/hosts/:id', proxyController.getProxyHost);
router.post('/hosts', proxyController.createProxyHost);
router.put('/hosts/:id', proxyController.updateProxyHost);
router.delete('/hosts/:id', proxyController.deleteProxyHost);
router.post('/hosts/:id/toggle', proxyController.toggleProxyHost);

// Certificates
router.get('/certificates', proxyController.listCertificates);
router.post('/certificates', proxyController.createCertificate);
router.post('/certificates/:id/upload', proxyController.uploadCertificate);
router.delete('/certificates/:id', proxyController.deleteCertificate);

// Redirections
router.get('/redirections', proxyController.listRedirections);
router.post('/redirections', proxyController.createRedirection);
router.put('/redirections/:id', proxyController.updateRedirection);
router.delete('/redirections/:id', proxyController.deleteRedirection);

// Streams
router.get('/streams', proxyController.listStreams);
router.post('/streams', proxyController.createStream);
router.put('/streams/:id', proxyController.updateStream);
router.delete('/streams/:id', proxyController.deleteStream);

// Dead hosts
router.get('/dead-hosts', proxyController.listDeadHosts);
router.post('/dead-hosts', proxyController.createDeadHost);
router.delete('/dead-hosts/:id', proxyController.deleteDeadHost);

// Access lists
router.get('/access-lists', proxyController.listAccessLists);
router.post('/access-lists', proxyController.createAccessList);
router.delete('/access-lists/:id', proxyController.deleteAccessList);

// Status
router.get('/status', proxyController.getProxyStatus);

// Nginx control
router.post('/nginx/reload', proxyController.reloadNginx);
router.post('/nginx/test', proxyController.testNginx);

export default router;
