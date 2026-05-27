import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { db } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import { managedStackService } from './managed-stack.service';
import type { Server as SocketIOServer } from 'socket.io';
import { SOCKET_EVENTS } from '@oblihub/shared';

const execFileP = promisify(execFile);

/**
 * Source manager for build-capable managed stacks.
 *
 * Responsibilities:
 *   - Receive a ZIP upload and extract it under the stack's working directory.
 *   - Clone or pull a git repo into the same directory.
 *   - Preserve the operator-supplied `.env` and any sibling state across re-uploads — we
 *     never overwrite a configured `.env` with whatever the uploaded zip happens to ship
 *     (which is usually the developer's local one or a templated example).
 *
 * Directory layout (per stack):
 *   <STACKS_DIR>/<compose_project>/
 *       docker-compose.yml       ← managed by compose.service (written before deploy)
 *       .env                     ← managed by compose.service; PRESERVED across uploads
 *       .oblihub/                ← our metadata (state.json), never wiped
 *       <user files…>            ← project sources from zip/git
 *
 * Re-upload semantics: replaces the project sources entirely. Anything outside `.env`,
 * `docker-compose.yml`, and `.oblihub/` is wiped. The user iterates by re-uploading without
 * having to re-enter their env config.
 */

let _io: SocketIOServer | null = null;
export function setSourceManagerIO(io: SocketIOServer): void { _io = io; }

const PRESERVE_FILES = new Set(['.env', 'docker-compose.yml']);
const PRESERVE_DIRS = new Set(['.oblihub']);

function stackDir(composeProject: string): string {
  return path.join(config.stacksDir, composeProject);
}

/** Atomically wipe `dir` except entries we want to keep across re-uploads. */
function wipePreservingState(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (PRESERVE_FILES.has(entry)) continue;
    if (PRESERVE_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ entry: full, err }, 'Failed to wipe stack file');
    }
  }
}

async function markSynced(stackId: number, extra: { gitRef?: string | null; sourceType?: string; gitUrl?: string | null; gitBranch?: string | null } = {}): Promise<void> {
  const update: Record<string, unknown> = { last_source_sync_at: new Date(), updated_at: new Date() };
  if (extra.sourceType !== undefined) update.source_type = extra.sourceType;
  if (extra.gitUrl !== undefined) update.git_url = extra.gitUrl;
  if (extra.gitBranch !== undefined) update.git_branch = extra.gitBranch;
  if (extra.gitRef !== undefined) update.git_ref = extra.gitRef;
  await db('managed_stacks').where({ id: stackId }).update(update);
}

function emitProgress(projectName: string, chunk: string): void {
  // Reuse the existing compose:log socket event so the client's DeployLogPanel renders it
  // — no extra UI plumbing needed for source operations.
  _io?.emit(SOCKET_EVENTS.COMPOSE_LOG, { projectName, stream: 'stdout', chunk });
}

export const sourceManagerService = {
  /**
   * Replace the project sources with the contents of an uploaded zip. Safe to call repeatedly
   * — `.env`, `docker-compose.yml` (if present at the dir root) and `.oblihub/` survive.
   *
   * The zip is read from memory; for very large uploads multer should be configured to spool
   * to disk and we'd switch to AdmZip(zipPath). Today we cap upload at 50 MB at the route
   * layer which is plenty for source code.
   */
  async receiveZip(stackId: number, zipBuffer: Buffer): Promise<void> {
    const stack = await managedStackService.getById(stackId);
    if (!stack) throw new AppError(404, 'Stack not found');
    const dir = stackDir(stack.composeProject);
    fs.mkdirSync(dir, { recursive: true });

    emitProgress(stack.composeProject, '== Extracting uploaded ZIP ==');
    wipePreservingState(dir);

    let zip: AdmZip;
    try {
      zip = new AdmZip(zipBuffer);
    } catch (err) {
      throw new AppError(400, `Invalid ZIP: ${err instanceof Error ? err.message : 'unknown error'}`);
    }

    // Detect a single top-level directory (common when GitHub downloads zip into "repo-main/")
    // and strip it so files land where compose expects them.
    const entries = zip.getEntries();
    if (entries.length === 0) throw new AppError(400, 'ZIP is empty');
    const topLevels = new Set<string>();
    for (const e of entries) {
      const first = e.entryName.split(/[/\\]/)[0];
      if (first) topLevels.add(first);
    }
    const stripPrefix = topLevels.size === 1 ? [...topLevels][0] + '/' : null;

    let count = 0;
    for (const e of entries) {
      if (e.isDirectory) continue;
      const rel = stripPrefix && e.entryName.startsWith(stripPrefix)
        ? e.entryName.slice(stripPrefix.length)
        : e.entryName;
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue; // zip-slip defense
      // Don't overwrite preserved files at the root level — operator's .env wins.
      const segs = rel.split(/[/\\]/);
      if (segs.length === 1 && PRESERVE_FILES.has(segs[0]) && fs.existsSync(path.join(dir, segs[0]))) {
        emitProgress(stack.composeProject, `  (preserved existing ${segs[0]})`);
        continue;
      }
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.getData());
      count++;
    }
    emitProgress(stack.composeProject, `== Extracted ${count} file(s) ==`);

    await markSynced(stackId, { sourceType: 'zip', gitUrl: null, gitBranch: null, gitRef: null });
    logger.info({ stackId, fileCount: count, dir }, 'ZIP source extracted');
  },

  /**
   * Set or change the git source for this stack: clones into the stack dir on first call,
   * resets to the requested branch on subsequent calls. Preserves the operator's .env across
   * the clone wipe.
   */
  async setGitSource(stackId: number, gitUrl: string, branch: string): Promise<void> {
    const stack = await managedStackService.getById(stackId);
    if (!stack) throw new AppError(404, 'Stack not found');
    if (!gitUrl.trim()) throw new AppError(400, 'gitUrl required');
    if (!branch.trim()) branch = 'main';

    const dir = stackDir(stack.composeProject);
    fs.mkdirSync(dir, { recursive: true });

    emitProgress(stack.composeProject, `== git clone ${gitUrl} (${branch}) ==`);
    wipePreservingState(dir);

    // Clone into a temp subdir then move contents up, so we never clobber the preserved files.
    const tmpClone = path.join(dir, '.oblihub_clone_tmp');
    if (fs.existsSync(tmpClone)) fs.rmSync(tmpClone, { recursive: true, force: true });
    try {
      const { stdout, stderr } = await execFileP('git', [
        'clone', '--depth', '1', '--branch', branch, gitUrl, tmpClone,
      ], { timeout: 5 * 60 * 1000 });
      if (stdout) emitProgress(stack.composeProject, stdout);
      if (stderr) emitProgress(stack.composeProject, stderr);
    } catch (err) {
      fs.rmSync(tmpClone, { recursive: true, force: true });
      throw new AppError(400, `git clone failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Move tmp contents up, respecting preserved files
    for (const entry of fs.readdirSync(tmpClone)) {
      if (entry === '.git') {
        fs.renameSync(path.join(tmpClone, entry), path.join(dir, '.git'));
        continue;
      }
      const src = path.join(tmpClone, entry);
      const dst = path.join(dir, entry);
      if (PRESERVE_FILES.has(entry) && fs.existsSync(dst)) {
        emitProgress(stack.composeProject, `  (preserved existing ${entry})`);
        continue;
      }
      fs.renameSync(src, dst);
    }
    fs.rmSync(tmpClone, { recursive: true, force: true });

    const ref = await this._resolveGitRef(dir);
    await markSynced(stackId, { sourceType: 'git', gitUrl, gitBranch: branch, gitRef: ref });
    emitProgress(stack.composeProject, `== Cloned at ${ref || '(unknown ref)'} ==`);
    logger.info({ stackId, gitUrl, branch, ref }, 'Git source cloned');
  },

  /**
   * Pull the latest commits on the currently-configured branch. No-op if the stack isn't
   * git-sourced. Preserves .env across the operation (git pull doesn't touch untracked files
   * by default, so this is mostly a guarantee for future schema changes).
   */
  async gitPull(stackId: number): Promise<void> {
    const stack = await managedStackService.getById(stackId);
    if (!stack) throw new AppError(404, 'Stack not found');
    if (stack.sourceType !== 'git' || !stack.gitUrl) {
      throw new AppError(400, 'Stack is not git-sourced');
    }
    const dir = stackDir(stack.composeProject);
    const gitDir = path.join(dir, '.git');
    if (!fs.existsSync(gitDir)) {
      // Likely a re-deploy after a manual cleanup — fall back to a fresh clone.
      logger.warn({ stackId }, '.git missing for git-sourced stack — re-cloning');
      await this.setGitSource(stackId, stack.gitUrl, stack.gitBranch || 'main');
      return;
    }

    emitProgress(stack.composeProject, `== git pull (${stack.gitBranch}) ==`);
    try {
      const { stdout, stderr } = await execFileP('git', [
        '-C', dir, 'pull', '--ff-only', 'origin', stack.gitBranch || 'main',
      ], { timeout: 5 * 60 * 1000 });
      if (stdout) emitProgress(stack.composeProject, stdout);
      if (stderr) emitProgress(stack.composeProject, stderr);
    } catch (err) {
      throw new AppError(400, `git pull failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const ref = await this._resolveGitRef(dir);
    await markSynced(stackId, { gitRef: ref });
    emitProgress(stack.composeProject, `== Updated to ${ref || '(unknown ref)'} ==`);
    logger.info({ stackId, ref }, 'Git source pulled');
  },

  /** Best-effort short SHA of HEAD; returns null when not a git repo. */
  async _resolveGitRef(dir: string): Promise<string | null> {
    try {
      const { stdout } = await execFileP('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 });
      return stdout.trim() || null;
    } catch { return null; }
  },

  /** List the files in the stack dir, for the future "what got uploaded" UI. */
  async listFiles(stackId: number): Promise<{ path: string; size: number; isDir: boolean }[]> {
    const stack = await managedStackService.getById(stackId);
    if (!stack) throw new AppError(404, 'Stack not found');
    const dir = stackDir(stack.composeProject);
    if (!fs.existsSync(dir)) return [];
    const out: { path: string; size: number; isDir: boolean }[] = [];
    const walk = (base: string, rel: string): void => {
      for (const entry of fs.readdirSync(base)) {
        if (entry === '.git' || entry === '.oblihub') continue;
        const full = path.join(base, entry);
        const sub = rel ? `${rel}/${entry}` : entry;
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          out.push({ path: sub, size: 0, isDir: true });
          walk(full, sub);
        } else {
          out.push({ path: sub, size: st.size, isDir: false });
        }
      }
    };
    walk(dir, '');
    return out;
  },
};
