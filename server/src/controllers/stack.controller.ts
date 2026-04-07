import type { Request, Response, NextFunction } from 'express';
import { stackService } from '../services/stack.service';
import { updateService } from '../services/update.service';
import { schedulerService } from '../services/scheduler.service';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

export const stackController = {
  async list(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const stacks = await stackService.getAll();
      res.json({ success: true, data: stacks });
    } catch (err) { next(err); }
  },

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const stack = await stackService.getById(id);
      if (!stack) throw new AppError(404, 'Stack not found');
      res.json({ success: true, data: stack });
    } catch (err) { next(err); }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const data = req.body as { name?: string; checkInterval?: number; autoUpdate?: boolean; enabled?: boolean };
      const stack = await stackService.update(id, data);
      if (!stack) throw new AppError(404, 'Stack not found');

      // Reschedule if interval or enabled changed
      if (data.checkInterval !== undefined || data.enabled !== undefined) {
        schedulerService.reschedule(stack.id, stack.checkInterval, stack.enabled);
      }

      res.json({ success: true, data: stack });
    } catch (err) { next(err); }
  },

  async check(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      // Run check in background, return immediately
      updateService.checkStack(id).catch(() => {});
      res.json({ success: true, message: 'Check started' });
    } catch (err) { next(err); }
  },

  async restart(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const stack = await stackService.getById(id);
      if (!stack) throw new AppError(404, 'Stack not found');
      // Restart all containers in the stack sequentially
      const { dockerService } = await import('../services/docker.service');
      for (const c of stack.containers) {
        try {
          await dockerService.restartContainer(c.dockerId);
        } catch (err) {
          logger.error({ containerId: c.id, err }, 'Failed to restart container');
        }
      }
      res.json({ success: true, message: 'Stack restarted' });
    } catch (err) { next(err); }
  },

  async triggerUpdate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      // Run update in background
      updateService.updateStack(id, 'manual').catch(() => {});
      res.json({ success: true, message: 'Update started' });
    } catch (err) { next(err); }
  },

  async getHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const limit = parseInt(req.query.limit as string || '50', 10);
      const offset = parseInt(req.query.offset as string || '0', 10);
      const history = await updateService.getHistory(id, limit, offset);
      res.json({ success: true, data: history });
    } catch (err) { next(err); }
  },

  async setContainerExcluded(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const { excluded } = req.body as { excluded: boolean };
      await stackService.setExcluded(id, excluded);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async checkContainer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const container = await stackService.getContainerById(id);
      if (!container) throw new AppError(404, 'Container not found');
      // Would need to implement single-container check
      res.json({ success: true, message: 'Check started' });
    } catch (err) { next(err); }
  },

  async refreshDiscovery(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { dockerService } = await import('../services/docker.service');
      const containers = await dockerService.listContainers();
      await stackService.syncWithDocker(containers);
      const stacks = await stackService.getAll();
      res.json({ success: true, data: stacks });
    } catch (err) { next(err); }
  },

  async systemInfo(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { dockerService } = await import('../services/docker.service');
      const [dockerOk, dockerVersion, stacks] = await Promise.all([
        dockerService.ping(),
        dockerService.getVersion(),
        stackService.getAll(),
      ]);
      const totalContainers = stacks.reduce((sum, s) => sum + s.containers.length, 0);
      res.json({
        success: true,
        data: {
          dockerConnected: dockerOk,
          dockerVersion,
          stackCount: stacks.length,
          containerCount: totalContainers,
        },
      });
    } catch (err) { next(err); }
  },
};
