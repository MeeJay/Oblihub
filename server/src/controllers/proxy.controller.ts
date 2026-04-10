import type { Request, Response, NextFunction } from 'express';
import { proxyHostService, redirectionService, streamService, deadHostService, certificateService, accessListService, customPageService } from '../services/proxy.service';
import { stackService } from '../services/stack.service';
import { dockerService } from '../services/docker.service';
import { nginxService } from '../services/nginx.service';
import { letsEncryptService } from '../services/certificate.service';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

export const proxyController = {
  // ── Proxy Hosts ──

  async listProxyHosts(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const hosts = await proxyHostService.getAll();
      res.json({ success: true, data: hosts });
    } catch (err) { next(err); }
  },

  async getProxyHost(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const host = await proxyHostService.getById(parseInt(req.params.id, 10));
      if (!host) throw new AppError(404, 'Proxy host not found');
      res.json({ success: true, data: host });
    } catch (err) { next(err); }
  },

  async createProxyHost(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const host = await proxyHostService.create(req.body);
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: host });
    } catch (err) { next(err); }
  },

  async updateProxyHost(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const host = await proxyHostService.update(parseInt(req.params.id, 10), req.body);
      if (!host) throw new AppError(404, 'Proxy host not found');
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: host });
    } catch (err) { next(err); }
  },

  async deleteProxyHost(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await proxyHostService.delete(parseInt(req.params.id, 10));
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async toggleProxyHost(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const host = await proxyHostService.getById(id);
      if (!host) throw new AppError(404, 'Proxy host not found');
      await proxyHostService.update(id, { enabled: !host.enabled });
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: { enabled: !host.enabled } });
    } catch (err) { next(err); }
  },

  // ── Certificates ──

  async listCertificates(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const certs = await certificateService.getAll();
      res.json({ success: true, data: certs });
    } catch (err) { next(err); }
  },

  async createCertificate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { domainNames, provider, acmeEmail } = req.body;
      if (!domainNames?.length) throw new AppError(400, 'Domain names required');

      const cert = await certificateService.create({ domainNames, provider: provider || 'letsencrypt', acmeEmail });

      // Start certificate provisioning in background
      if (provider === 'letsencrypt' || !provider) {
        if (!acmeEmail) throw new AppError(400, 'Email required for Let\'s Encrypt');
        letsEncryptService.requestCertificate(cert.id, domainNames, acmeEmail).catch(err => {
          logger.error({ certId: cert.id, err }, 'Background cert provisioning failed');
        });
      }

      res.json({ success: true, data: cert });
    } catch (err) { next(err); }
  },

  async uploadCertificate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const { certificate, key, chain } = req.body;
      if (!certificate || !key) throw new AppError(400, 'Certificate and key required');
      await letsEncryptService.uploadCustomCert(id, certificate, key, chain);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async deleteCertificate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await certificateService.delete(parseInt(req.params.id, 10));
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Redirections ──

  async listRedirections(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try { res.json({ success: true, data: await redirectionService.getAll() }); } catch (err) { next(err); }
  },

  async createRedirection(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const host = await redirectionService.create(req.body);
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: host });
    } catch (err) { next(err); }
  },

  async updateRedirection(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const host = await redirectionService.update(parseInt(req.params.id, 10), req.body);
      if (!host) throw new AppError(404, 'Redirection not found');
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: host });
    } catch (err) { next(err); }
  },

  async deleteRedirection(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await redirectionService.delete(parseInt(req.params.id, 10));
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Streams ──

  async listStreams(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try { res.json({ success: true, data: await streamService.getAll() }); } catch (err) { next(err); }
  },

  async createStream(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const stream = await streamService.create(req.body);
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: stream });
    } catch (err) { next(err); }
  },

  async updateStream(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const stream = await streamService.update(parseInt(req.params.id, 10), req.body);
      if (!stream) throw new AppError(404, 'Stream not found');
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: stream });
    } catch (err) { next(err); }
  },

  async deleteStream(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await streamService.delete(parseInt(req.params.id, 10));
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Dead Hosts ──

  async listDeadHosts(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try { res.json({ success: true, data: await deadHostService.getAll() }); } catch (err) { next(err); }
  },

  async createDeadHost(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const host = await deadHostService.create(req.body);
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: host });
    } catch (err) { next(err); }
  },

  async deleteDeadHost(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await deadHostService.delete(parseInt(req.params.id, 10));
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Access Lists ──

  async listAccessLists(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try { res.json({ success: true, data: await accessListService.getAll() }); } catch (err) { next(err); }
  },

  async createAccessList(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const list = await accessListService.create(req.body);
      res.json({ success: true, data: list });
    } catch (err) { next(err); }
  },

  async deleteAccessList(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await accessListService.delete(parseInt(req.params.id, 10));
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async addAccessListClient(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { address, directive } = req.body;
      if (!address) throw new AppError(400, 'Address required');
      await accessListService.addClient(parseInt(req.params.id, 10), address, directive || 'allow');
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async removeAccessListClient(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await accessListService.removeClient(parseInt(req.params.clientId, 10));
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async addAccessListAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username, password } = req.body;
      if (!username || !password) throw new AppError(400, 'Username and password required');
      // Hash password for htpasswd (apr1 compatible)
      const bcrypt = await import('bcrypt');
      const hash = await bcrypt.hash(password, 10);
      await accessListService.addAuth(parseInt(req.params.id, 10), username, hash);
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async removeAccessListAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await accessListService.removeAuth(parseInt(req.params.authId, 10));
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Nginx control ──

  async reloadNginx(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await nginxService.regenerateAndReload();
      res.json({ success: true, message: 'Nginx reloaded' });
    } catch (err) { next(err); }
  },

  async testNginx(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await nginxService.testConfig();
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },

  // ── Custom Pages ──

  async listCustomPages(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try { res.json({ success: true, data: await customPageService.getAll() }); } catch (err) { next(err); }
  },

  async createCustomPage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name, description, errorCodes, htmlContent, theme } = req.body;
      if (!name || !htmlContent) throw new AppError(400, 'Name and HTML content required');
      const page = await customPageService.create({ name, description, errorCodes: errorCodes || [500], htmlContent, theme });
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: page });
    } catch (err) { next(err); }
  },

  async updateCustomPage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const page = await customPageService.update(id, req.body);
      if (!page) throw new AppError(404, 'Custom page not found');
      await nginxService.regenerateAndReload();
      res.json({ success: true, data: page });
    } catch (err) { next(err); }
  },

  async deleteCustomPage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await customPageService.delete(parseInt(req.params.id, 10));
      await nginxService.regenerateAndReload();
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Stack integration ──

  async getProxyHostsByStack(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const stackId = parseInt(req.params.stackId, 10);
      const hosts = await proxyHostService.getByStackId(stackId);
      res.json({ success: true, data: hosts });
    } catch (err) { next(err); }
  },

  async quickSetupProxyHost(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { stackId, containerId, domainNames, forwardPort, requestCertificate, acmeEmail } = req.body as {
        stackId: number; containerId: number; domainNames: string[]; forwardPort: number;
        requestCertificate?: boolean; acmeEmail?: string;
      };

      if (!domainNames?.length) throw new AppError(400, 'At least one domain required');
      if (!forwardPort) throw new AppError(400, 'Forward port required');

      // Lookup container to get its name for Docker DNS
      const container = await stackService.getContainerById(containerId);
      if (!container) throw new AppError(404, 'Container not found');

      // Create certificate if requested
      let certificateId: number | null = null;
      if (requestCertificate) {
        if (!acmeEmail) throw new AppError(400, 'Email required for Let\'s Encrypt');
        const cert = await certificateService.create({ domainNames, provider: 'letsencrypt', acmeEmail });
        certificateId = cert.id;
        // Start LE provisioning in background
        letsEncryptService.requestCertificate(cert.id, domainNames, acmeEmail).catch(err => {
          logger.error({ certId: cert.id, err }, 'Background cert provisioning failed');
        });
      }

      // Create proxy host with sensible defaults
      const host = await proxyHostService.create({
        domainNames,
        forwardScheme: 'http',
        forwardHost: container.containerName,
        forwardPort,
        certificateId,
        sslForced: !!requestCertificate,
        http2Support: !!requestCertificate,
        hstsEnabled: false,
        hstsSubdomains: false,
        blockExploits: true,
        cachingEnabled: false,
        websocketSupport: true,
        enabled: true,
        stackId,
      });

      await nginxService.regenerateAndReload();
      logger.info({ hostId: host.id, domains: domainNames, forward: `${container.containerName}:${forwardPort}` }, 'Quick setup proxy host created');
      res.json({ success: true, data: host });
    } catch (err) { next(err); }
  },

  async getProxyStatus(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Check if proxy container is running
      let nginxRunning = false;
      try {
        const containers = await dockerService.listContainers();
        nginxRunning = containers.some(c => c.labels['oblihub.proxy'] === 'true');
      } catch { /* ignore */ }

      const allHosts = await proxyHostService.getAll();
      const allCerts = await certificateService.getAll();

      res.json({
        success: true,
        data: {
          nginxRunning,
          proxyHostCount: allHosts.length,
          enabledHostCount: allHosts.filter(h => h.enabled).length,
          certificateCount: allCerts.length,
          validCertCount: allCerts.filter(c => c.status === 'valid').length,
          expiringSoon: allCerts.filter(c => c.status === 'valid' && c.expiresAt && new Date(c.expiresAt).getTime() < Date.now() + 14 * 24 * 60 * 60 * 1000).length,
        },
      });
    } catch (err) { next(err); }
  },
};
