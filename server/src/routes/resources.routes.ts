import { Router } from 'express';
import os from 'node:os';
import { db } from '../db';
import { requireAuth } from '../middleware/auth';
import { stackService } from '../services/stack.service';
import { detectGpus, getGpuLiveStats, getCurrentPowerLimits, setPowerLimit } from '../services/gpuDetection.service';
import { hostStatsService } from '../services/hostStats.service';
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

    const [hostGpus, liveGpus, currentPowerLimits, stacks, hostSnap] = await Promise.all([
      detectGpus(),
      getGpuLiveStats(),
      getCurrentPowerLimits(),
      stackService.getAll(),
      hostStatsService.get(),
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
          // From hostStatsService.get() — model name from /proc/cpuinfo, temp best-effort via
          // /sys/class/thermal. Null on VMs / hosts where the thermal zone doesn't exist.
          cpuModel: hostSnap.cpu.model,
          cpuTemperatureCelsius: hostSnap.cpu.temperatureCelsius,
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

/**
 * PUT /api/resources/gpus/:index/power-limit
 * Body: { watts: number }
 *
 * Host-wide GPU power limit. Not tied to any stack — the underlying nvidia-smi -pl call
 * affects any container using this GPU. Placed on the Resources dashboard so the operator
 * always knows they're editing global state, not the stack they happened to be on. Per-stack
 * Resources tab shows the applied value as read-only.
 */
router.put('/gpus/:index/power-limit', async (req, res, next) => {
  try {
    const index = String(req.params.index || '').trim();
    const watts = Number((req.body || {}).watts);
    if (!index) { res.status(400).json({ success: false, error: 'gpu index required' }); return; }
    if (!Number.isFinite(watts) || watts <= 0) { res.status(400).json({ success: false, error: 'watts must be a positive number' }); return; }

    // Bounds check against detected min/max — nvidia-smi accepts silently and returns a driver
    // error at apply time otherwise, which is a worse UX than a crisp 400.
    const catalog = await detectGpus();
    const gpu = catalog.find(g => g.index === index);
    if (!gpu) { res.status(404).json({ success: false, error: `GPU ${index} not detected` }); return; }
    const minW = Math.max(1, Math.round(gpu.powerLimitMinWatts));
    const maxW = Math.max(minW + 1, Math.round(gpu.powerLimitMaxWatts));
    if (watts < minW || watts > maxW) {
      res.status(400).json({ success: false, error: `watts must be within ${minW}–${maxW} for GPU ${index}` });
      return;
    }

    const result = await setPowerLimit(index, watts);
    if (!result.ok) {
      res.status(500).json({ success: false, error: result.error || 'nvidia-smi -pl failed' });
      return;
    }
    // Return the fresh applied value so the UI can reflect what actually stuck (nvidia-smi may
    // clamp differently than the request in edge cases).
    const current = await getCurrentPowerLimits();
    res.json({ success: true, data: { index, watts: current[index] ?? watts } });
  } catch (err) { next(err); }
});

export default router;
