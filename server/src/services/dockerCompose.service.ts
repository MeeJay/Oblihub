import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { stackVolumesService } from './stackVolumes.service';

/**
 * Thin `docker compose` CLI wrappers used by the priority watchdog to yield or resume
 * Opportunistic stacks. Every call is scoped to `<stacksDir>/<folderName>` and layers the
 * auto-managed `docker-compose.override.oblihub.yml` on top when present so resource caps and
 * GPU visibility survive a stop / start cycle.
 *
 * All helpers timeout at 60s and return the docker exit code — they NEVER throw for a non-zero
 * compose exit; the caller decides whether that constitutes a failure worth propagating.
 */

const execFileP = promisify(execFile);
const COMPOSE_TIMEOUT_MS = 60_000;
const OBLIHUB_OVERRIDE = 'docker-compose.override.oblihub.yml';

async function fileExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function buildComposeArgs(stackFolderName: string, stackDir: string): Promise<string[]> {
  // Explicit -p: callers pass the stack's compose project label. Without it, a top-level `name:`
  // or COMPOSE_PROJECT_NAME in the stack's .env would address ANOTHER project — duplicate
  // containers, and for stacks with volumes in .volumes, a second volume on the same data folder.
  const args = ['compose', '-p', stackFolderName, '-f', 'docker-compose.yml'];
  if (await fileExists(path.join(stackDir, OBLIHUB_OVERRIDE))) {
    args.push('-f', OBLIHUB_OVERRIDE);
  }
  return args;
}

async function runCompose(
  stackFolderName: string,
  verb: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const dir = path.join(config.stacksDir, stackFolderName);
  let cleanupVolumes = () => {};
  try {
    // Managed stacks with volumes under <stacksDir>/.volumes: same override as every other
    // runner, and the same refusal when the command could detach their data.
    const volumeFiles = await stackVolumesService.prepareComposeFilesForFolder(stackFolderName, verb[0] ?? '');
    cleanupVolumes = volumeFiles.cleanup;
    const args = [...(await buildComposeArgs(stackFolderName, dir)), ...volumeFiles.args, ...verb];
    const pending = execFileP('docker', args, { cwd: dir, timeout: COMPOSE_TIMEOUT_MS });
    // Close stdin so a Compose prompt answers "no" instead of blocking until the timeout.
    pending.child.stdin?.end();
    const { stdout, stderr } = await pending;
    return { ok: true, stdout, stderr };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e?.stdout || '', stderr: e?.stderr || e?.message || '' };
  } finally {
    cleanupVolumes();
  }
}

/** `docker compose pause` — cgroup freeze; keeps GPU VRAM allocated. Fast, reversible. */
export async function pauseStack(stackFolderName: string): Promise<void> {
  const res = await runCompose(stackFolderName, ['pause']);
  if (!res.ok) {
    logger.warn({ stackFolderName, stderr: res.stderr }, 'docker compose pause failed');
    throw new Error(res.stderr || 'docker compose pause failed');
  }
}

/** `docker compose unpause` — resume from a cgroup freeze. */
export async function unpauseStack(stackFolderName: string): Promise<void> {
  const res = await runCompose(stackFolderName, ['unpause']);
  if (!res.ok) {
    logger.warn({ stackFolderName, stderr: res.stderr }, 'docker compose unpause failed');
    throw new Error(res.stderr || 'docker compose unpause failed');
  }
}

/** `docker compose stop` — SIGTERM the containers. Releases GPU VRAM. */
export async function stopStack(stackFolderName: string): Promise<void> {
  const res = await runCompose(stackFolderName, ['stop']);
  if (!res.ok) {
    logger.warn({ stackFolderName, stderr: res.stderr }, 'docker compose stop failed');
    throw new Error(res.stderr || 'docker compose stop failed');
  }
}

/**
 * `docker compose start` when containers exist (stopped), otherwise `docker compose up -d`.
 *
 * We optimistically try `start` first — it's a no-op when there's nothing to start and it's
 * faster than `up -d` because it skips the compose plan reconcile. If `start` fails (e.g. the
 * containers were removed via `docker rm`), we fall back to `up -d` which recreates them.
 */
export async function startStack(stackFolderName: string): Promise<void> {
  const startRes = await runCompose(stackFolderName, ['start']);
  if (startRes.ok) return;
  logger.info({ stackFolderName, stderr: startRes.stderr }, 'docker compose start failed, falling back to up -d');
  const upRes = await runCompose(stackFolderName, ['up', '-d']);
  if (!upRes.ok) {
    logger.warn({ stackFolderName, stderr: upRes.stderr }, 'docker compose up -d fallback failed');
    throw new Error(upRes.stderr || 'docker compose up -d failed');
  }
}
