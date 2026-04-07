import { db } from '../db';
import { dockerService } from './docker.service';
import { registryService } from './registry.service';
import { stackService } from './stack.service';
import { logger } from '../utils/logger';
import type { Server as SocketIOServer } from 'socket.io';
import { SOCKET_EVENTS } from '@oblihub/shared';
import type { UpdateHistoryEntry, UpdateStatus } from '@oblihub/shared';

let _io: SocketIOServer | null = null;

export function setUpdateServiceIO(io: SocketIOServer): void {
  _io = io;
}

interface HistoryRow {
  id: number;
  stack_id: number | null;
  container_id: number | null;
  container_name: string;
  image: string;
  old_digest: string | null;
  new_digest: string | null;
  status: string;
  error_message: string | null;
  triggered_by: string;
  started_at: Date;
  completed_at: Date | null;
}

function rowToHistory(row: HistoryRow): UpdateHistoryEntry {
  return {
    id: row.id,
    stackId: row.stack_id,
    containerId: row.container_id,
    containerName: row.container_name,
    image: row.image,
    oldDigest: row.old_digest,
    newDigest: row.new_digest,
    status: row.status as UpdateStatus,
    errorMessage: row.error_message,
    triggeredBy: row.triggered_by as 'auto' | 'manual',
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

export const updateService = {
  /**
   * Check all containers in a stack for updates.
   * Updates container status and emits Socket.io events.
   */
  async checkStack(stackId: number): Promise<void> {
    const stack = await stackService.getById(stackId);
    if (!stack || !stack.enabled) return;

    logger.info({ stackId, stackName: stack.name }, 'Checking stack for updates...');

    for (const container of stack.containers) {
      if (container.excluded) continue;

      try {
        // Get local digest
        const localDigest = await dockerService.getLocalDigest(`${container.image}:${container.imageTag}`);

        // Check remote
        const { hasUpdate, remoteDigest } = await registryService.checkForUpdate(
          container.image,
          container.imageTag,
          localDigest,
        );

        const newStatus = hasUpdate ? 'update_available' as const : 'up_to_date' as const;

        await stackService.updateContainerStatus(
          container.id,
          newStatus,
          remoteDigest,
          localDigest,
        );

        if (_io) {
          _io.emit(SOCKET_EVENTS.CONTAINER_STATUS_CHANGED, {
            containerId: container.id,
            stackId,
            status: newStatus,
            currentDigest: localDigest,
            latestDigest: remoteDigest,
          });
        }
      } catch (err) {
        logger.error({ containerId: container.id, err }, 'Failed to check container');
        await stackService.updateContainerStatus(container.id, 'error', null, null, String(err));
      }
    }

    await stackService.markChecked(stackId);

    if (_io) {
      _io.emit(SOCKET_EVENTS.STACK_STATUS_CHANGED, { stackId });
    }

    // Auto-update if enabled
    if (stack.autoUpdate) {
      const updatedStack = await stackService.getById(stackId);
      const hasUpdates = updatedStack?.containers.some(c => c.status === 'update_available');
      if (hasUpdates) {
        await this.updateStack(stackId, 'auto');
      }
    }
  },

  /**
   * Update all containers in a stack that have updates available.
   */
  async updateStack(stackId: number, triggeredBy: 'auto' | 'manual' = 'manual'): Promise<void> {
    const stack = await stackService.getById(stackId);
    if (!stack) return;

    const toUpdate = stack.containers.filter(c => c.status === 'update_available' && !c.excluded);
    if (toUpdate.length === 0) return;

    logger.info({ stackId, stackName: stack.name, count: toUpdate.length }, 'Updating stack...');

    for (const container of toUpdate) {
      await this.updateContainer(container.id, stackId, triggeredBy);
    }

    await stackService.markUpdated(stackId);
  },

  /**
   * Update a single container.
   */
  async updateContainer(containerId: number, stackId: number | null, triggeredBy: 'auto' | 'manual' = 'manual'): Promise<void> {
    const container = await stackService.getContainerById(containerId);
    if (!container) return;

    // Create history entry
    const [historyRow] = await db('update_history').insert({
      stack_id: stackId,
      container_id: containerId,
      container_name: container.containerName,
      image: `${container.image}:${container.imageTag}`,
      old_digest: container.currentDigest,
      new_digest: container.latestDigest,
      status: 'pulling',
      triggered_by: triggeredBy,
    }).returning('*') as HistoryRow[];

    const historyId = historyRow.id;

    try {
      // Update status
      await stackService.updateContainerStatus(containerId, 'updating');
      if (_io) {
        _io.emit(SOCKET_EVENTS.UPDATE_PROGRESS, {
          stackId, containerId, phase: 'pulling',
          message: `Pulling ${container.image}:${container.imageTag}...`,
        });
      }

      // Check if this is a self-update (our own container)
      const selfId = dockerService.getSelfContainerId();
      const isSelfUpdate = selfId !== null && container.dockerId === selfId;

      if (isSelfUpdate) {
        logger.info({ containerId, containerName: container.containerName }, 'Self-update detected — using special self-update path');
        await db('update_history').where({ id: historyId }).update({ status: 'recreating' });
        if (_io) {
          _io.emit(SOCKET_EVENTS.UPDATE_PROGRESS, {
            stackId, containerId, phase: 'self_update',
            message: 'Self-updating Oblihub — the service will restart momentarily...',
          });
        }
        // selfUpdate pulls, renames, creates new, starts it, then exits this process
        await dockerService.selfUpdate(container.image, container.imageTag);
        // We never reach here — process.exit() is called inside selfUpdate
        return;
      }

      // 1. Pull new image
      await dockerService.pullImage(container.image, container.imageTag);

      // Update history
      await db('update_history').where({ id: historyId }).update({ status: 'recreating' });
      if (_io) {
        _io.emit(SOCKET_EVENTS.UPDATE_PROGRESS, {
          stackId, containerId, phase: 'recreating',
          message: `Recreating ${container.containerName}...`,
        });
      }

      // 2. Recreate container
      const newDockerId = await dockerService.recreateContainer(
        container.dockerId,
        container.image,
        container.imageTag,
      );

      // 3. Get new digest
      const newDigest = await dockerService.getLocalDigest(`${container.image}:${container.imageTag}`);

      // 4. Update DB
      await stackService.updateContainerDockerId(containerId, newDockerId);
      await stackService.updateContainerStatus(containerId, 'up_to_date', newDigest, newDigest);

      // 5. Complete history
      await db('update_history').where({ id: historyId }).update({
        status: 'success',
        new_digest: newDigest,
        completed_at: new Date(),
      });

      if (_io) {
        _io.emit(SOCKET_EVENTS.UPDATE_COMPLETE, {
          stackId, containerId, success: true,
        });
      }

      logger.info({ containerId, containerName: container.containerName }, 'Container updated successfully');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ containerId, err }, 'Container update failed');

      await db('update_history').where({ id: historyId }).update({
        status: 'failed',
        error_message: errorMsg,
        completed_at: new Date(),
      });

      await stackService.updateContainerStatus(containerId, 'error', null, null, errorMsg);

      if (_io) {
        _io.emit(SOCKET_EVENTS.UPDATE_COMPLETE, {
          stackId, containerId, success: false, error: errorMsg,
        });
      }
    }
  },

  /** Get update history for a stack */
  async getHistory(stackId: number, limit: number = 50, offset: number = 0): Promise<UpdateHistoryEntry[]> {
    const rows = await db<HistoryRow>('update_history')
      .where({ stack_id: stackId })
      .orderBy('started_at', 'desc')
      .limit(limit)
      .offset(offset);
    return rows.map(rowToHistory);
  },

  /** Get all update history */
  async getAllHistory(limit: number = 100): Promise<UpdateHistoryEntry[]> {
    const rows = await db<HistoryRow>('update_history')
      .orderBy('started_at', 'desc')
      .limit(limit);
    return rows.map(rowToHistory);
  },
};
