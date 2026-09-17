import * as fs from 'fs';
import * as path from 'path';
import type { Server as SocketIOServer } from 'socket.io';
import { config } from '../config';
import { logger } from '../utils/logger';
import { stackService } from '../services/stack.service';
import { dockerService } from '../services/docker.service';
import * as dockerCompose from '../services/dockerCompose.service';
import { markCriticalBusy, getLatestBusyAtAcross } from '../state/criticalActivity.state';

// Rebound-through-object so tests can swap these without touching the ESM binding table.
const composeOps = {
  pauseStack: dockerCompose.pauseStack,
  unpauseStack: dockerCompose.unpauseStack,
  stopStack: dockerCompose.stopStack,
  startStack: dockerCompose.startStack,
};
import type { ResourceLimits, YieldMode } from '@oblihub/shared';

/**
 * PriorityWatchdogWorker — makes Opportunistic stacks yield to Critical ones.
 *
 * Wire-up (nginx-traffic signal source, the only one implemented in phase C):
 *   1. Tail `<stacksDir>/_proxy/oblihub_traffic.log` (same file TrafficLogWorker aggregates).
 *   2. For each new hit, resolve `proxy_host_id → stack_id` via a 30s-refreshed cache.
 *   3. If that stack is the `yieldsToStackIds` of any Opportunistic stack, stamp
 *      `lastCriticalActivityAt = now` on that Opportunistic stack.
 *   4. Every EVAL_INTERVAL_MS the evaluator scans Opportunistic stacks:
 *        - Activity within `yieldIdleTimeoutSeconds` AND not paused → pause (or stop).
 *        - No activity for > `yieldIdleTimeoutSeconds` AND paused → resume.
 *
 * Debounce: many hits in one burst only mutate a single timestamp; the evaluator's 5s cadence
 * (plus the idle-timeout window itself) is what prevents flap. We never pause on the "leading
 * edge" faster than EVAL_INTERVAL_MS after the first hit, but for the miner-yields-to-AI use
 * case that ~5s ceiling is well under the LLM's own model-load time.
 *
 * Cold-start: on `startPriorityWatchdogWorker()` we resume EVERY Opportunistic stack. Reason:
 * a crash / restart while a stack was paused would otherwise leave it stuck paused. Cost is
 * one wasted `unpause` per Opportunistic stack per boot, which is cheap and idempotent.
 *
 * Graceful shutdown: on SIGTERM we resume every stack this worker paused in-memory. If we die
 * uncleanly the next cold-start will unstick them anyway.
 *
 * Not implemented in phase C (recorded in the priority-watchdog doc):
 *   - `gpu-util` signal source (poll `nvidia-smi --query-gpu=utilization.gpu`).
 *   - `webhook` signal source (`POST /api/stacks/:id/notify-busy`).
 *   Both fit as extra "activity source" inputs that also stamp `lastCriticalActivityAt`.
 */

const LOG_PATH = path.join(config.stacksDir, '_proxy', 'oblihub_traffic.log');
const POLL_INTERVAL_MS = 1_000;
const EVAL_INTERVAL_MS = 5_000;
const REFRESH_INTERVAL_MS = 30_000;

type OpportunisticStackWithYields = Awaited<ReturnType<typeof stackService.getOpportunisticStacksWithYields>>[number];

interface WatchdogState {
  stackId: number;
  composeProject: string | null;
  engineId: number | null;
  yieldsToStackIds: Set<number>;
  yieldIdleTimeoutMs: number;
  yieldMode: YieldMode;
  isYielded: boolean;                    // true = we've paused/stopped this stack
}

// Config we read once per REFRESH_INTERVAL_MS:
let opportunisticStates = new Map<number, WatchdogState>();       // stackId → state
let proxyHostToStackId = new Map<number, number>();               // proxy_host_id → stack_id
// Reverse index built with each config refresh so the log-line hot path is O(1):
// critical_stack_id → set of opportunistic stack IDs that yield to it.
let criticalToOpportunistic = new Map<number, Set<number>>();

let ioRef: SocketIOServer | null = null;
let watching = false;
let lastSize = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let evalTimer: ReturnType<typeof setInterval> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function coalesceIdleTimeoutMs(limits: ResourceLimits): number {
  const raw = limits.yieldIdleTimeoutSeconds;
  const val = raw == null || raw <= 0 ? 30 : raw;
  return val * 1000;
}

function coalesceYieldMode(limits: ResourceLimits): YieldMode {
  return limits.yieldMode === 'pause' ? 'pause' : 'stop';
}

async function refreshConfig(): Promise<void> {
  const opportunistic = await stackService.getOpportunisticStacksWithYields();
  const nextStates = new Map<number, WatchdogState>();
  const nextCritToOpp = new Map<number, Set<number>>();

  const allYieldTargets = new Set<number>();
  for (const s of opportunistic) {
    const yieldsTo = new Set<number>(s.resourceLimits.yieldsToStackIds ?? []);
    for (const t of yieldsTo) allYieldTargets.add(t);
    // Preserve runtime bits (last activity, isYielded) across refreshes so we don't oscillate
    // just because the config was re-read.
    const prev = opportunisticStates.get(s.id);
    nextStates.set(s.id, {
      stackId: s.id,
      composeProject: s.composeProject,
      engineId: s.engineId,
      yieldsToStackIds: yieldsTo,
      yieldIdleTimeoutMs: coalesceIdleTimeoutMs(s.resourceLimits),
      yieldMode: coalesceYieldMode(s.resourceLimits),
      isYielded: prev?.isYielded ?? false,
    });
    for (const critId of yieldsTo) {
      if (!nextCritToOpp.has(critId)) nextCritToOpp.set(critId, new Set());
      nextCritToOpp.get(critId)!.add(s.id);
    }
  }

  // Refresh proxy_host → stack_id ONLY for the stack IDs opportunistic stacks yield to. We don't
  // need to know about proxy_hosts for unrelated stacks — the hot path only cares whether a hit
  // belongs to a "watched" critical stack.
  const nextProxyMap = new Map<number, number>();
  if (allYieldTargets.size > 0) {
    // We reverse the query: fetch all proxy_hosts for the watched stacks and invert.
    const { db } = await import('../db');
    const rows: Array<{ id: number; stack_id: number }> = await db('proxy_hosts')
      .whereIn('stack_id', Array.from(allYieldTargets))
      .where({ enabled: true })
      .select('id', 'stack_id');
    for (const r of rows) nextProxyMap.set(r.id, r.stack_id);
  }

  opportunisticStates = nextStates;
  proxyHostToStackId = nextProxyMap;
  criticalToOpportunistic = nextCritToOpp;
}

function processLine(line: string): void {
  if (!line || line[0] === '#') return;
  const parts = line.split('|');
  if (parts.length < 1) return;
  const proxyHostId = parseInt(parts[0], 10);
  if (!Number.isFinite(proxyHostId) || proxyHostId <= 0) return;
  const stackId = proxyHostToStackId.get(proxyHostId);
  if (stackId == null) return;
  // Only stamp if this Critical stack is actually watched by an Opportunistic — cheap early-out
  // for hits against Critical stacks nobody yields to.
  if (!criticalToOpportunistic.has(stackId)) return;
  markCriticalBusy(stackId);
}

async function pollFile(): Promise<void> {
  if (!fs.existsSync(LOG_PATH)) return;
  let stat: fs.Stats;
  try { stat = fs.statSync(LOG_PATH); } catch { return; }
  if (stat.size === lastSize) return;
  if (stat.size < lastSize) { lastSize = 0; }
  const fd = fs.openSync(LOG_PATH, 'r');
  try {
    const toRead = stat.size - lastSize;
    if (toRead > 0) {
      const buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, lastSize);
      lastSize = stat.size;
      const text = buf.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.trim()) processLine(line);
      }
    }
  } finally { fs.closeSync(fd); }
}

async function yieldStack(state: WatchdogState, reason: string): Promise<boolean> {
  try {
    if (state.yieldMode === 'pause') {
      // `docker compose pause` targets every service; but Standalone stacks with no composeProject
      // fall back to per-container pause via the docker socket.
      if (state.composeProject) {
        await composeOps.pauseStack(state.composeProject);
      } else {
        await pausePerContainer(state);
      }
    } else {
      if (state.composeProject) {
        await composeOps.stopStack(state.composeProject);
      } else {
        await stopPerContainer(state);
      }
    }
    state.isYielded = true;
    logger.info({ stackId: state.stackId, mode: state.yieldMode, reason }, 'Watchdog yielded stack');
    ioRef?.emit('stack:paused-by-watchdog', { stackId: state.stackId, reason });
    return true;
  } catch (err) {
    logger.warn({ stackId: state.stackId, err: err instanceof Error ? err.message : String(err) }, 'Watchdog yield failed');
    return false;
  }
}

async function resumeStackState(state: WatchdogState, reason: string): Promise<boolean> {
  try {
    if (state.yieldMode === 'pause') {
      if (state.composeProject) {
        await composeOps.unpauseStack(state.composeProject);
      } else {
        await unpausePerContainer(state);
      }
    } else {
      if (state.composeProject) {
        await composeOps.startStack(state.composeProject);
      } else {
        await startPerContainer(state);
      }
    }
    state.isYielded = false;
    logger.info({ stackId: state.stackId, mode: state.yieldMode, reason }, 'Watchdog resumed stack');
    ioRef?.emit('stack:resumed-by-watchdog', { stackId: state.stackId, reason });
    return true;
  } catch (err) {
    logger.warn({ stackId: state.stackId, err: err instanceof Error ? err.message : String(err) }, 'Watchdog resume failed');
    return false;
  }
}

// ── Standalone-stack fallbacks: no compose file, so hit dockerode per-container ──
async function pausePerContainer(state: WatchdogState): Promise<void> {
  const stack = await stackService.getById(state.stackId);
  if (!stack) return;
  for (const c of stack.containers) {
    if (c.excluded || c.status === 'stopped' || c.status === 'excluded') continue;
    try { await dockerService.pauseContainer(c.dockerId, state.engineId); }
    catch (err) { logger.warn({ stackId: state.stackId, dockerId: c.dockerId, err }, 'pauseContainer failed'); }
  }
}

async function unpausePerContainer(state: WatchdogState): Promise<void> {
  const stack = await stackService.getById(state.stackId);
  if (!stack) return;
  for (const c of stack.containers) {
    if (c.excluded) continue;
    try { await dockerService.unpauseContainer(c.dockerId, state.engineId); }
    catch (err) { logger.warn({ stackId: state.stackId, dockerId: c.dockerId, err }, 'unpauseContainer failed'); }
  }
}

async function stopPerContainer(state: WatchdogState): Promise<void> {
  const stack = await stackService.getById(state.stackId);
  if (!stack) return;
  for (const c of stack.containers) {
    if (c.excluded || c.status === 'stopped' || c.status === 'excluded') continue;
    try { await dockerService.stopContainer(c.dockerId, state.engineId); }
    catch (err) { logger.warn({ stackId: state.stackId, dockerId: c.dockerId, err }, 'stopContainer failed'); }
  }
}

async function startPerContainer(state: WatchdogState): Promise<void> {
  const stack = await stackService.getById(state.stackId);
  if (!stack) return;
  for (const c of stack.containers) {
    if (c.excluded) continue;
    try { await dockerService.startContainer(c.dockerId, state.engineId); }
    catch (err) { logger.warn({ stackId: state.stackId, dockerId: c.dockerId, err }, 'startContainer failed'); }
  }
}

async function evaluate(): Promise<void> {
  const now = Date.now();
  for (const state of opportunisticStates.values()) {
    // Latest activity across ALL Critical stacks this one yields to. Any source (nginx tail,
    // GPU poller, webhook) that stamped one of those Critical IDs counts.
    const last = getLatestBusyAtAcross(state.yieldsToStackIds);
    const withinWindow = last != null && (now - last) <= state.yieldIdleTimeoutMs;
    if (withinWindow && !state.isYielded) {
      await yieldStack(state, 'critical-activity');
    } else if (!withinWindow && state.isYielded) {
      await resumeStackState(state, 'idle-timeout');
    }
  }
}

/**
 * Resume every Opportunistic stack — regardless of whether we THINK it's paused. Called at
 * boot and again on shutdown so operators don't lose stacks to a bad crash.
 */
async function resumeAllOpportunistic(reason: string): Promise<void> {
  // We snapshot the current DB view rather than reusing opportunisticStates so this also fires
  // when the worker was killed before `refreshConfig()` ever populated the map.
  const opportunistic = await stackService.getOpportunisticStacksWithYields().catch(() => []);
  for (const s of opportunistic) {
    const yieldMode = coalesceYieldMode(s.resourceLimits);
    const fauxState: WatchdogState = {
      stackId: s.id,
      composeProject: s.composeProject,
      engineId: s.engineId,
      yieldsToStackIds: new Set(s.resourceLimits.yieldsToStackIds ?? []),
      yieldIdleTimeoutMs: coalesceIdleTimeoutMs(s.resourceLimits),
      yieldMode,
      isYielded: true, // pretend it's paused so `resumeStackState` actually runs
    };
    // Silently swallow "not paused" errors — that's the expected case for most stacks at boot.
    await resumeStackState(fauxState, reason).catch(() => {});
  }
}

/**
 * Snapshot of stacks currently paused/stopped by the watchdog. Consumed by the Resources
 * Dashboard so it can render a "paused-by-watchdog" badge without having to infer from the
 * container's raw Docker state (which would conflate operator-initiated stops with our yields).
 */
export function getYieldedStackIds(): Set<number> {
  const out = new Set<number>();
  for (const [id, s] of opportunisticStates) if (s.isYielded) out.add(id);
  return out;
}

export function startPriorityWatchdogWorker(io: SocketIOServer): void {
  if (watching) return;
  watching = true;
  ioRef = io;
  logger.info({ logPath: LOG_PATH }, 'Starting priority watchdog worker (1s poll, 5s evaluate, 30s refresh)');

  // Seek to EOF so we don't replay historical traffic at boot.
  try { lastSize = fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH).size : 0; } catch { lastSize = 0; }

  // Cold-start resume BEFORE we start evaluating — otherwise a still-active traffic burst could
  // race us into a fresh pause before we've cleared the previous one.
  resumeAllOpportunistic('cold-start').catch(err => logger.warn({ err }, 'Cold-start resume failed'));

  refreshConfig().catch(err => logger.warn({ err }, 'PriorityWatchdog initial config refresh failed'));

  pollTimer = setInterval(() => {
    pollFile().catch(err => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'PriorityWatchdog poll failed'));
  }, POLL_INTERVAL_MS);
  evalTimer = setInterval(() => {
    evaluate().catch(err => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'PriorityWatchdog evaluate failed'));
  }, EVAL_INTERVAL_MS);
  refreshTimer = setInterval(() => {
    refreshConfig().catch(err => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'PriorityWatchdog refresh failed'));
  }, REFRESH_INTERVAL_MS);
}

export function stopPriorityWatchdogWorker(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (evalTimer) { clearInterval(evalTimer); evalTimer = null; }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  watching = false;
  // Resume anything currently yielded so we don't leave stacks stuck paused when the process
  // dies. Fire-and-forget: the shutdown handler doesn't await us.
  resumeAllOpportunistic('shutdown').catch(err => logger.warn({ err }, 'Shutdown resume failed'));
}

/**
 * Test hook — force an immediate config refresh + evaluate cycle. Not called at runtime; used
 * by unit tests to advance the state machine without waiting for the 5s / 30s timers.
 */
export const __test_only = {
  refreshConfig,
  evaluate,
  processLine,
  getState: (stackId: number) => opportunisticStates.get(stackId),
  seedProxyMap: (m: Map<number, number>) => { proxyHostToStackId = new Map(m); },
  seedCriticalIndex: (m: Map<number, Set<number>>) => { criticalToOpportunistic = new Map(m); },
  seedStates: (m: Map<number, WatchdogState>) => { opportunisticStates = new Map(m); },
  setComposeOps: (ops: Partial<typeof composeOps>) => { Object.assign(composeOps, ops); },
};
