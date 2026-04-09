import type { Request, Response, NextFunction } from 'express';
import { dockerService } from '../services/docker.service';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import type { DockerImage, DockerNetwork, DockerVolume } from '@oblihub/shared';

export const dockerController = {
  // ── Images ──

  async listImages(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawImages = await dockerService.listImages();
      const images: DockerImage[] = rawImages.map(img => ({
        id: img.Id.replace('sha256:', '').substring(0, 12),
        repoTags: img.RepoTags || [],
        repoDigests: img.RepoDigests || [],
        size: img.Size,
        created: img.Created,
        containers: (img as unknown as { Containers: number }).Containers || 0,
      }));
      res.json({ success: true, data: images });
    } catch (err) { next(err); }
  },

  async pullImage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const { image, tag } = req.body as { image: string; tag?: string };
      if (!image) throw new AppError(400, 'Image name required');
      dockerService.pullImage(image, tag || 'latest').catch(() => {});
      res.json({ success: true, message: 'Pull started' });
    } catch (err) { next(err); }
  },

  async removeImage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      await dockerService.removeImage(req.params.id, req.query.force === 'true');
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Networks ──

  async listNetworks(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawNetworks = await dockerService.listNetworks();
      const networks: DockerNetwork[] = await Promise.all(rawNetworks.map(async (net) => {
        // Get detailed info with containers
        let containers: DockerNetwork['containers'] = [];
        try {
          const detail = await dockerService.inspectNetwork(net.Id);
          const netContainers = detail.Containers || {};
          containers = Object.entries(netContainers).map(([id, c]) => ({
            id: id.substring(0, 12),
            name: (c as { Name: string }).Name,
            ipv4: (c as { IPv4Address: string }).IPv4Address || '',
            ipv6: (c as { IPv6Address: string }).IPv6Address || '',
          }));
        } catch { /* ignore */ }

        const labels = net.Labels || {};
        return {
          id: net.Id.substring(0, 12),
          name: net.Name,
          driver: net.Driver || 'bridge',
          scope: net.Scope || 'local',
          internal: net.Internal || false,
          attachable: net.Attachable || false,
          ipam: ((net.IPAM?.Config || []) as { Subnet?: string; Gateway?: string }[]).map(c => ({
            subnet: c.Subnet,
            gateway: c.Gateway,
          })),
          containers,
          labels,
          composeProject: labels['com.docker.compose.project'] || null,
          created: net.Created || '',
        };
      }));
      res.json({ success: true, data: networks });
    } catch (err) { next(err); }
  },

  async createNetwork(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const { name, driver, internal, attachable, labels, subnet, gateway } = req.body;
      if (!name) throw new AppError(400, 'Network name required');
      const id = await dockerService.createNetwork({ name, driver, internal, attachable, labels, subnet, gateway });
      res.json({ success: true, data: { id } });
    } catch (err) { next(err); }
  },

  async removeNetwork(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      await dockerService.removeNetwork(req.params.id);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async connectNetwork(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const { containerId, aliases } = req.body as { containerId: string; aliases?: string[] };
      if (!containerId) throw new AppError(400, 'Container ID required');
      await dockerService.connectNetwork(req.params.id, containerId, aliases);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async disconnectNetwork(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const { containerId } = req.body as { containerId: string };
      if (!containerId) throw new AppError(400, 'Container ID required');
      await dockerService.disconnectNetwork(req.params.id, containerId, true);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Volumes ──

  async listVolumes(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await dockerService.listVolumes();
      const volumes: DockerVolume[] = (result.Volumes || []).map(v => {
        const labels = v.Labels || {};
        return {
          name: v.Name,
          driver: v.Driver,
          mountpoint: v.Mountpoint,
          scope: v.Scope || 'local',
          labels,
          composeProject: labels['com.docker.compose.project'] || null,
          created: (v as unknown as { CreatedAt?: string }).CreatedAt || '',
          usageSize: (v as unknown as { UsageData?: { Size?: number } }).UsageData?.Size ?? null,
        };
      });
      res.json({ success: true, data: volumes });
    } catch (err) { next(err); }
  },

  async createVolume(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const { name, driver, labels } = req.body;
      if (!name) throw new AppError(400, 'Volume name required');
      const info = await dockerService.createVolume({ name, driver, labels });
      res.json({ success: true, data: info });
    } catch (err) { next(err); }
  },

  async removeVolume(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      await dockerService.removeVolume(req.params.name, req.query.force === 'true');
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Prune ──

  async pruneImages(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await dockerService.pruneImages();
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },

  async pruneNetworks(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await dockerService.pruneNetworks();
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },

  async pruneVolumes(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await dockerService.pruneVolumes();
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },
};
