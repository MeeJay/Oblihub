import Docker from 'dockerode';
import { db } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { Server as SocketIOServer } from 'socket.io';
import { SOCKET_EVENTS } from '@oblihub/shared';
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

export function startStatsWorker(io: SocketIOServer): void {
  const docker = new Docker({ socketPath: config.dockerSocket });

  const run = async () => {
    try {
      const containers = await docker.listContainers({ all: false });
      const statsData: ContainerStats[] = [];
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

          statsData.push({
            dockerId,
            containerName,
            cpuPercent: Math.round(cpuPercent * 100) / 100,
            memoryUsage,
            memoryLimit,
            memoryPercent: Math.round((memoryUsage / memoryLimit) * 10000) / 100,
            networkRx,
            networkTx,
            timestamp: now.toISOString(),
          });

          // Store in DB (batch insert later)
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

      // Emit to all clients
      if (statsData.length > 0) {
        io.emit(SOCKET_EVENTS.CONTAINER_STATS_UPDATE, statsData);
      }
    } catch (err) {
      logger.error(err, 'Stats worker failed');
    }
  };

  // Run every 10 seconds
  statsTimer = setInterval(run, 10000);
  // First run after 5s (let other workers start first)
  setTimeout(run, 5000);

  logger.info('Stats worker started (10s interval)');
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
