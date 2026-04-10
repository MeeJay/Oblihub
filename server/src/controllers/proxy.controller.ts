import type { Request, Response, NextFunction } from 'express';
import { proxyHostService, redirectionService, streamService, deadHostService, certificateService, accessListService } from '../services/proxy.service';
import { nginxService } from '../services/nginx.service';
import { letsEncryptService } from '../services/certificate.service';
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
};
