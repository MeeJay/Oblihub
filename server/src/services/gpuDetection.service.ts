import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GpuInfo } from '@oblihub/shared';
import { logger } from '../utils/logger';

const execFileP = promisify(execFile);

const CACHE_MS = 60_000;
let cache: { at: number; gpus: GpuInfo[] } | null = null;

/**
 * Enumerate NVIDIA GPUs on the host via `nvidia-smi`. Returns an empty array on any failure —
 * the host either doesn't have an NVIDIA card, doesn't have the driver installed, or nvidia-smi
 * isn't on PATH inside this container. Result is cached for 60s so the UI can poll cheaply.
 */
export async function detectGpus(): Promise<GpuInfo[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.gpus;

  try {
    const { stdout } = await execFileP(
      'nvidia-smi',
      [
        '--query-gpu=index,name,memory.total,power.default_limit,power.max_limit,power.min_limit',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 10_000 },
    );
    const gpus: GpuInfo[] = [];
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split(',').map(p => p.trim());
      if (parts.length < 6) continue;
      gpus.push({
        index: parts[0],
        name: parts[1],
        memoryTotalMb: parseInt(parts[2], 10) || 0,
        powerLimitCurrentWatts: parseFloat(parts[3]) || 0,
        powerLimitMaxWatts: parseFloat(parts[4]) || 0,
        powerLimitMinWatts: parseFloat(parts[5]) || 0,
      });
    }
    cache = { at: now, gpus };
    return gpus;
  } catch (err) {
    // nvidia-smi missing or errored — cache empty result too so we don't spam failed calls.
    cache = { at: now, gpus: [] };
    logger.debug({ err }, 'nvidia-smi unavailable — no GPUs detected');
    return [];
  }
}

/**
 * Apply a host-wide power cap on a single GPU. Requires nvidia-smi in PATH, root/admin on the
 * host, and (when running inside a container) the container must be started with sufficient
 * capabilities and access to the NVIDIA management library — typically `--gpus all` and the
 * NVIDIA container runtime. Failure returns { ok:false, error } rather than throwing so the
 * route can surface a friendly message.
 */
export async function setPowerLimit(gpuIndex: string, watts: number): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileP('nvidia-smi', ['-i', gpuIndex, '-pl', String(watts)], { timeout: 15_000 });
    // Invalidate detection cache so a subsequent read shows the new value.
    cache = null;
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ gpuIndex, watts, err: msg }, 'nvidia-smi -pl failed');
    return { ok: false, error: msg };
  }
}

export interface GpuLiveStat {
  index: string;
  utilizationGpuPercent: number;
  utilizationMemoryPercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  powerDrawWatts: number;
  powerLimitWatts: number;
}

/**
 * Live per-GPU utilization snapshot for the dashboard. Cheap enough (~50 ms) to poll every 2 s.
 * Empty array on any failure (nvidia-smi missing, host has no NVIDIA GPUs, etc.).
 */
export async function getGpuLiveStats(): Promise<GpuLiveStat[]> {
  try {
    const { stdout } = await execFileP(
      'nvidia-smi',
      [
        '--query-gpu=index,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw,power.limit',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 10_000 },
    );
    const out: GpuLiveStat[] = [];
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split(',').map(p => p.trim());
      if (parts.length < 7) continue;
      out.push({
        index: parts[0],
        utilizationGpuPercent: parseFloat(parts[1]) || 0,
        utilizationMemoryPercent: parseFloat(parts[2]) || 0,
        memoryUsedMb: parseInt(parts[3], 10) || 0,
        memoryTotalMb: parseInt(parts[4], 10) || 0,
        powerDrawWatts: parseFloat(parts[5]) || 0,
        powerLimitWatts: parseFloat(parts[6]) || 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Snapshot of the currently-applied power limit per GPU index. Empty object on any failure. */
export async function getCurrentPowerLimits(): Promise<Record<string, number>> {
  try {
    const { stdout } = await execFileP(
      'nvidia-smi',
      ['--query-gpu=index,power.limit', '--format=csv,noheader,nounits'],
      { timeout: 10_000 },
    );
    const out: Record<string, number> = {};
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const [idx, w] = line.split(',').map(p => p.trim());
      if (!idx) continue;
      const parsed = parseFloat(w);
      if (Number.isFinite(parsed)) out[idx] = parsed;
    }
    return out;
  } catch {
    return {};
  }
}
