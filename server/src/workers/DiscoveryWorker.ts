import { dockerService } from '../services/docker.service';
import { stackService } from '../services/stack.service';
import { logger } from '../utils/logger';
import { config } from '../config';
import type { Server as SocketIOServer } from 'socket.io';
import { SOCKET_EVENTS } from '@oblihub/shared';

let discoveryTimer: ReturnType<typeof setInterval> | null = null;

export function startDiscoveryWorker(io: SocketIOServer): void {
  const run = async () => {
    try {
      const containers = await dockerService.listContainers();
      await stackService.syncWithDocker(containers);

      // Signal clients to re-fetch via API (which filters by team/permissions)
      // DO NOT broadcast stack data via socket - it bypasses team/permission checks
      io.emit(SOCKET_EVENTS.DISCOVERY_COMPLETE, { containerCount: containers.length });
    } catch (err) {
      logger.error(err, 'Discovery worker failed');
    }
  };

  // Run immediately on start
  run();

  // Then on interval
  discoveryTimer = setInterval(run, config.discoveryIntervalMs);
  logger.info({ intervalMs: config.discoveryIntervalMs }, 'Discovery worker started');
}

export function stopDiscoveryWorker(): void {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
}
