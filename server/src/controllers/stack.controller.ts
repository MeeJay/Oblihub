import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { stackService } from '../services/stack.service';
import { updateService } from '../services/update.service';
import { schedulerService } from '../services/scheduler.service';
import { AppError } from '../middleware/errorHandler';
import { config } from '../config';
import { logger } from '../utils/logger';

export const stackController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { filterStacksByTeam } = await import('../middleware/permissions');
      const session = req.session as { userId?: number; role?: string };
      const stacks = await stackService.getAll();
      const filtered = await filterStacksByTeam(session.userId!, session.role || 'user', stacks);
      res.json({ success: true, data: filtered });
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

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const removeContainers = req.query.containers === 'true';
      const removeVolumes = req.query.volumes === 'true';
      const stack = await stackService.getById(id);
      if (!stack) throw new AppError(404, 'Stack not found');
      schedulerService.reschedule(id, 0, false);
      // Optionally remove Docker containers
      if (removeContainers) {
        const { dockerService } = await import('../services/docker.service');
        for (const c of stack.containers) {
          try {
            await dockerService.removeContainer(c.dockerId, removeVolumes);
            logger.info({ containerName: c.containerName }, 'Container removed with stack');
          } catch (err) {
            logger.warn({ containerName: c.containerName, err }, 'Failed to remove container');
          }
        }
      }
      await stackService.delete(id);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const data = req.body as { name?: string; checkInterval?: number; autoUpdate?: boolean; enabled?: boolean; url?: string | null; notifyUpdateAvailable?: boolean | null; notifyUpdateApplied?: boolean | null; notifyDelay?: number | null };
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
      // Run restart in background — containers can take 10+ seconds each
      const { dockerService } = await import('../services/docker.service');
      (async () => {
        for (const c of stack.containers) {
          try {
            await dockerService.restartContainer(c.dockerId);
            logger.info({ containerName: c.containerName, dockerId: c.dockerId }, 'Container restarted');
          } catch (err) {
            logger.error({ containerName: c.containerName, dockerId: c.dockerId, err }, 'Failed to restart container');
          }
        }
      })().catch(() => {});
      res.json({ success: true, message: 'Restart started' });
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

  async inspectContainer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const container = await stackService.getContainerById(id);
      if (!container) throw new AppError(404, 'Container not found');
      const { dockerService } = await import('../services/docker.service');
      const info = await dockerService.inspectContainer(container.dockerId);

      // Ports: filter out null bindings
      const rawPorts = info.HostConfig?.PortBindings || {};
      const ports: Record<string, { HostIp: string; HostPort: string }[]> = {};
      for (const [port, bindings] of Object.entries(rawPorts)) {
        if (Array.isArray(bindings) && bindings.length > 0) {
          ports[port] = bindings.map((b: { HostIp?: string; HostPort?: string } | null) => ({
            HostIp: b?.HostIp || '0.0.0.0',
            HostPort: b?.HostPort || '',
          }));
        }
      }

      // Mounts
      const mounts = (info.Mounts || []).map((m: { Type?: string; Source?: string; Destination?: string; Mode?: string }) => ({
        Type: m.Type || '',
        Source: m.Source || '',
        Destination: m.Destination || '',
        Mode: m.Mode || '',
      }));

      // Networks
      const networks: Record<string, { IPAddress: string; Gateway: string; NetworkID: string }> = {};
      const rawNetworks = info.NetworkSettings?.Networks;
      if (rawNetworks && typeof rawNetworks === 'object') {
        for (const [name, net] of Object.entries(rawNetworks)) {
          if (!net) continue;
          const n = net as { IPAddress?: string; Gateway?: string; NetworkID?: string };
          networks[name] = {
            IPAddress: n.IPAddress || '',
            Gateway: n.Gateway || '',
            NetworkID: (n.NetworkID || '').substring(0, 12),
          };
        }
      }

      res.json({
        success: true,
        data: {
          env: info.Config?.Env || [],
          ports,
          mounts,
          networks,
        },
      });
    } catch (err) { next(err); }
  },

  async removeContainer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const removeVolumes = req.query.volumes === 'true';
      const container = await stackService.getContainerById(id);
      if (!container) throw new AppError(404, 'Container not found');
      const { dockerService } = await import('../services/docker.service');
      await dockerService.removeContainer(container.dockerId, removeVolumes);
      // Remove from DB
      await db('update_history').where({ container_id: id }).delete();
      await db('containers').where({ id }).delete();
      logger.info({ containerId: id, containerName: container.containerName, removeVolumes }, 'Container removed');
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async restartContainer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const container = await stackService.getContainerById(id);
      if (!container) throw new AppError(404, 'Container not found');
      const { dockerService } = await import('../services/docker.service');
      dockerService.restartContainer(container.dockerId).catch((err) => {
        logger.error({ containerId: id, err }, 'Failed to restart container');
      });
      res.json({ success: true, message: 'Restart started' });
    } catch (err) { next(err); }
  },

  async stopContainer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const container = await stackService.getContainerById(id);
      if (!container) throw new AppError(404, 'Container not found');
      const { dockerService } = await import('../services/docker.service');
      dockerService.stopContainer(container.dockerId).catch((err) => {
        logger.error({ containerId: id, err }, 'Failed to stop container');
      });
      res.json({ success: true, message: 'Stop started' });
    } catch (err) { next(err); }
  },

  async startContainer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const container = await stackService.getContainerById(id);
      if (!container) throw new AppError(404, 'Container not found');
      const { dockerService } = await import('../services/docker.service');
      dockerService.startContainer(container.dockerId).catch((err) => {
        logger.error({ containerId: id, err }, 'Failed to start container');
      });
      res.json({ success: true, message: 'Start started' });
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
          allowConsole: config.allowConsole,
          allowStack: config.allowStack,
          allowNginx: config.allowNginx,
        },
      });
    } catch (err) { next(err); }
  },

  async systemFeatures(_req: Request, res: Response): Promise<void> {
    // Detect our own compose project
    let selfProject: string | null = null;
    try {
      const { dockerService } = await import('../services/docker.service');
      const selfId = dockerService.getSelfContainerId();
      logger.info({ selfId, hostname: process.env.HOSTNAME }, 'Self container detection');
      if (selfId) {
        const info = await dockerService.inspectContainer(selfId);
        selfProject = info.Config?.Labels?.['com.docker.compose.project'] || null;
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to detect self container');
    }

    logger.info({ allowConsole: config.allowConsole, allowStack: config.allowStack, selfProject }, 'Features requested');
    res.json({
      success: true,
      data: {
        allowConsole: config.allowConsole,
        allowStack: config.allowStack,
        allowNginx: config.allowNginx,
        selfProject,
      },
    });
  },
};
