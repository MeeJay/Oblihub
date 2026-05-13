import type { Request, Response, NextFunction } from 'express';
import { engineService } from '../services/engine.service';
import { AppError } from '../middleware/errorHandler';
import type { DockerEngineType } from '@oblihub/shared';

interface EngineWriteBody {
  name?: string;
  type?: DockerEngineType;
  host?: string;
  port?: number;
  sshUser?: string;
  sshPrivateKey?: string;
  sshKnownHost?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  tlsCa?: string;
  tlsCert?: string;
  tlsKey?: string;
  enabled?: boolean;
}

export const engineController = {
  async list(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try { res.json({ success: true, data: await engineService.getAll() }); }
    catch (err) { next(err); }
  },

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const engine = await engineService.getById(id);
      if (!engine) throw new AppError(404, 'Engine not found');
      res.json({ success: true, data: engine });
    } catch (err) { next(err); }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as EngineWriteBody;
      if (!body.name || !body.type) throw new AppError(400, 'name and type required');
      const engine = await engineService.create({
        name: body.name,
        type: body.type,
        host: body.host,
        port: body.port,
        sshUser: body.sshUser,
        sshPrivateKey: body.sshPrivateKey,
        sshKnownHost: body.sshKnownHost,
        apiKey: body.apiKey,
        apiKeyHeader: body.apiKeyHeader,
        tlsCa: body.tlsCa,
        tlsCert: body.tlsCert,
        tlsKey: body.tlsKey,
        enabled: body.enabled,
      });
      res.json({ success: true, data: engine });
    } catch (err) { next(err); }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const body = req.body as EngineWriteBody;
      const engine = await engineService.update(id, body);
      if (!engine) throw new AppError(404, 'Engine not found');
      res.json({ success: true, data: engine });
    } catch (err) { next(err); }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await engineService.delete(id);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async setDefault(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await engineService.setDefault(id);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async testExisting(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const result = await engineService.testConnection(id);
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },

  async testTransient(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as EngineWriteBody;
      if (!body.name || !body.type) throw new AppError(400, 'name and type required');
      const result = await engineService.testConfig({
        name: body.name,
        type: body.type,
        host: body.host,
        port: body.port,
        sshUser: body.sshUser,
        sshPrivateKey: body.sshPrivateKey,
        sshKnownHost: body.sshKnownHost,
        apiKey: body.apiKey,
        apiKeyHeader: body.apiKeyHeader,
        tlsCa: body.tlsCa,
        tlsCert: body.tlsCert,
        tlsKey: body.tlsKey,
        enabled: body.enabled,
      });
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },
};
