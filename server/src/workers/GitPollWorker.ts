import { db } from '../db';
import { logger } from '../utils/logger';
import { managedStackService } from '../services/managed-stack.service';
import { sourceManagerService } from '../services/sourceManager.service';
import { composeService } from '../services/compose.service';

/**
 * Poll every git-sourced managed stack that has `poll_git_interval_s > 0`. For each, check
 * whether the remote HEAD SHA moved since the last recorded ref; if so, pull + rebuild.
 *
 * DELIBERATELY NOT a webhook. Two reasons:
 *   1. Oblihub is a poll-out only system by design — it doesn't accept unsolicited ingress
 *      (see architecture in the repo docs). Adding a webhook route would break that invariant
 *      and open a new attack surface (replay, HMAC key rotation, DoS via spam).
 *   2. Polling works transparently behind NAT / firewall / air-gapped VPN with zero operator
 *      config on the Gitea side. Trade-off is up-to-60s latency between push and deploy,
 *      which is fine for the target audience.
 *
 * The worker is a SINGLE global tick every 60s that iterates eligible stacks and, for each,
 * only actually calls `git ls-remote` when `last_git_poll_at + poll_git_interval_s` has passed.
 * That way a stack set to poll every 3600s doesn't get pinged 60x more than it asked for.
 */

const TICK_MS = 60_000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  const now = Date.now();
  let candidates: Array<{ id: number; poll_git_interval_s: number; last_git_poll_at: Date | null }>;
  try {
    candidates = await db('managed_stacks')
      .where('source_type', 'git')
      .where('poll_git_interval_s', '>', 0)
      .select('id', 'poll_git_interval_s', 'last_git_poll_at');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'GitPollWorker DB query failed');
    return;
  }

  for (const row of candidates) {
    const lastPoll = row.last_git_poll_at ? new Date(row.last_git_poll_at).getTime() : 0;
    const nextDueAt = lastPoll + row.poll_git_interval_s * 1000;
    if (now < nextDueAt) continue;
    await pollOne(row.id).catch(err => {
      logger.warn({ stackId: row.id, err: err instanceof Error ? err.message : String(err) }, 'Git poll failed for stack');
    });
  }
}

async function pollOne(stackId: number): Promise<void> {
  const stack = await managedStackService.getById(stackId);
  if (!stack || stack.sourceType !== 'git' || !stack.gitUrl) return;
  const branch = stack.gitBranch || 'main';

  // Stamp the poll time immediately so a slow ls-remote (or a hung one) doesn't cause the
  // worker to re-attempt the same stack every tick until it finishes.
  await db('managed_stacks').where({ id: stackId }).update({ last_git_poll_at: new Date() });

  const remoteRef = await sourceManagerService.remoteHeadRef(stackId, stack.gitUrl, branch);
  if (!remoteRef) return; // network/auth failure — try again next interval
  if (remoteRef === stack.gitRef) {
    // No new commits — cheapest happy path.
    return;
  }

  logger.info({ stackId, from: stack.gitRef, to: remoteRef, branch }, 'Git poll detected new commit — pulling + redeploying');
  try {
    await sourceManagerService.gitPull(stackId);
    const refreshed = await managedStackService.getById(stackId);
    if (!refreshed) return;
    const result = await composeService.redeploy(refreshed.composeProject, refreshed.composeContent, refreshed.envContent, refreshed.engineId);
    await managedStackService.recordDeployHistory({
      managedStackId: stackId,
      sourceType: refreshed.sourceType,
      gitUrl: refreshed.gitUrl,
      gitBranch: refreshed.gitBranch,
      gitRef: refreshed.gitRef,
      composePath: refreshed.composePath,
      buildEnabled: refreshed.buildEnabled,
      success: result.exitCode === 0,
      notes: `Auto: git poll ${stack.gitRef ?? '?'} → ${refreshed.gitRef ?? '?'}`,
      deployedByUserId: null,
    });
  } catch (err) {
    logger.warn({ stackId, err: err instanceof Error ? err.message : String(err) }, 'Auto pull+redeploy failed after git poll');
  }
}

export function startGitPollWorker(): void {
  tick().catch(err => logger.error(err, 'GitPollWorker initial run failed'));
  pollTimer = setInterval(() => { tick().catch(err => logger.error(err, 'GitPollWorker run failed')); }, TICK_MS);
  logger.info({ intervalMs: TICK_MS }, 'Git-poll worker started');
}

export function stopGitPollWorker(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
