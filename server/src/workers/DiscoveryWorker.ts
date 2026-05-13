import { dockerService } from '../services/docker.service';
import { stackService } from '../services/stack.service';
import { engineService } from '../services/engine.service';
import { logger } from '../utils/logger';
import { config } from '../config';
import type { Server as SocketIOServer } from 'socket.io';
import { SOCKET_EVENTS } from '@oblihub/shared';

let discoveryTimer: ReturnType<typeof setInterval> | null = null;

export function startDiscoveryWorker(io: SocketIOServer): void {
  const run = async () => {
    let totalContainers = 0;
    const engines = await engineService.getAll();
    for (const engine of engines) {
      if (!engine.enabled) continue;
      try {
        const containers = await dockerService.listContainers(engine.id);
        await stackService.syncWithDocker(containers, engine.id);
        totalContainers += containers.length;
        // Engine reachable — mark last_ping as ok
        if (engine.lastPingStatus !== 'ok') {
          await engineService.testConnection(engine.id).catch(() => {});
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ engineId: engine.id, engineName: engine.name, err: message }, 'Discovery failed for engine');
        // Surface the error in the engine's last_ping_* so the user can see it on the Engines page.
        await engineService.testConnection(engine.id).catch(() => {});
      }
    }
    // Signal clients to re-fetch via API (which filters by team/permissions).
    // DO NOT broadcast stack data via socket - it bypasses team/permission checks.
    io.emit(SOCKET_EVENTS.DISCOVERY_COMPLETE, { containerCount: totalContainers });
  };

  // Run immediately on start
  run().catch(err => logger.error(err, 'Discovery worker initial run failed'));

  // Then on interval
  discoveryTimer = setInterval(() => { run().catch(err => logger.error(err, 'Discovery worker run failed')); }, config.discoveryIntervalMs);
  logger.info({ intervalMs: config.discoveryIntervalMs }, 'Discovery worker started (multi-engine)');
}

export function stopDiscoveryWorker(): void {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
}
