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

// Only `.env` is preserved across re-uploads — it holds operator secrets that must not be
// clobbered by whatever .env the developer happened to zip up. The docker-compose.yml is NOT
// preserved: for build stacks the uploaded/cloned project's compose is the source of truth, so
// a re-upload should bring in the latest version.
const PRESERVE_FILES = new Set(['.env']);
const PRESERVE_DIRS = new Set(['.oblihub']);

// Candidate compose filenames at the project root, in priority order.
const COMPOSE_CANDIDATES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

function stackDir(composeProject: string): string {
  return path.join(config.stacksDir, composeProject);
}

/**
 * After an upload/clone, pull the on-disk docker-compose.yml + .env back into the DB
 * (compose_content / env_content) so the Oblihub editor reflects what was actually ingested.
 * Without this the editor would show stale/empty content while the real files sit on disk —
 * exactly the confusing gap the operator hit.
 *
 * The on-disk compose wins (build-stack source of truth). The .env is read too so the editor
 * shows the env that's actually in play; since .env is preserved across re-uploads, this stays
 * consistent with operator edits made through the UI.
 */
async function syncFromDisk(stackId: number, composeProject: string): Promise<void> {
  const dir = stackDir(composeProject);
  const update: Record<string, unknown> = { updated_at: new Date() };

  // Explicit compose_path (Trame-style: `stack/docker-compose.yml`) wins over the root-only
  // legacy scan. Falls back to the candidate list when unset so pre-Trame stacks keep working.
  const stackRow = await db('managed_stacks').where({ id: stackId }).select('compose_path', 'env_content', 'env_content_enc').first();
  const explicitPath = (stackRow?.compose_path as string) || null;
  const composeCandidates = explicitPath ? [explicitPath] : COMPOSE_CANDIDATES;

  for (const name of composeCandidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      update.compose_content = fs.readFileSync(p, 'utf8');
      break;
    }
  }
  // .env lookup follows the compose file — if compose is at `stack/`, look for `stack/.env`
  // first, then fall back to the repo-root `.env` so pre-Trame stacks keep working.
  const envDir = explicitPath ? path.dirname(path.join(dir, explicitPath)) : dir;
  let foundRealEnv = false;
  for (const candidate of [path.join(envDir, '.env'), path.join(dir, '.env')]) {
    if (fs.existsSync(candidate)) {
      update.env_content = fs.readFileSync(candidate, 'utf8');
      foundRealEnv = true;
      break;
    }
  }
  // Fallback preload from a committed template (`.env.example` / `.env.dist` / `.env.sample`
  // / `.env.template`) ONLY when we didn't find a real .env AND the stack has never had any
  // env content saved yet. This handles the Trame-style flow where the operator clones a repo
  // whose `.env` is gitignored — instead of forcing them to copy-paste the template manually,
  // we drop it into the editor pre-filled. Re-clones of an already-configured stack skip this
  // because `hasExistingEnv` is true, so their saved secrets are never clobbered by placeholders.
  if (!foundRealEnv) {
    const hasExistingEnv = !!(stackRow?.env_content_enc || stackRow?.env_content);
    if (!hasExistingEnv) {
      const templateNames = ['.env.example', '.env.dist', '.env.sample', '.env.template'];
      outer: for (const tmpl of templateNames) {
        for (const baseDir of [envDir, dir]) {
          const p = path.join(baseDir, tmpl);
          if (fs.existsSync(p)) {
            update.env_content = fs.readFileSync(p, 'utf8');
            emitProgress(composeProject, `== Preloaded env from ${path.relative(dir, p).replace(/\\/g, '/')} — replace placeholder values before deploying ==`);
            logger.info({ stackId, template: tmpl }, 'Preloaded env from template');
            break outer;
          }
        }
      }
    }
  }

  if (update.compose_content !== undefined || update.env_content !== undefined) {
    await db('managed_stacks').where({ id: stackId }).update(update);
  }
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
    await syncFromDisk(stackId, stack.composeProject);
    const composeFound = COMPOSE_CANDIDATES.some(n => fs.existsSync(path.join(dir, n)));
    emitProgress(stack.composeProject, composeFound
      ? '== compose file loaded into editor =='
      : '⚠ No docker-compose.yml found at project root — editor compose left unchanged');
    logger.info({ stackId, fileCount: count, dir, composeFound }, 'ZIP source extracted');
  },

  /**
   * Set or change the git source for this stack: clones into the stack dir on first call,
   * resets to the requested branch on subsequent calls. Preserves the operator's .env across
   * the clone wipe.
   *
   * Auth: when the stack has git_username + git_token_enc set (e.g. Gitea deploy token, GitHub
   * PAT), the URL is rewritten `https://<user>:<token>@host/path.git` for this single git
   * invocation. Never touched globally, never logged, never persisted on disk (git remote
   * still stores the ORIGINAL URL, so subsequent gitPull calls re-inject the token fresh).
   */
  async setGitSource(
    stackId: number,
    gitUrl: string,
    branch: string,
    opts: { username?: string | null; token?: string | null; composePath?: string | null } = {},
  ): Promise<void> {
    // Persist auth + compose_path BEFORE the clone so _buildAuthenticatedUrl picks them up.
    // token: undefined = keep existing, '' = clear, non-empty = store encrypted.
    if (opts.username !== undefined || opts.token !== undefined || opts.composePath !== undefined) {
      await managedStackService.update(stackId, {
        gitUsername: opts.username,
        gitToken: opts.token,
        composePath: opts.composePath,
      });
    }
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
      const authenticatedUrl = await this._buildAuthenticatedUrl(stackId, gitUrl);
      const { stdout, stderr } = await execFileP('git', [
        // Reset origin URL to the un-authenticated form immediately after clone so the token
        // isn't stored on disk in .git/config. (--config core.askpass=/bin/true would prompt-fail
        // instead of hanging if the URL didn't already carry credentials.)
        '-c', 'credential.helper=', '-c', 'core.askpass=echo',
        'clone', '--depth', '1', '--branch', branch, authenticatedUrl, tmpClone,
      ], { timeout: 5 * 60 * 1000 });
      // Immediately scrub the token out of .git/config by resetting origin.
      try {
        await execFileP('git', ['-C', tmpClone, 'remote', 'set-url', 'origin', gitUrl], { timeout: 5000 });
      } catch { /* best-effort scrub — the token would only be readable by the container's root */ }
      if (stdout) emitProgress(stack.composeProject, stdout);
      if (stderr) emitProgress(stack.composeProject, this._scrubTokenFromLog(stderr, gitUrl));
    } catch (err) {
      fs.rmSync(tmpClone, { recursive: true, force: true });
      const scrubbed = err instanceof Error ? this._scrubTokenFromLog(err.message, gitUrl) : String(err);
      throw new AppError(400, `git clone failed: ${scrubbed}`);
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
    await syncFromDisk(stackId, stack.composeProject);
    emitProgress(stack.composeProject, `== Cloned at ${ref || '(unknown ref)'} — compose loaded into editor ==`);
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
      // Re-inject the auth token as a per-call remote override. `git pull -c http.extraheader=...`
      // would only work for the fetch step; using `set-url` before + reset after is simpler and
      // works for both HTTPS Basic (Gitea deploy tokens) and PAT auth.
      const authUrl = await this._buildAuthenticatedUrl(stackId, stack.gitUrl);
      let restored = false;
      try {
        await execFileP('git', ['-C', dir, 'remote', 'set-url', 'origin', authUrl], { timeout: 5000 });
        const { stdout, stderr } = await execFileP('git', [
          '-C', dir, '-c', 'credential.helper=', '-c', 'core.askpass=echo',
          'pull', '--ff-only', 'origin', stack.gitBranch || 'main',
        ], { timeout: 5 * 60 * 1000 });
        if (stdout) emitProgress(stack.composeProject, stdout);
        if (stderr) emitProgress(stack.composeProject, this._scrubTokenFromLog(stderr, stack.gitUrl));
      } finally {
        // Scrub the token back out no matter what happens above.
        try { await execFileP('git', ['-C', dir, 'remote', 'set-url', 'origin', stack.gitUrl], { timeout: 5000 }); restored = true; } catch { /* ignore */ }
      }
      if (!restored) logger.warn({ stackId }, 'Failed to scrub auth token from git remote after pull — token still in .git/config');
    } catch (err) {
      const scrubbed = err instanceof Error ? this._scrubTokenFromLog(err.message, stack.gitUrl) : String(err);
      throw new AppError(400, `git pull failed: ${scrubbed}`);
    }

    const ref = await this._resolveGitRef(dir);
    await markSynced(stackId, { gitRef: ref });
    await syncFromDisk(stackId, stack.composeProject);
    emitProgress(stack.composeProject, `== Updated to ${ref || '(unknown ref)'} — compose reloaded into editor ==`);
    logger.info({ stackId, ref }, 'Git source pulled');
  },

  /**
   * Roll a git-sourced stack back (or forward) to a specific ref — commit SHA, tag or
   * branch name. Uses `git fetch --depth=1 origin <ref>` so we don't need a full history
   * (the initial clone was shallow) and `checkout FETCH_HEAD` so the working tree lands
   * on the requested state without polluting local branches. Records the resolved short
   * SHA on the row so the deploy history shows what actually got deployed.
   */
  async checkoutGitRef(stackId: number, gitRef: string): Promise<void> {
    const stack = await managedStackService.getById(stackId);
    if (!stack) throw new AppError(404, 'Stack not found');
    if (stack.sourceType !== 'git' || !stack.gitUrl) throw new AppError(400, 'Stack is not git-sourced');
    if (!gitRef.trim()) throw new AppError(400, 'gitRef required');

    const dir = stackDir(stack.composeProject);
    if (!fs.existsSync(path.join(dir, '.git'))) {
      logger.warn({ stackId }, '.git missing for rollback — re-cloning at target ref');
      await this.setGitSource(stackId, stack.gitUrl, gitRef);
      return;
    }
    emitProgress(stack.composeProject, `== git checkout ${gitRef} ==`);
    try {
      const authUrl = await this._buildAuthenticatedUrl(stackId, stack.gitUrl);
      try {
        await execFileP('git', ['-C', dir, 'remote', 'set-url', 'origin', authUrl], { timeout: 5000 });
        await execFileP('git', ['-C', dir, '-c', 'credential.helper=', '-c', 'core.askpass=echo',
          'fetch', '--depth', '1', 'origin', gitRef], { timeout: 5 * 60 * 1000 });
        await execFileP('git', ['-C', dir, 'checkout', '--force', 'FETCH_HEAD'], { timeout: 60_000 });
      } finally {
        try { await execFileP('git', ['-C', dir, 'remote', 'set-url', 'origin', stack.gitUrl], { timeout: 5000 }); } catch { /* ignore */ }
      }
    } catch (err) {
      const scrubbed = err instanceof Error ? this._scrubTokenFromLog(err.message, stack.gitUrl) : String(err);
      throw new AppError(400, `git checkout ${gitRef} failed: ${scrubbed}`);
    }
    const ref = await this._resolveGitRef(dir);
    await markSynced(stackId, { gitRef: ref });
    await syncFromDisk(stackId, stack.composeProject);
    emitProgress(stack.composeProject, `== Checked out ${ref || gitRef} — compose reloaded into editor ==`);
    logger.info({ stackId, gitRef, ref }, 'Git ref checked out (rollback)');
  },

  /** Best-effort short SHA of HEAD; returns null when not a git repo. */
  async _resolveGitRef(dir: string): Promise<string | null> {
    try {
      const { stdout } = await execFileP('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 });
      return stdout.trim() || null;
    } catch { return null; }
  },

  /**
   * If the stack has git_username + git_token stored, rewrite the URL to
   * `https://<user>:<token>@host/path`. Only HTTPS URLs are augmented — ssh:// URLs go
   * unmodified (SSH auth is a separate feature we don't ship yet). Public repos with no
   * credentials also pass through as-is.
   */
  async _buildAuthenticatedUrl(stackId: number, gitUrl: string): Promise<string> {
    const stack = await managedStackService.getById(stackId);
    if (!stack?.gitUsername || !stack.hasGitToken) return gitUrl;
    if (!/^https?:\/\//i.test(gitUrl)) return gitUrl;
    const token = await managedStackService.getGitToken(stackId);
    if (!token) return gitUrl;
    try {
      const u = new URL(gitUrl);
      u.username = encodeURIComponent(stack.gitUsername);
      u.password = encodeURIComponent(token);
      return u.toString();
    } catch {
      // Malformed URL — hand back the original, the git command will surface a proper error.
      return gitUrl;
    }
  },

  /**
   * Best-effort scrub of the token from any git error/log output before it hits the operator
   * console. Handles both `https://user:token@host` and the encoded form we inject.
   */
  _scrubTokenFromLog(log: string, gitUrl: string): string {
    try {
      const u = new URL(gitUrl);
      // Only rewrite if the original URL was clean — if the operator pasted a URL that already
      // contained credentials, we don't try to guess the shape.
      if (u.username || u.password) return log;
      const hostPart = `${u.protocol}//${u.host}`;
      return log.replace(new RegExp(`${hostPart.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}[^@\\s]*@`, 'g'), `${hostPart}//***@`);
    } catch { return log; }
  },

  /**
   * Peek at the remote HEAD SHA without cloning — used by the git-poller worker to decide if
   * a pull+rebuild is needed. Applies auth the same way as clone/pull. Returns null on any
   * failure (network, auth, unknown branch) so the poller can just try again next tick.
   */
  async remoteHeadRef(stackId: number, gitUrl: string, branch: string): Promise<string | null> {
    try {
      const authUrl = await this._buildAuthenticatedUrl(stackId, gitUrl);
      const { stdout } = await execFileP('git', [
        '-c', 'credential.helper=', '-c', 'core.askpass=echo',
        'ls-remote', '--exit-code', authUrl, `refs/heads/${branch}`,
      ], { timeout: 30_000 });
      // Output shape: "<full-sha>\trefs/heads/<branch>\n"
      const sha = stdout.split(/\s+/)[0]?.trim();
      // Match the short-SHA format used by _resolveGitRef so comparisons are apples-to-apples.
      return sha ? sha.substring(0, 7) : null;
    } catch (err) {
      logger.debug({ stackId, err: err instanceof Error ? err.message : String(err) }, 'remoteHeadRef failed');
      return null;
    }
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
