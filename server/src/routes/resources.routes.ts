import { Router } from 'express';
import os from 'node:os';
import { db } from '../db';
import { requireAuth } from '../middleware/auth';
import { stackService } from '../services/stack.service';
import { detectGpus, getGpuLiveStats, getCurrentPowerLimits } from '../services/gpuDetection.service';
import { snapshotActivity } from '../state/criticalActivity.state';
import { getYieldedStackIds } from '../workers/PriorityWatchdogWorker';
import { logger } from '../utils/logger';
import type { StackPriority, YieldSignalSource, ResourceLimits, Stack } from '@oblihub/shared';

const router = Router();
router.use(requireAuth);

interface StatsRow {
  container_docker_id: string;
  cpu_percent: number;
  memory_usage: string | number;
  memory_limit: string | number;
  timestamp: Date;
}

interface DashStackConso {
  cpuPercentOfHost: number;   // sum of container cpu% (0..100 per core, so /host cores gives % of host)
  cpuPercentOfCap: number | null;  // vs cpuPercent cap when set
  ramBytes: number;
  ramPercentOfHost: number;
  ramPercentOfCap: number | null;  // vs ramPercent cap when set
}

interface DashStack {
  id: number;
  name: string;
  composeProject: string | null;
  priority: StackPriority;
  state: 'running' | 'paused-by-watchdog' | 'stopped' | 'mixed';
  containerCount: number;
  runningContainerCount: number;
  cpuCapPercent: number | null;
  ramCapPercent: number | null;
  cpuShares: number | null;
  visibleGpuIds: string[] | null;
  yieldSignalSource: YieldSignalSource | null;
  yieldsToStackIds: number[] | null;
  yieldIdleTimeoutSeconds: number | null;
  isBusyNow: boolean | null;      // Critical only — else null
  conso: DashStackConso;
}

/** GET /api/resources/dashboard — single aggregate call for the live dashboard. */
router.get('/dashboard', async (_req, res, next) => {
  try {
    const cpuCount = os.cpus().length;
    const totalRam = os.totalmem();

    const [hostGpus, liveGpus, currentPowerLimits, stacks] = await Promise.all([
      detectGpus(),
      getGpuLiveStats(),
      getCurrentPowerLimits(),
      stackService.getAll(),
    ]);

    // Latest container_stats row per docker_id — one query, fold in memory.
    const rows = await db<StatsRow>('container_stats')
      .select('container_docker_id', 'cpu_percent', 'memory_usage', 'memory_limit', 'timestamp')
      .where('timestamp', '>', new Date(Date.now() - 5 * 60 * 1000))
      .orderBy('timestamp', 'desc');
    const latestByDocker = new Map<string, StatsRow>();
    for (const r of rows) {
      if (!latestByDocker.has(r.container_docker_id)) latestByDocker.set(r.container_docker_id, r);
    }

    const activity = snapshotActivity();
    const yieldedIds = getYieldedStackIds();
    const busyWindowMs = 60_000;  // Dashboard "busy right now" indicator window.
    const now = Date.now();

    const dashStacks: DashStack[] = stacks.map((s: Stack) => {
      const limits: ResourceLimits | null = s.resourceLimits;
      const priority: StackPriority = limits?.priority ?? 'normal';

      let cpuSum = 0;
      let ramSum = 0;
      let running = 0;
      let anyRunning = false;
      let anyStopped = false;
      for (const c of s.containers) {
        const stat = latestByDocker.get(c.dockerId);
        if (stat) {
          cpuSum += Number(stat.cpu_percent) || 0;
          ramSum += Number(stat.memory_usage) || 0;
        }
        // status 'stopped' | 'excluded' — treat 'stopped' as stopped, others as running-ish.
        if (c.status === 'stopped') anyStopped = true;
        else { anyRunning = true; running++; }
      }

      // Docker cpu_percent is already "of one core" scaled; sum can exceed 100. Convert to % of
      // the whole host so the bar caps at 100.
      const cpuPercentOfHost = cpuCount > 0 ? Math.min(100, cpuSum / cpuCount) : 0;
      const ramPercentOfHost = totalRam > 0 ? Math.min(100, (ramSum / totalRam) * 100) : 0;

      const cpuCapPercent = limits?.cpuPercent ?? null;
      const ramCapPercent = limits?.ramPercent ?? null;

      const cpuPercentOfCap = cpuCapPercent != null && cpuCapPercent > 0
        ? Math.min(100, (cpuPercentOfHost / cpuCapPercent) * 100)
        : null;
      const ramPercentOfCap = ramCapPercent != null && ramCapPercent > 0
        ? Math.min(100, (ramPercentOfHost / ramCapPercent) * 100)
        : null;

      let state: DashStack['state'];
      if (yieldedIds.has(s.id)) state = 'paused-by-watchdog';
      else if (!anyRunning && anyStopped) state = 'stopped';
      else if (anyRunning && anyStopped) state = 'mixed';
      else state = 'running';

      const isBusyNow = priority === 'critical'
        ? (typeof activity[s.id] === 'number' && (now - activity[s.id]) < busyWindowMs)
        : null;

      return {
        id: s.id,
        name: s.name,
        composeProject: s.composeProject,
        priority,
        state,
        containerCount: s.containers.length,
        runningContainerCount: running,
        cpuCapPercent,
        ramCapPercent,
        cpuShares: limits?.cpuShares ?? null,
        visibleGpuIds: limits?.visibleGpuIds ?? null,
        yieldSignalSource: limits?.yieldSignalSource ?? null,
        yieldsToStackIds: limits?.yieldsToStackIds ?? null,
        yieldIdleTimeoutSeconds: limits?.yieldIdleTimeoutSeconds ?? null,
        isBusyNow,
        conso: {
          cpuPercentOfHost,
          cpuPercentOfCap,
          ramBytes: ramSum,
          ramPercentOfHost,
          ramPercentOfCap,
        },
      };
    });

    res.json({
      success: true,
      data: {
        host: {
          cpuCount,
          ramBytes: totalRam,
          ramGb: Math.round(totalRam / (1024 ** 3)),
          gpus: hostGpus,
          gpuLive: liveGpus,
          currentPowerLimits,
          platform: process.platform,
          arch: process.arch,
        },
        stacks: dashStacks,
        activity,
      },
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'dashboard aggregation failed');
    next(err);
  }
});

export default router;
