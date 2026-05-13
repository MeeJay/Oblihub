import Docker from 'dockerode';
import { db } from '../db';
import { logger } from '../utils/logger';
import { engineService } from '../services/engine.service';
import { dockerService } from '../services/docker.service';
import type { Server as SocketIOServer } from 'socket.io';
import type { ContainerStats } from '@oblihub/shared';

let statsTimer: ReturnType<typeof setInterval> | null = null;

function calculateCpuPercent(stats: Docker.ContainerStats): number {
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats?.system_cpu_usage || 0);
  const numCpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  if (systemDelta > 0 && cpuDelta >= 0) {
    return (cpuDelta / systemDelta) * numCpus * 100;
  }
  return 0;
}

export function startStatsWorker(_io: SocketIOServer): void {
  const run = async () => {
    const engines = await engineService.getAll();
    for (const engine of engines) {
      if (!engine.enabled) continue;
      try {
        const docker = await dockerService.forEngine(engine.id);
        const containers = await docker.listContainers({ all: false });
        const now = new Date();

        for (const c of containers) {
          try {
            const container = docker.getContainer(c.Id);
            const stats = await container.stats({ stream: false }) as Docker.ContainerStats;

            const cpuPercent = calculateCpuPercent(stats);
            const memoryUsage = stats.memory_stats?.usage || 0;
            const memoryLimit = stats.memory_stats?.limit || 1;

            let networkRx = 0;
            let networkTx = 0;
            if (stats.networks) {
              for (const net of Object.values(stats.networks)) {
                networkRx += (net as { rx_bytes: number }).rx_bytes || 0;
                networkTx += (net as { tx_bytes: number }).tx_bytes || 0;
              }
            }

            const dockerId = c.Id.substring(0, 12);
            const containerName = (c.Names?.[0] || '').replace(/^\//, '');

            await db('container_stats').insert({
              container_docker_id: dockerId,
              container_name: containerName,
              cpu_percent: Math.round(cpuPercent * 100) / 100,
              memory_usage: memoryUsage,
              memory_limit: memoryLimit,
              network_rx: networkRx,
              network_tx: networkTx,
              timestamp: now,
            });
          } catch {
            // Container might have stopped between listing and stats
          }
        }
      } catch (err) {
        logger.warn({ engineId: engine.id, engineName: engine.name, err: err instanceof Error ? err.message : err }, 'Stats worker failed for engine');
      }
    }
  };

  // Run every 10 seconds
  statsTimer = setInterval(run, 10000);
  // First run after 5s (let other workers start first)
  setTimeout(run, 5000);

  logger.info('Stats worker started (10s interval, multi-engine)');
}

export function stopStatsWorker(): void {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}

/** Cleanup old stats (keep last 7 days) */
export async function cleanupOldStats(): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const deleted = await db('container_stats').where('timestamp', '<', cutoff).delete();
  if (deleted > 0) {
    logger.info({ deleted }, 'Cleaned up old container stats');
  }
}
