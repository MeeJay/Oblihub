import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../utils/logger';
import { db } from '../db';
import { markCriticalBusy } from '../state/criticalActivity.state';
import type { ResourceLimits } from '@oblihub/shared';

/**
 * GpuUtilPoller — every 2s polls `nvidia-smi --query-gpu=utilization.gpu,utilization.memory` and
 * stamps busy state on Critical stacks whose `visibleGpuIds` contain a GPU currently above the
 * utilisation threshold.
 *
 * Only Critical stacks with `yieldSignalSource === 'gpu-util'` are considered — the map from
 * "yields to" isn't inverted here because writing to the shared state is keyed by the Critical
 * stack ID. The watchdog already handles the fan-out (any Opportunistic that yields to that
 * Critical will pick up the stamped timestamp).
 *
 * Threshold and interval are constants for phase D; can be promoted to app_config later.
 */

const execFileP = promisify(execFile);

const POLL_INTERVAL_MS = 2_000;
const REFRESH_INTERVAL_MS = 30_000;
const UTIL_THRESHOLD_PERCENT = 20;

interface CriticalGpuBinding {
  stackId: number;
  visibleGpuIds: Set<string> | null; // null → all GPUs
}

let bindings: CriticalGpuBinding[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function refreshBindings(): Promise<void> {
  const rows = await db('stacks')
    .whereNotNull('resource_limits')
    .select('id', 'resource_limits');
  const next: CriticalGpuBinding[] = [];
  for (const row of rows as Array<{ id: number; resource_limits: unknown }>) {
    let limits: ResourceLimits | null = null;
    try {
      limits = typeof row.resource_limits === 'string'
        ? JSON.parse(row.resource_limits) as ResourceLimits
        : row.resource_limits as ResourceLimits;
    } catch { continue; }
    if (!limits) continue;
    if (limits.priority !== 'critical') continue;
    if (limits.yieldSignalSource !== 'gpu-util') continue;
    next.push({
      stackId: row.id,
      visibleGpuIds: limits.visibleGpuIds && limits.visibleGpuIds.length > 0
        ? new Set(limits.visibleGpuIds.map(String))
        : (limits.visibleGpuIds === null ? null : new Set()), // [] → empty set (matches nothing)
    });
  }
  bindings = next;
}

async function readGpuUtil(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const { stdout } = await execFileP(
      'nvidia-smi',
      ['--query-gpu=index,utilization.gpu,utilization.memory', '--format=csv,noheader,nounits'],
      { timeout: 5_000 },
    );
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split(',').map(p => p.trim());
      if (parts.length < 3) continue;
      const idx = parts[0];
      const gpuUtil = parseFloat(parts[1]);
      const memUtil = parseFloat(parts[2]);
      // Take the higher of the two — an inference workload may be VRAM-bound and idle-compute.
      const util = Math.max(
        Number.isFinite(gpuUtil) ? gpuUtil : 0,
        Number.isFinite(memUtil) ? memUtil : 0,
      );
      out.set(idx, util);
    }
  } catch {
    // nvidia-smi missing or errored — return empty map, poll silently until it recovers.
  }
  return out;
}

async function pollOnce(): Promise<void> {
  if (bindings.length === 0) return;
  const utils = await readGpuUtil();
  if (utils.size === 0) return;
  const now = Date.now();
  for (const b of bindings) {
    let hit = false;
    if (b.visibleGpuIds == null) {
      // Sees all GPUs — any one being busy counts.
      for (const util of utils.values()) {
        if (util > UTIL_THRESHOLD_PERCENT) { hit = true; break; }
      }
    } else {
      for (const idx of b.visibleGpuIds) {
        const util = utils.get(idx);
        if (util != null && util > UTIL_THRESHOLD_PERCENT) { hit = true; break; }
      }
    }
    if (hit) markCriticalBusy(b.stackId, now);
  }
}

export function startGpuUtilPoller(): void {
  if (running) return;
  running = true;
  logger.info({ intervalMs: POLL_INTERVAL_MS, thresholdPercent: UTIL_THRESHOLD_PERCENT }, 'Starting GPU utilization poller');
  refreshBindings().catch(err => logger.warn({ err }, 'GpuUtilPoller initial bindings refresh failed'));
  pollTimer = setInterval(() => {
    pollOnce().catch(err => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'GpuUtilPoller poll failed'));
  }, POLL_INTERVAL_MS);
  refreshTimer = setInterval(() => {
    refreshBindings().catch(err => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'GpuUtilPoller bindings refresh failed'));
  }, REFRESH_INTERVAL_MS);
}

export function stopGpuUtilPoller(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  running = false;
}

export const __test_only = { refreshBindings, pollOnce };
