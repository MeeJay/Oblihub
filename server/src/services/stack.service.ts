import { db } from '../db';
import type { Stack, Container, ContainerStatus } from '@oblihub/shared';
import type { DiscoveredContainer } from './docker.service';
import { logger } from '../utils/logger';

interface StackRow {
  id: number;
  name: string;
  compose_project: string | null;
  check_interval: number;
  auto_update: boolean;
  enabled: boolean;
  url: string | null;
  notify_update_available: boolean | null;
  notify_update_applied: boolean | null;
  notify_delay: number | null;
  last_checked_at: Date | null;
  last_updated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ContainerRow {
  id: number;
  stack_id: number | null;
  docker_id: string;
  container_name: string;
  image: string;
  image_tag: string;
  current_digest: string | null;
  latest_digest: string | null;
  status: string;
  error_message: string | null;
  excluded: boolean;
  container_config: unknown;
  last_checked_at: Date | null;
  last_updated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowToContainer(row: ContainerRow): Container {
  return {
    id: row.id,
    stackId: row.stack_id,
    dockerId: row.docker_id,
    containerName: row.container_name,
    image: row.image,
    imageTag: row.image_tag,
    currentDigest: row.current_digest,
    latestDigest: row.latest_digest,
    status: row.status as ContainerStatus,
    errorMessage: row.error_message,
    excluded: row.excluded,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    lastUpdatedAt: row.last_updated_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function rowToStack(row: StackRow, containers: Container[] = []): Stack {
  return {
    id: row.id,
    name: row.name,
    composeProject: row.compose_project,
    checkInterval: row.check_interval,
    autoUpdate: row.auto_update,
    enabled: row.enabled,
    url: row.url || null,
    notifyUpdateAvailable: row.notify_update_available ?? null,
    notifyUpdateApplied: row.notify_update_applied ?? null,
    notifyDelay: row.notify_delay ?? null,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    lastUpdatedAt: row.last_updated_at?.toISOString() ?? null,
    containers,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const stackService = {
  /**
   * Synchronize database with live Docker state.
   * Creates stacks for new compose projects, creates/updates container records.
   */
  async syncWithDocker(discovered: DiscoveredContainer[]): Promise<void> {
    // Group by compose project
    const projectGroups = new Map<string | null, DiscoveredContainer[]>();
    for (const c of discovered) {
      const key = c.composeProject;
      if (!projectGroups.has(key)) projectGroups.set(key, []);
      projectGroups.get(key)!.push(c);
    }

    // Ensure stacks exist for each compose project
    for (const [project, containers] of projectGroups) {
      let stackId: number;

      if (project) {
        // Named compose project
        let stack = await db<StackRow>('stacks').where({ compose_project: project }).first();
        if (!stack) {
          const [newStack] = await db<StackRow>('stacks')
            .insert({ name: project, compose_project: project })
            .returning('*');
          stack = newStack;
          logger.info({ project, stackId: stack.id }, 'New stack discovered');
        }
        stackId = stack.id;
      } else {
        // Standalone containers — use a synthetic "Standalone" stack
        let stack = await db<StackRow>('stacks').whereNull('compose_project').first();
        if (!stack) {
          const [newStack] = await db<StackRow>('stacks')
            .insert({ name: 'Standalone', compose_project: null })
            .returning('*');
          stack = newStack;
        }
        stackId = stack.id;
      }

      // Upsert containers
      for (const c of containers) {
        const isStopped = c.state !== 'running';
        const existing = await db<ContainerRow>('containers').where({ docker_id: c.dockerId }).first();
        if (existing) {
          const update: Record<string, unknown> = {
            stack_id: stackId,
            container_name: c.containerName,
            image: c.image,
            image_tag: c.imageTag,
            updated_at: new Date(),
          };
          // Track stopped/running state transitions
          if (isStopped && existing.status !== 'excluded') {
            update.status = 'stopped';
          } else if (!isStopped && existing.status === 'stopped') {
            update.status = 'unknown'; // back to running, will be checked next cycle
          }
          await db('containers').where({ id: existing.id }).update(update);
        } else {
          await db('containers').insert({
            stack_id: stackId,
            docker_id: c.dockerId,
            container_name: c.containerName,
            image: c.image,
            image_tag: c.imageTag,
            status: isStopped ? 'stopped' : 'unknown',
          });
          logger.info({ containerName: c.containerName, stackId }, 'New container discovered');
        }
      }
    }

    // Remove containers that no longer exist in Docker at all
    const liveDockerIds = discovered.map(c => c.dockerId);
    if (liveDockerIds.length > 0) {
      await db('containers')
        .whereNotIn('docker_id', liveDockerIds)
        .whereNot('status', 'excluded')
        .delete();
    }

    // Clean up empty stacks (no containers left) except Standalone
    const allStacks = await db<StackRow>('stacks').select('id', 'compose_project');
    for (const s of allStacks) {
      const count = await db('containers').where({ stack_id: s.id }).count('* as cnt').first();
      if (Number(count?.cnt) === 0) {
        await db('stacks').where({ id: s.id }).delete();
        logger.info({ stackId: s.id, project: s.compose_project }, 'Cleaned up empty stack');
      }
    }
  },

  /** Get all stacks with their containers */
  async getAll(): Promise<Stack[]> {
    const stackRows = await db<StackRow>('stacks').orderBy('name');
    const containerRows = await db<ContainerRow>('containers').orderBy('container_name');

    const containersByStack = new Map<number, Container[]>();
    for (const row of containerRows) {
      const c = rowToContainer(row);
      if (c.stackId) {
        if (!containersByStack.has(c.stackId)) containersByStack.set(c.stackId, []);
        containersByStack.get(c.stackId)!.push(c);
      }
    }

    return stackRows.map(row => rowToStack(row, containersByStack.get(row.id) || []));
  },

  /** Get a single stack with containers */
  async getById(id: number): Promise<Stack | null> {
    const row = await db<StackRow>('stacks').where({ id }).first();
    if (!row) return null;
    const containerRows = await db<ContainerRow>('containers').where({ stack_id: id }).orderBy('container_name');
    return rowToStack(row, containerRows.map(rowToContainer));
  },

  /** Update stack config */
  async update(id: number, data: { name?: string; checkInterval?: number; autoUpdate?: boolean; enabled?: boolean; url?: string | null; notifyUpdateAvailable?: boolean | null; notifyUpdateApplied?: boolean | null; notifyDelay?: number | null }): Promise<Stack | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.checkInterval !== undefined) update.check_interval = data.checkInterval;
    if (data.autoUpdate !== undefined) update.auto_update = data.autoUpdate;
    if (data.enabled !== undefined) update.enabled = data.enabled;
    if (data.url !== undefined) update.url = data.url;
    if (data.notifyUpdateAvailable !== undefined) update.notify_update_available = data.notifyUpdateAvailable;
    if (data.notifyUpdateApplied !== undefined) update.notify_update_applied = data.notifyUpdateApplied;
    if (data.notifyDelay !== undefined) update.notify_delay = data.notifyDelay;
    await db('stacks').where({ id }).update(update);
    return this.getById(id);
  },

  /** Delete a stack, its containers, and its history from the database */
  async delete(id: number): Promise<void> {
    await db('update_history').where({ stack_id: id }).delete();
    await db('containers').where({ stack_id: id }).delete();
    await db('notification_bindings').where({ scope: 'stack', scope_id: id }).delete();
    await db('stacks').where({ id }).delete();
  },

  /** Update container status */
  async updateContainerStatus(containerId: number, status: ContainerStatus, latestDigest?: string | null, currentDigest?: string | null, errorMessage?: string | null): Promise<void> {
    const update: Record<string, unknown> = { status, updated_at: new Date(), last_checked_at: new Date() };
    if (latestDigest !== undefined) update.latest_digest = latestDigest;
    if (currentDigest !== undefined) update.current_digest = currentDigest;
    if (errorMessage !== undefined) update.error_message = errorMessage;
    await db('containers').where({ id: containerId }).update(update);
  },

  /** Toggle container excluded flag */
  async setExcluded(containerId: number, excluded: boolean): Promise<void> {
    await db('containers').where({ id: containerId }).update({
      excluded,
      status: excluded ? 'excluded' : 'unknown',
      updated_at: new Date(),
    });
  },

  /** Get container by ID */
  async getContainerById(id: number): Promise<Container | null> {
    const row = await db<ContainerRow>('containers').where({ id }).first();
    return row ? rowToContainer(row) : null;
  },

  /** Get container by Docker ID */
  async getContainerByDockerId(dockerId: string): Promise<Container | null> {
    const row = await db<ContainerRow>('containers').where({ docker_id: dockerId }).first();
    return row ? rowToContainer(row) : null;
  },

  /** Update stack last_checked_at */
  async markChecked(stackId: number): Promise<void> {
    await db('stacks').where({ id: stackId }).update({ last_checked_at: new Date() });
  },

  /** Update stack last_updated_at */
  async markUpdated(stackId: number): Promise<void> {
    await db('stacks').where({ id: stackId }).update({ last_updated_at: new Date() });
  },

  /** Update container docker_id after recreation */
  async updateContainerDockerId(containerId: number, newDockerId: string): Promise<void> {
    await db('containers').where({ id: containerId }).update({ docker_id: newDockerId, updated_at: new Date() });
  },
};
