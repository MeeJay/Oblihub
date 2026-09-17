import type { Request, Response, NextFunction } from 'express';
import os from 'node:os';
import { db } from '../db';
import { stackService } from '../services/stack.service';
import { updateService } from '../services/update.service';
import { schedulerService } from '../services/scheduler.service';
import { detectGpus, getCurrentPowerLimits } from '../services/gpuDetection.service';
import { AppError } from '../middleware/errorHandler';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { ResourceLimits } from '@oblihub/shared';
import { appConfigService } from '../services/appConfig.service';
import { markCriticalBusy, clearCriticalBusy, snapshotActivity } from '../state/criticalActivity.state';
import crypto from 'node:crypto';

const WEBHOOK_SECRET_KEY = 'priority_webhook_secret';

async function getOrCreateWebhookSecret(): Promise<string> {
  const existing = await appConfigService.get(WEBHOOK_SECRET_KEY);
  if (existing && existing.length >= 32) return existing;
  const generated = crypto.randomBytes(32).toString('hex');
  await appConfigService.set(WEBHOOK_SECRET_KEY, generated);
  return generated;
}

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
      // Run update in background. updateService internally dedupes per-container in-flight runs
      // so a second click while a 16 GB pull is already going just joins the existing op.
      updateService.updateStack(id, 'manual').catch(() => {});
      res.json({ success: true, message: 'Update started' });
    } catch (err) { next(err); }
  },

  /** Cancel an in-flight update for a single container. */
  async cancelContainerUpdate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const cancelled = updateService.cancelUpdate(id);
      res.json({ success: true, data: { cancelled } });
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
      const { engineService } = await import('../services/engine.service');
      const engines = await engineService.getAll();
      for (const e of engines) {
        if (!e.enabled) continue;
        try {
          const containers = await dockerService.listContainers(e.id);
          await stackService.syncWithDocker(containers, e.id);
        } catch (err) {
          logger.warn({ engineId: e.id, err }, 'Manual refresh failed for engine');
        }
      }
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

      // Server version — read from the bundled package.json. This is the source of truth for
      // "what version of the server code is running right now" since the image is built from it.
      let serverVersion: string | null = null;
      try {
        const fs = await import('node:fs');
        const path = await import('node:path');
        // Walk up from __dirname looking for a package.json that has our server name. Handles
        // both compiled (`dist/src/controllers`) and tsx-dev (`src/controllers`) layouts.
        let dir = __dirname;
        for (let i = 0; i < 5; i++) {
          const candidate = path.join(dir, 'package.json');
          if (fs.existsSync(candidate)) {
            const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
            if (pkg.name === '@oblihub/server') {
              serverVersion = pkg.version ?? null;
              break;
            }
          }
          dir = path.dirname(dir);
        }
      } catch { /* leave null */ }

      // Proxy image tag — best-effort. We find the proxy container (label oblihub.proxy=true on
      // the local engine), report its image. The "version" of nginx:alpine is the tag itself;
      // for end-users that's the most useful identifier.
      let proxyImage: string | null = null;
      try {
        const local = await dockerService.forEngine(null);
        const containers = await local.listContainers({ all: true, filters: { label: ['oblihub.proxy=true'] } });
        if (containers[0]) {
          proxyImage = containers[0].Image || null;
        }
      } catch { /* leave null */ }

      // Find our own server container — used to surface the image tag we're actually running
      // (in case the package.json read above doesn't match what was deployed).
      let serverImage: string | null = null;
      let clientImage: string | null = null;
      try {
        const selfId = dockerService.getSelfContainerId();
        if (selfId) {
          const selfInfo = await dockerService.inspectContainer(selfId);
          serverImage = selfInfo.Config?.Image || null;
          const composeProject = selfInfo.Config?.Labels?.['com.docker.compose.project'];
          if (composeProject) {
            const local = await dockerService.forEngine(null);
            const siblings = await local.listContainers({
              all: true,
              filters: { label: [`com.docker.compose.project=${composeProject}`] },
            });
            const clientSibling = siblings.find((c) => {
              const svc = c.Labels?.['com.docker.compose.service'];
              return svc === 'client';
            });
            if (clientSibling) clientImage = clientSibling.Image || null;
          }
        }
      } catch { /* leave nulls */ }

      const mem = process.memoryUsage();
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
          versions: {
            server: serverVersion,
            serverImage,
            clientImage,
            proxyImage,
            node: process.version,
          },
          instance: {
            uptimeSeconds: Math.round(process.uptime()),
            platform: process.platform,
            arch: process.arch,
          },
          memory: {
            processRssMb: Math.round(mem.rss / 1024 / 1024),
            processHeapMb: Math.round(mem.heapUsed / 1024 / 1024),
          },
        },
      });
    } catch (err) { next(err); }
  },

  async getResources(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const stack = await stackService.getById(id);
      if (!stack) throw new AppError(404, 'Stack not found');
      const [hostGpus, criticalRows, currentPowerLimits] = await Promise.all([
        detectGpus(),
        db('stacks').select('id', 'name').whereRaw("resource_limits->>'priority' = ?", ['critical']),
        getCurrentPowerLimits(),
      ]);
      res.json({
        success: true,
        data: {
          limits: stack.resourceLimits,
          hostGpus,
          hostCpuCount: os.cpus().length,
          hostRamGb: Math.round(os.totalmem() / (1024 ** 3)),
          currentPowerLimits,
          criticalStacks: criticalRows
            .filter((r: { id: number }) => r.id !== id)
            .map((r: { id: number; name: string }) => ({ id: r.id, name: r.name })),
        },
      });
    } catch (err) { next(err); }
  },

  async setResources(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const body = req.body as Partial<ResourceLimits>;
      if (!body || typeof body !== 'object') throw new AppError(400, 'Body required');
      if (!body.priority || !['critical', 'normal', 'opportunistic'].includes(body.priority)) {
        throw new AppError(400, 'priority must be critical | normal | opportunistic');
      }
      const clamp = (v: unknown, min: number, max: number): number | null => {
        if (v == null) return null;
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        return Math.max(min, Math.min(max, n));
      };
      const limits: ResourceLimits = {
        priority: body.priority,
        cpuPercent: clamp(body.cpuPercent, 0, 100),
        ramPercent: clamp(body.ramPercent, 0, 100),
        cpuShares: body.cpuShares != null ? Math.max(2, Math.min(262144, Number(body.cpuShares))) : null,
        visibleGpuIds: Array.isArray(body.visibleGpuIds) ? body.visibleGpuIds.map(String) : null,
        powerLimitWatts: body.powerLimitWatts && typeof body.powerLimitWatts === 'object'
          ? Object.fromEntries(
              Object.entries(body.powerLimitWatts as Record<string, unknown>)
                .map(([k, v]) => [String(k), Number(v)])
                .filter(([, v]) => Number.isFinite(v as number)),
            ) as Record<string, number>
          : null,
        yieldsToStackIds: Array.isArray(body.yieldsToStackIds)
          ? body.yieldsToStackIds.map(Number).filter(Number.isFinite)
          : null,
        yieldSignalSource: body.yieldSignalSource && ['nginx-traffic', 'gpu-util', 'webhook'].includes(body.yieldSignalSource)
          ? body.yieldSignalSource
          : null,
        yieldIdleTimeoutSeconds: body.yieldIdleTimeoutSeconds != null
          ? Math.max(1, Math.min(86400, Number(body.yieldIdleTimeoutSeconds)))
          : null,
        yieldMode: body.yieldMode && ['pause', 'stop'].includes(body.yieldMode) ? body.yieldMode : null,
      };
      const { powerLimitErrors } = await stackService.setResourceLimits(id, limits);
      const stack = await stackService.getById(id);
      res.json({ success: true, data: stack, powerLimitErrors });
    } catch (err) { next(err); }
  },

  /**
   * POST /:id/notify-busy — Critical apps that can't be watched via nginx or GPU (e.g. a
   * background LLM inference burst behind a non-proxied port) call this to stamp themselves
   * busy so Opportunistic stacks yielding to them get paused. Header: X-Oblihub-Priority-Token.
   */
  async notifyBusy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const provided = String(req.header('x-oblihub-priority-token') || '');
      const secret = await getOrCreateWebhookSecret();
      // Constant-time compare — token length is fixed so timingSafeEqual is safe.
      const ok = provided.length === secret.length
        && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
      if (!ok) { res.status(401).json({ success: false, error: 'Invalid priority token' }); return; }
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) throw new AppError(400, 'Invalid stack id');
      markCriticalBusy(id);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async notifyIdle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const provided = String(req.header('x-oblihub-priority-token') || '');
      const secret = await getOrCreateWebhookSecret();
      const ok = provided.length === secret.length
        && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
      if (!ok) { res.status(401).json({ success: false, error: 'Invalid priority token' }); return; }
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) throw new AppError(400, 'Invalid stack id');
      clearCriticalBusy(id);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /** GET /activity — snapshot of critical-stack busy timestamps for the dashboard. */
  async getActivity(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ success: true, data: snapshotActivity() });
    } catch (err) { next(err); }
  },

  /** GET /webhook-secret — admin-only, so the operator can copy it into a Critical app config. */
  async getWebhookSecret(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const secret = await getOrCreateWebhookSecret();
      res.json({ success: true, data: { secret } });
    } catch (err) { next(err); }
  },

  /** POST /webhook-secret/rotate — admin-only, generates a fresh secret. */
  async rotateWebhookSecret(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const generated = crypto.randomBytes(32).toString('hex');
      await appConfigService.set(WEBHOOK_SECRET_KEY, generated);
      res.json({ success: true, data: { secret: generated } });
    } catch (err) { next(err); }
  },

  async clearResources(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await stackService.clearResourceLimits(id);
      res.json({ success: true });
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
