import { db } from '../db';
import type { Stack, Container, ContainerStatus, SleepMode, SleepState, ResourceLimits } from '@oblihub/shared';
import { dockerService, type DiscoveredContainer } from './docker.service';
import { logger } from '../utils/logger';
import { writeStackOverride, removeStackOverride, applyStackOverride } from './resourceOverride.service';
import { setPowerLimit } from './gpuDetection.service';

interface StackRow {
  id: number;
  name: string;
  compose_project: string | null;
  engine_id: number | null;
  check_interval: number;
  auto_update: boolean;
  enabled: boolean;
  url: string | null;
  notify_update_available: boolean | null;
  notify_update_applied: boolean | null;
  notify_delay: number | null;
  last_checked_at: Date | null;
  last_updated_at: Date | null;
  resource_limits: unknown;
  created_at: Date;
  updated_at: Date;
}

interface ContainerRow {
  id: number;
  stack_id: number | null;
  engine_id: number | null;
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
  ports: unknown;
  last_checked_at: Date | null;
  last_updated_at: Date | null;
  sleep_enabled: boolean;
  sleep_after_seconds: number;
  sleep_mode: string;
  last_active_at: Date | null;
  sleep_state: string;
  wake_started_at: Date | null;
  wake_health_path: string | null;
  wake_durations_ms: number[] | string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToContainer(row: ContainerRow): Container {
  let ports: Container['ports'] = [];
  if (row.ports) {
    try {
      ports = typeof row.ports === 'string' ? JSON.parse(row.ports) : (row.ports as Container['ports']);
      if (!Array.isArray(ports)) ports = [];
    } catch { ports = []; }
  }
  return {
    id: row.id,
    stackId: row.stack_id,
    engineId: row.engine_id,
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
    ports,
    sleepEnabled: row.sleep_enabled,
    sleepAfterSeconds: row.sleep_after_seconds,
    sleepMode: row.sleep_mode as SleepMode,
    sleepState: row.sleep_state as SleepState,
    lastActiveAt: row.last_active_at?.toISOString() ?? null,
    wakeStartedAt: row.wake_started_at?.toISOString() ?? null,
    wakeHealthPath: row.wake_health_path,
    wakeDurationsMs: ((): number[] => {
      const raw = row.wake_durations_ms;
      if (Array.isArray(raw)) return raw as number[];
      if (typeof raw === 'string' && raw) { try { return JSON.parse(raw) as number[]; } catch { return []; } }
      return [];
    })(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function parseResourceLimits(raw: unknown): ResourceLimits | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as ResourceLimits; } catch { return null; }
  }
  if (typeof raw === 'object') return raw as ResourceLimits;
  return null;
}

function rowToStack(row: StackRow, containers: Container[] = []): Stack {
  return {
    id: row.id,
    name: row.name,
    composeProject: row.compose_project,
    engineId: row.engine_id,
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
    resourceLimits: parseResourceLimits(row.resource_limits),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const stackService = {
  /**
   * Synchronize database with live Docker state for ONE engine.
   * Stacks and containers are scoped by `engineId` — a sync of engine A never touches engine B's rows.
   * Docker IDs are 12-char prefixes and can theoretically collide across engines, so the (engine_id, docker_id)
   * pair is used for lookups.
   */
  async syncWithDocker(discovered: DiscoveredContainer[], engineId: number): Promise<void> {
    // Group by compose project
    const projectGroups = new Map<string | null, DiscoveredContainer[]>();
    for (const c of discovered) {
      const key = c.composeProject;
      if (!projectGroups.has(key)) projectGroups.set(key, []);
      projectGroups.get(key)!.push(c);
    }

    // Ensure stacks exist for each compose project (scoped to this engine)
    for (const [project, containers] of projectGroups) {
      let stackId: number;

      if (project) {
        let stack = await db<StackRow>('stacks').where({ compose_project: project, engine_id: engineId }).first();
        if (!stack) {
          // Adopt an orphan row before creating a fresh one — an orphan is a `stacks` entry
          // for this compose_project with `engine_id=null` (typically a pre-created row from
          // the non-admin create flow before engine_id propagation was fixed). Adopting keeps
          // the team_id/errorMessage/etc. and lets the row now serve as the discovered stack.
          const orphan = await db<StackRow>('stacks').where({ compose_project: project }).whereNull('engine_id').first();
          if (orphan) {
            await db('stacks').where({ id: orphan.id }).update({ engine_id: engineId });
            stack = { ...orphan, engine_id: engineId };
            logger.info({ project, stackId: stack.id, engineId }, 'Adopted orphan stack row (was engine_id=null)');
          } else {
            const [newStack] = await db<StackRow>('stacks')
              .insert({ name: project, compose_project: project, engine_id: engineId })
              .returning('*');
            stack = newStack;
            logger.info({ project, stackId: stack.id, engineId }, 'New stack discovered');
          }
        }
        stackId = stack.id;
      } else {
        // Per-engine synthetic "Standalone" stack
        let stack = await db<StackRow>('stacks').whereNull('compose_project').where({ engine_id: engineId }).first();
        if (!stack) {
          const [newStack] = await db<StackRow>('stacks')
            .insert({ name: 'Standalone', compose_project: null, engine_id: engineId })
            .returning('*');
          stack = newStack;
        }
        stackId = stack.id;
      }

      // Upsert containers — match on (docker_id, engine_id)
      for (const c of containers) {
        const isStopped = c.state !== 'running';
        const existing = await db<ContainerRow>('containers').where({ docker_id: c.dockerId, engine_id: engineId }).first();
        const portsJson = JSON.stringify(c.ports || []);
        if (existing) {
          const update: Record<string, unknown> = {
            stack_id: stackId,
            container_name: c.containerName,
            image: c.image,
            image_tag: c.imageTag,
            ports: portsJson,
            updated_at: new Date(),
          };
          // If the container is sleeping (we stopped it on purpose), don't overwrite the sleep state.
          // Discovery sees it as 'stopped' but the sleep_state row tells the real story.
          if (isStopped && existing.status !== 'excluded' && existing.sleep_state !== 'sleeping') {
            update.status = 'stopped';
          } else if (!isStopped && existing.status === 'stopped') {
            update.status = 'unknown';
          }
          await db('containers').where({ id: existing.id }).update(update);
        } else {
          await db('containers').insert({
            stack_id: stackId,
            engine_id: engineId,
            docker_id: c.dockerId,
            container_name: c.containerName,
            image: c.image,
            image_tag: c.imageTag,
            status: isStopped ? 'stopped' : 'unknown',
            ports: portsJson,
          });
          logger.info({ containerName: c.containerName, stackId, engineId }, 'New container discovered');
        }
      }
    }

    // Remove containers that no longer exist on this engine
    const liveDockerIds = discovered.map(c => c.dockerId);
    if (liveDockerIds.length > 0) {
      await db('containers')
        .where({ engine_id: engineId })
        .whereNotIn('docker_id', liveDockerIds)
        .whereNot('status', 'excluded')
        .delete();
    }

    // Clean up empty stacks for this engine
    const engineStacks = await db<StackRow>('stacks').where({ engine_id: engineId }).select('id', 'compose_project');
    for (const s of engineStacks) {
      const count = await db('containers').where({ stack_id: s.id }).count('* as cnt').first();
      if (Number(count?.cnt) === 0) {
        await db('stacks').where({ id: s.id }).delete();
        logger.info({ stackId: s.id, project: s.compose_project, engineId }, 'Cleaned up empty stack');
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

  /** Read the resource_limits blob for one stack. */
  async getResourceLimits(stackId: number): Promise<ResourceLimits | null> {
    const row = await db<StackRow>('stacks').where({ id: stackId }).first();
    if (!row) return null;
    return parseResourceLimits(row.resource_limits);
  },

  /**
   * Persist resource limits, regenerate the compose override, re-apply the stack, and push any
   * requested per-GPU power caps to the host.
   *
   * The stack's folder is derived from its compose_project label — that's where discovery
   * expects `docker-compose.yml` to live. Standalone (project=null) stacks can't be capped this
   * way because they have no compose file; callers should skip them at the route level.
   *
   * Non-fatal failures (missing folder, docker compose error, nvidia-smi missing) are logged and
   * swallowed so the DB write survives — the operator can retry from the UI.
   */
  async setResourceLimits(
    stackId: number,
    limits: ResourceLimits,
  ): Promise<{ powerLimitErrors: { gpuIndex: string; watts: number; error: string }[] }> {
    const powerLimitErrors: { gpuIndex: string; watts: number; error: string }[] = [];
    await db('stacks').where({ id: stackId }).update({
      resource_limits: JSON.stringify(limits),
      updated_at: new Date(),
    });

    const stack = await this.getById(stackId);
    if (!stack) return { powerLimitErrors };

    if (stack.composeProject) {
      // Read the exact compose service names from docker labels (com.docker.compose.service).
      // Container names can diverge arbitrarily from the compose_project prefix — an image that
      // sets container_name explicitly (e.g. compose project 'suricata-v' running a container
      // named 'jetski-miner-v' as service 'miner') breaks the old strip-project-prefix heuristic
      // and would target a non-existent service in the override, silently ignored by compose.
      // Live-inspect is cheap (only fires on Save) and always reflects reality.
      const serviceNamesSet = new Set<string>();
      for (const c of stack.containers) {
        try {
          const info = await dockerService.inspectContainer(c.dockerId, c.engineId);
          const svc = info.Config?.Labels?.['com.docker.compose.service'];
          if (svc) serviceNamesSet.add(svc);
        } catch (err) {
          logger.debug({ stackId, dockerId: c.dockerId, err }, 'inspect for compose.service label failed — skipping this container');
        }
      }
      const serviceNames = Array.from(serviceNamesSet);
      if (serviceNames.length === 0) {
        logger.warn({ stackId, composeProject: stack.composeProject }, 'No com.docker.compose.service labels found on any container — override would target nothing, skipping write');
      } else {
        try {
          await writeStackOverride(stack.composeProject, serviceNames, limits);
          const result = await applyStackOverride(stack.composeProject);
          if (!result.ok) {
            logger.warn({ stackId, stderr: result.stderr }, 'Applying compose override failed');
          }
        } catch (err) {
          logger.warn({ stackId, err }, 'writeStackOverride failed');
        }
      }
    } else {
      logger.info({ stackId }, 'Standalone stack — resource_limits stored but no compose override written');
    }

    if (limits.powerLimitWatts) {
      for (const [idx, watts] of Object.entries(limits.powerLimitWatts)) {
        const res = await setPowerLimit(idx, watts);
        if (!res.ok) {
          logger.warn({ stackId, gpuIndex: idx, watts, error: res.error }, 'setPowerLimit failed');
          powerLimitErrors.push({ gpuIndex: idx, watts, error: res.error || 'unknown error' });
        }
      }
    }
    return { powerLimitErrors };
  },

  /**
   * List every Opportunistic stack that yields to at least one other stack — the input the
   * priority watchdog needs to decide which stacks to pause/resume on Critical traffic. Shape is
   * kept minimal (id / composeProject / engineId / limits) so the watchdog doesn't accidentally
   * become a full stack-hydration hotspot when it re-reads this every 30s.
   */
  async getOpportunisticStacksWithYields(): Promise<Array<{
    id: number;
    composeProject: string | null;
    engineId: number | null;
    resourceLimits: ResourceLimits;
  }>> {
    const rows = await db<StackRow>('stacks').whereNotNull('resource_limits');
    const out: Array<{ id: number; composeProject: string | null; engineId: number | null; resourceLimits: ResourceLimits }> = [];
    for (const row of rows) {
      const limits = parseResourceLimits(row.resource_limits);
      if (!limits) continue;
      if (limits.priority !== 'opportunistic') continue;
      if (!limits.yieldsToStackIds || limits.yieldsToStackIds.length === 0) continue;
      out.push({
        id: row.id,
        composeProject: row.compose_project,
        engineId: row.engine_id,
        resourceLimits: limits,
      });
    }
    return out;
  },

  /**
   * Reverse-lookup for the watchdog: given a batch of proxy_host_ids seen in the traffic log,
   * return a Map[proxy_host_id → stack_id] for every host row that has a stack link. Rows whose
   * `stack_id` is null are omitted — a proxy_host with no owning stack can't trigger yielding.
   */
  async getStackIdsByProxyHostIds(proxyHostIds: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (proxyHostIds.length === 0) return out;
    const rows = await db('proxy_hosts')
      .whereIn('id', proxyHostIds)
      .whereNotNull('stack_id')
      .select('id', 'stack_id');
    for (const r of rows as Array<{ id: number; stack_id: number }>) out.set(r.id, r.stack_id);
    return out;
  },

  /** Nullify the column, unlink the override file, and re-apply the plain compose file. */
  async clearResourceLimits(stackId: number): Promise<void> {
    const stack = await this.getById(stackId);
    await db('stacks').where({ id: stackId }).update({
      resource_limits: null,
      updated_at: new Date(),
    });
    if (stack?.composeProject) {
      try {
        await removeStackOverride(stack.composeProject);
        const result = await applyStackOverride(stack.composeProject);
        if (!result.ok) {
          logger.warn({ stackId, stderr: result.stderr }, 'Re-applying plain compose failed after clear');
        }
      } catch (err) {
        logger.warn({ stackId, err }, 'clearResourceLimits cleanup failed');
      }
    }
  },
};
