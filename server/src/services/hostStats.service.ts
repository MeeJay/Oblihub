import * as os from 'os';
import * as fs from 'fs';
import { logger } from '../utils/logger';

/**
 * Snapshot of the Docker host's resource state — CPU %, RAM used/total, disk used/total on
 * the Docker root partition. Used by the header indicator to warn the operator BEFORE a build
 * saturates the host.
 *
 * Everything is measured from inside the Oblihub server container. That's a compromise:
 *   - RAM: `os.totalmem()` returns cgroup limit if the container is capped, else the host's
 *     total. Ditto for `freemem`. On a normal Oblihub deploy (no explicit --memory), this
 *     mirrors the host.
 *   - CPU: sampled twice ~250ms apart via `os.cpus()` cumulative user/nice/sys/idle times.
 *     Delta idle vs total yields a % that's accurate for the container's CPU view (again,
 *     usually the host when uncapped).
 *   - Disk: `fs.statfsSync('/')` reports the container's rootfs — which is the OVERLAY on top
 *     of Docker's data-root. Free/used bytes on that FS ARE the free/used bytes on the host's
 *     docker-root partition. That's the partition that fills up when the operator does big
 *     builds, so this is what we want to warn on.
 *
 * All fields are best-effort; failures return null values so the UI can render gracefully.
 */

export interface HostStats {
  cpu: { percent: number | null; cores: number };
  ram: { used: number; total: number; percent: number | null };
  disk: { used: number; total: number; percent: number | null; path: string };
  loadAvg: [number, number, number];
  measuredAt: string;
}

async function sampleCpuTimes(): Promise<{ total: number; idle: number }> {
  const cpus = os.cpus();
  let total = 0, idle = 0;
  for (const c of cpus) {
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    idle += c.times.idle;
  }
  return { total, idle };
}

async function readDiskStats(pathToCheck: string): Promise<{ used: number; total: number; percent: number | null; path: string }> {
  try {
    // fs.statfsSync is Node ≥ 18.15 / 20+; returns block counts + block size.
    const st = fs.statfsSync(pathToCheck);
    const total = Number(st.blocks) * st.bsize;
    const free = Number(st.bfree) * st.bsize;
    const used = total - free;
    return { used, total, percent: total > 0 ? (used / total) * 100 : null, path: pathToCheck };
  } catch (err) {
    logger.debug({ pathToCheck, err: err instanceof Error ? err.message : String(err) }, 'statfs failed');
    return { used: 0, total: 0, percent: null, path: pathToCheck };
  }
}

let cache: { at: number; snap: HostStats } | null = null;
const TTL_MS = 3_000;

export const hostStatsService = {
  /** Cached snapshot; second caller within TTL gets the memoized value. Sampling CPU takes
   *  ~250ms, so we don't want every UI poll to eat that cost. */
  async get(): Promise<HostStats> {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.snap;

    const cores = os.cpus().length;
    let cpuPercent: number | null = null;
    try {
      const s1 = await sampleCpuTimes();
      await new Promise(r => setTimeout(r, 250));
      const s2 = await sampleCpuTimes();
      const dTotal = s2.total - s1.total;
      const dIdle = s2.idle - s1.idle;
      cpuPercent = dTotal > 0 ? Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100)) : null;
    } catch { /* leave null */ }

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    const disk = await readDiskStats('/');
    const loadAvg = os.loadavg() as [number, number, number];

    const snap: HostStats = {
      cpu: { percent: cpuPercent, cores },
      ram: { used: usedMem, total: totalMem, percent: totalMem > 0 ? (usedMem / totalMem) * 100 : null },
      disk,
      loadAvg,
      measuredAt: new Date().toISOString(),
    };
    cache = { at: Date.now(), snap };
    return snap;
  },
};
