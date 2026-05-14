import { db } from '../db';
import { dockerService } from './docker.service';
import { stackService } from './stack.service';
import { logger } from '../utils/logger';
import type { SleepMode, SleepState, Container } from '@oblihub/shared';
import net from 'net';

/**
 * Sleep service — manages on-demand sleep/wake for containers.
 *
 * Why: AI workloads pin GPU VRAM constantly. Stopping idle containers frees it.
 * Only `stop` actually frees VRAM (process exit → driver releases). `pause` just freezes
 * the cgroup but keeps the process mapped — useless for the GPU use case but cheap for non-GPU.
 *
 * State machine: awake → sleeping → waking → awake (or → wake_failed on timeout/error)
 *
 * Wake idempotency: a single in-flight wake per container shared across concurrent callers.
 * Without this, 10 simultaneous browser tabs hitting the waking page would issue 10 `docker start`s.
 */

const WAKE_TIMEOUT_MS = 180_000; // 3 min — generous for AI model reload
const WAKE_HEALTH_POLL_MS = 1_000;

// In-flight wake promises, keyed by container ID. Lets concurrent wake requests share a single op.
const wakingInFlight = new Map<number, Promise<{ ok: boolean; message?: string }>>();

async function setState(containerId: number, sleepState: SleepState, extra: Record<string, unknown> = {}): Promise<void> {
  await db('containers').where({ id: containerId }).update({
    sleep_state: sleepState,
    updated_at: new Date(),
    ...extra,
  });
}

async function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; try { sock.destroy(); } catch { /* ignore */ } resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
    sock.connect(port, host);
  });
}

async function httpProbe(host: string, port: number, path: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://${host}:${port}${path}`, { signal: controller.signal });
    clearTimeout(t);
    return res.status >= 200 && res.status < 500; // accept anything that's not server-down
  } catch {
    return false;
  }
}

export const sleepService = {
  /**
   * Mark a container as "active" (touched by user traffic). Resets idle timer.
   * Called by ActivityTracker on each filtered request.
   */
  async recordActivity(containerId: number): Promise<void> {
    await db('containers').where({ id: containerId }).update({
      last_active_at: new Date(),
    });
  },

  /**
   * Sleep a container — either `docker stop` (frees VRAM) or `docker pause` (cgroup freeze).
   * Idempotent: already-sleeping container is a no-op.
   */
  async sleep(containerId: number): Promise<{ ok: boolean; message?: string }> {
    const container = await stackService.getContainerById(containerId);
    if (!container) return { ok: false, message: 'Container not found' };
    if (container.sleepState === 'sleeping') return { ok: true, message: 'Already sleeping' };
    if (container.sleepState === 'waking') return { ok: false, message: 'Currently waking — sleep aborted' };

    const mode: SleepMode = container.sleepMode || 'stop';
    try {
      if (mode === 'pause') {
        await dockerService.pauseContainer(container.dockerId, container.engineId);
      } else {
        await dockerService.stopContainer(container.dockerId, container.engineId);
      }
      await setState(containerId, 'sleeping');
      logger.info({ containerId, containerName: container.containerName, mode, engineId: container.engineId }, 'Container put to sleep');
      return { ok: true };
    } catch (err) {
      logger.error({ containerId, err }, 'Failed to sleep container');
      return { ok: false, message: err instanceof Error ? err.message : 'sleep failed' };
    }
  },

  /**
   * Wake a container — start (or unpause) + poll readiness.
   * Returns when the container is reachable or after WAKE_TIMEOUT_MS.
   *
   * Idempotent across callers via wakingInFlight map.
   */
  async wake(containerId: number): Promise<{ ok: boolean; message?: string }> {
    const existing = wakingInFlight.get(containerId);
    if (existing) return existing;

    const promise = this._wakeInner(containerId).finally(() => {
      wakingInFlight.delete(containerId);
    });
    wakingInFlight.set(containerId, promise);
    return promise;
  },

  async _wakeInner(containerId: number): Promise<{ ok: boolean; message?: string }> {
    const container = await stackService.getContainerById(containerId);
    if (!container) return { ok: false, message: 'Container not found' };
    if (container.sleepState === 'awake') return { ok: true, message: 'Already awake' };

    const mode = container.sleepMode || 'stop';
    const now = new Date();

    await setState(containerId, 'waking', { wake_started_at: now, last_active_at: now });

    try {
      if (mode === 'pause') {
        await dockerService.unpauseContainer(container.dockerId, container.engineId);
      } else {
        await dockerService.startContainer(container.dockerId, container.engineId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'start failed';
      logger.error({ containerId, err }, 'Failed to start container during wake');
      await setState(containerId, 'wake_failed');
      return { ok: false, message };
    }

    // Probe readiness — HTTP path if configured, else TCP.
    //
    // Probe target selection — single source of truth: the proxy_host's forwardHost:forwardPort.
    // That's what nginx routes to in production, so it's both reachable from here and exactly
    // what the user has validated. Falls back to the container's bridge IP for containers
    // not (yet) wired to a proxy host (e.g. the operator just enabled sleep on a container
    // they're going to consume some other way).
    let probeHost: string | null = null;
    let probePort: number | null = null;
    try {
      const proxyRow = await db('proxy_hosts')
        .where({ wake_container_id: containerId })
        .select('forward_host', 'forward_port')
        .first();
      if (proxyRow?.forward_host && proxyRow?.forward_port) {
        probeHost = proxyRow.forward_host as string;
        probePort = proxyRow.forward_port as number;
      }
    } catch { /* leave nulls — fall through to bridge probe */ }

    const containerPort = container.ports.find(p => p.containerPort)?.containerPort ?? null;
    const start = Date.now();

    while (Date.now() - start < WAKE_TIMEOUT_MS) {
      try {
        // Primary path: probe the proxy_host's forward target.
        if (probeHost && probePort) {
          const ready = container.wakeHealthPath
            ? await httpProbe(probeHost, probePort, container.wakeHealthPath)
            : await tcpProbe(probeHost, probePort);
          if (ready) {
            await setState(containerId, 'awake', { last_active_at: new Date() });
            logger.info({ containerId, via: `proxy-host:${probeHost}:${probePort}`, elapsedMs: Date.now() - start }, 'Container woken');
            return { ok: true };
          }
        } else {
          // Fallback: no proxy_host wired to this container — probe via Docker bridge IP.
          // This still works when proxy and container live on the same daemon.
          const info = await dockerService.inspectContainer(container.dockerId, container.engineId);
          const netSettings = info.NetworkSettings?.Networks || {};
          const firstNet = Object.values(netSettings)[0] as { IPAddress?: string } | undefined;
          const ip = firstNet?.IPAddress;
          if (ip && containerPort) {
            const ready = container.wakeHealthPath
              ? await httpProbe(ip, containerPort, container.wakeHealthPath)
              : await tcpProbe(ip, containerPort);
            if (ready) {
              await setState(containerId, 'awake', { last_active_at: new Date() });
              logger.info({ containerId, via: 'bridge-ip', elapsedMs: Date.now() - start }, 'Container woken');
              return { ok: true };
            }
          } else if (info.State?.Running === true && container.engineId) {
            // Last resort: no probe target reachable from here. Trust docker status.
            await new Promise(r => setTimeout(r, WAKE_HEALTH_POLL_MS));
            await setState(containerId, 'awake', { last_active_at: new Date() });
            logger.info({ containerId, via: 'docker-status-only', elapsedMs: Date.now() - start }, 'Container woken (no probe target)');
            return { ok: true };
          }
        }
      } catch {
        // inspect may briefly fail during startup, keep polling
      }
      await new Promise(r => setTimeout(r, WAKE_HEALTH_POLL_MS));
    }

    await setState(containerId, 'wake_failed');
    logger.warn({ containerId }, 'Wake timeout');
    return { ok: false, message: 'Wake timed out — container did not become ready' };
  },

  /** Return current wake status for the waking page poller. */
  async getWakeStatus(containerId: number): Promise<{ state: SleepState; elapsedMs: number; message?: string }> {
    const c = await stackService.getContainerById(containerId);
    if (!c) return { state: 'wake_failed', elapsedMs: 0, message: 'Container not found' };
    const elapsedMs = c.wakeStartedAt ? Date.now() - new Date(c.wakeStartedAt).getTime() : 0;
    return { state: c.sleepState, elapsedMs };
  },

  /** Update sleep config for a container. */
  async updateConfig(containerId: number, data: {
    sleepEnabled?: boolean;
    sleepAfterSeconds?: number;
    sleepMode?: SleepMode;
    wakeHealthPath?: string | null;
  }): Promise<Container | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.sleepEnabled !== undefined) update.sleep_enabled = data.sleepEnabled;
    if (data.sleepAfterSeconds !== undefined) update.sleep_after_seconds = Math.max(60, data.sleepAfterSeconds);
    if (data.sleepMode !== undefined) update.sleep_mode = data.sleepMode;
    if (data.wakeHealthPath !== undefined) update.wake_health_path = data.wakeHealthPath;
    await db('containers').where({ id: containerId }).update(update);
    return stackService.getContainerById(containerId);
  },

  /** List containers that should be put to sleep right now (idle past threshold). */
  async listIdleSleepCandidates(): Promise<Container[]> {
    const rows = await db('containers')
      .where({ sleep_enabled: true, sleep_state: 'awake' })
      .whereNot('excluded', true);
    const result: Container[] = [];
    const now = Date.now();
    for (const r of rows) {
      const c = await stackService.getContainerById(r.id);
      if (!c || !c.sleepEnabled) continue;
      // Anti-flapping: require last_active_at to be set and idle longer than threshold.
      // If never seen activity (last_active_at NULL), treat now as activity to give grace period.
      if (!c.lastActiveAt) {
        await sleepService.recordActivity(c.id);
        continue;
      }
      const idleMs = now - new Date(c.lastActiveAt).getTime();
      if (idleMs >= c.sleepAfterSeconds * 1000) {
        result.push(c);
      }
    }
    return result;
  },
};
