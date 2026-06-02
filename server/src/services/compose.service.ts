import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import Docker from 'dockerode';
import type { Server as SocketIOServer } from 'socket.io';
import { SOCKET_EVENTS } from '@oblihub/shared';
import { config } from '../config';
import { logger } from '../utils/logger';
import { dockerService } from './docker.service';

interface ComposeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Active compose processes keyed by project name — used to cancel stuck deploys.
const activeProcesses = new Map<string, ChildProcess>();

let _io: SocketIOServer | null = null;
export function setComposeServiceIO(io: SocketIOServer): void { _io = io; }

function ensureStacksDir(): void {
  if (!fs.existsSync(config.stacksDir)) {
    fs.mkdirSync(config.stacksDir, { recursive: true });
  }
}

function getStackDir(projectName: string): string {
  return path.join(config.stacksDir, projectName);
}

export const composeService = {
  /** Write compose + env files to disk */
  writeStackFiles(projectName: string, composeContent: string, envContent: string | null): string {
    ensureStacksDir();
    const stackDir = getStackDir(projectName);
    if (!fs.existsSync(stackDir)) {
      fs.mkdirSync(stackDir, { recursive: true });
    }
    fs.writeFileSync(path.join(stackDir, 'docker-compose.yml'), composeContent, 'utf8');
    if (envContent) {
      fs.writeFileSync(path.join(stackDir, '.env'), envContent, 'utf8');
    } else {
      const envPath = path.join(stackDir, '.env');
      if (fs.existsSync(envPath)) fs.unlinkSync(envPath);
    }
    return stackDir;
  },

  /** Remove stack files from disk */
  removeStackFiles(projectName: string): void {
    const stackDir = getStackDir(projectName);
    if (fs.existsSync(stackDir)) {
      fs.rmSync(stackDir, { recursive: true, force: true });
    }
  },

  /**
   * Resolve the env vars the `docker compose` CLI needs to target a remote engine.
   * - local → no env (default behavior, talks to /var/run/docker.sock)
   * - ssh → DOCKER_HOST=ssh://user@host:port (the CLI uses ssh2-like behavior — needs SSH agent
   *         OR known key. We write the private key to a temp file for the duration of the command.)
   * - tls → DOCKER_HOST=tcp://host:port + DOCKER_TLS_VERIFY=1 + DOCKER_CERT_PATH (temp dir with ca/cert/key)
   * - https-apikey → NOT SUPPORTED — the docker CLI cannot inject custom HTTP headers.
   *                   Deploy via compose CLI is impossible. Throw a clear error.
   *
   * Returns the env vars to merge into the child process AND a cleanup function for temp files.
   */
  async _resolveEngineEnv(engineId: number | null): Promise<{ env: Record<string, string>; cleanup: () => void }> {
    if (engineId == null) return { env: {}, cleanup: () => {} };
    const { engineService } = await import('./engine.service');
    const engine = await engineService.getById(engineId);
    if (!engine) throw new Error(`Engine ${engineId} not found`);
    if (engine.type === 'local') return { env: {}, cleanup: () => {} };
    if (engine.type === 'https-apikey') {
      throw new Error(
        `Engine "${engine.name}" uses HTTP + API key (socket-proxy). The docker compose CLI does not support custom HTTP headers, so managed stack deployment is not possible on this engine. Use SSH or TLS for engines you intend to deploy stacks on.`
      );
    }

    // For SSH and TLS we need to write secret material to a temp dir, set env, return cleanup.
    const fs2 = await import('fs');
    const os = await import('os');
    const tmp = fs2.mkdtempSync(path.join(os.tmpdir(), `oblihub-engine-${engineId}-`));
    const cleanup = () => { try { fs2.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } };

    if (engine.type === 'ssh') {
      if (!engine.host || !engine.sshUser) { cleanup(); throw new Error(`Engine ${engineId} (ssh) missing host/user`); }
      const { db } = await import('../db');
      const row = await db('docker_engines').where({ id: engineId }).first() as { ssh_private_key_enc: string | null } | undefined;
      if (!row?.ssh_private_key_enc) { cleanup(); throw new Error(`Engine ${engineId} (ssh) missing private key`); }
      const { decryptSecret } = await import('../utils/crypto');
      const privateKey = decryptSecret(row.ssh_private_key_enc);
      const { execFileSync, execSync } = await import('node:child_process');
      const os = await import('node:os');

      // Approach: the docker CLI shells out to /usr/bin/ssh and passes a fixed set of options
      // (-T, -l, -p, -o ConnectTimeout=30) — there's no env var hook to inject extra options,
      // and HOME override doesn't take effect either (alpine's openssh resolves the user's home
      // via getpwuid, ignoring $HOME). The only reliable surface is the real user's ssh dotfiles.
      //
      // We therefore:
      //   1. Write the per-engine private key to a tmp file (perms 0600).
      //   2. Ensure $REAL_HOME/.ssh exists with 0700.
      //   3. Pre-populate $REAL_HOME/.ssh/known_hosts via ssh-keyscan so strict host-key checking
      //      passes naturally. If the engine has a pinned sshKnownHost we use that instead.
      //   4. Append a Host-specific block to $REAL_HOME/.ssh/config that points IdentityFile at
      //      our tmp key. The block is delimited by markers (`# oblihub:engine-<id> begin/end`)
      //      so cleanup is idempotent and concurrent deploys to *different* engines don't step
      //      on each other.
      //   5. On cleanup, remove the block and tmp key.
      //
      // Concurrent deploys to the SAME engine on the same Oblihub instance would race on the
      // marker block; that's acceptable since deploys for one engine are serialized upstream
      // (activeProcesses Map in runCompose).
      const REAL_HOME = os.homedir(); // honors /etc/passwd, not $HOME
      const sshDir = path.join(REAL_HOME, '.ssh');
      if (!fs2.existsSync(sshDir)) fs2.mkdirSync(sshDir, { mode: 0o700, recursive: true });
      try { fs2.chmodSync(sshDir, 0o700); } catch { /* not fatal */ }

      const keyFile = path.join(tmp, 'id_engine');
      fs2.writeFileSync(keyFile, privateKey, { mode: 0o600 });

      // ── Known hosts ──
      const knownHostsFile = path.join(sshDir, 'known_hosts');
      if (engine.sshKnownHost) {
        // Pinned key — append if not already present
        const existing = fs2.existsSync(knownHostsFile) ? fs2.readFileSync(knownHostsFile, 'utf8') : '';
        const pinned = engine.sshKnownHost.trim();
        if (!existing.includes(pinned)) {
          fs2.appendFileSync(knownHostsFile, pinned + '\n', { mode: 0o600 });
        }
      } else {
        // No pinned key — fetch via ssh-keyscan (TOFU). If a key for this host already exists,
        // we keep it; ssh-keyscan failure is non-fatal — ssh will produce its own error if the
        // connection fails for another reason, which is more useful than aborting here.
        try {
          const scan = execFileSync(
            'ssh-keyscan',
            ['-T', '5', '-p', String(engine.port ?? 22), engine.host],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
          );
          const existing = fs2.existsSync(knownHostsFile) ? fs2.readFileSync(knownHostsFile, 'utf8') : '';
          // Append only lines not already present (cheap dedup — ssh handles dupes anyway).
          const fresh = scan.split('\n').filter((l) => l.trim() && !existing.includes(l.trim())).join('\n');
          if (fresh) fs2.appendFileSync(knownHostsFile, fresh + '\n', { mode: 0o600 });
        } catch (err) {
          logger.warn({ engineId, host: engine.host, err: err instanceof Error ? err.message : String(err) }, 'ssh-keyscan failed — continuing anyway');
        }
      }
      try { fs2.chmodSync(knownHostsFile, 0o600); } catch { /* not fatal */ }

      // ── Host-specific config block ──
      const configFile = path.join(sshDir, 'config');
      const beginMarker = `# oblihub:engine-${engineId} begin`;
      const endMarker = `# oblihub:engine-${engineId} end`;
      const block = [
        beginMarker,
        `Host ${engine.host}`,
        `  IdentityFile ${keyFile}`,
        '  IdentitiesOnly yes',
        '  LogLevel ERROR',
        '  ServerAliveInterval 30',
        endMarker,
        '',
      ].join('\n');

      // Atomically rewrite the config: strip any prior block for this engine, append the new one.
      const stripOldBlock = (content: string): string => {
        const lines = content.split('\n');
        const out: string[] = [];
        let inBlock = false;
        for (const line of lines) {
          if (line === beginMarker) { inBlock = true; continue; }
          if (line === endMarker) { inBlock = false; continue; }
          if (!inBlock) out.push(line);
        }
        return out.join('\n').replace(/\n{3,}/g, '\n\n');
      };
      const prior = fs2.existsSync(configFile) ? fs2.readFileSync(configFile, 'utf8') : '';
      fs2.writeFileSync(configFile, stripOldBlock(prior) + block, { mode: 0o600 });

      // Augment cleanup to also remove our block from the persistent config + the key.
      const sshCleanup = () => {
        try {
          const c = fs2.existsSync(configFile) ? fs2.readFileSync(configFile, 'utf8') : '';
          fs2.writeFileSync(configFile, stripOldBlock(c), { mode: 0o600 });
        } catch { /* ignore */ }
        cleanup();
      };

      // Diagnostic: ensure ssh-keyscan / ssh binaries exist before declaring success. Helps
      // surface a clear error when openssh-client is missing from the server image rather than
      // a vague connect failure deep in docker compose.
      try {
        execSync('which ssh', { stdio: 'ignore' });
      } catch {
        sshCleanup();
        throw new Error('openssh-client (ssh) is not installed in the server image — cannot deploy via SSH engine.');
      }

      const dockerHost = `ssh://${engine.sshUser}@${engine.host}:${engine.port ?? 22}`;
      return {
        env: {
          DOCKER_HOST: dockerHost,
        },
        cleanup: sshCleanup,
      };
    }

    if (engine.type === 'tls') {
      if (!engine.host || !engine.tlsCa || !engine.tlsCert) { cleanup(); throw new Error(`Engine ${engineId} (tls) missing host/ca/cert`); }
      const { db } = await import('../db');
      const row = await db('docker_engines').where({ id: engineId }).first() as { tls_key_enc: string | null } | undefined;
      if (!row?.tls_key_enc) { cleanup(); throw new Error(`Engine ${engineId} (tls) missing key`); }
      const { decryptSecret } = await import('../utils/crypto');
      const tlsKey = decryptSecret(row.tls_key_enc);
      fs2.writeFileSync(path.join(tmp, 'ca.pem'), engine.tlsCa);
      fs2.writeFileSync(path.join(tmp, 'cert.pem'), engine.tlsCert);
      fs2.writeFileSync(path.join(tmp, 'key.pem'), tlsKey, { mode: 0o600 });
      return {
        env: {
          DOCKER_HOST: `tcp://${engine.host}:${engine.port ?? 2376}`,
          DOCKER_TLS_VERIFY: '1',
          DOCKER_CERT_PATH: tmp,
        },
        cleanup,
      };
    }

    cleanup();
    throw new Error(`Unsupported engine type for compose CLI: ${engine.type}`);
  },

  /**
   * Run a docker compose command — optionally targeting a remote engine.
   *
   * Uses spawn() (not exec) so stdout/stderr stream to clients via Socket.io as they arrive.
   *
   * No automatic timeout: pulling a multi-GB image over SSH legitimately takes 15-30 minutes,
   * any value we'd pick would be wrong for someone. The operator sees the live log and clicks
   * Cancel when (and only when) they decide the process is stuck. The `cancel(projectName)`
   * method kills via SIGTERM + SIGKILL after 3s.
   *
   * `idleTimeoutMs > 0` re-enables a safety net (idle-only, reset on each chunk) — used by
   * short housekeeping ops like `ps` to avoid hanging indefinitely on a broken engine.
   */
  async runCompose(
    projectName: string,
    args: string[],
    idleTimeoutMs = 0,
    engineId: number | null = null,
  ): Promise<ComposeResult> {
    const stackDir = getStackDir(projectName);
    const cmdString = `docker compose -p "${projectName}" -f docker-compose.yml ${args.join(' ')}`;

    let envInjection: { env: Record<string, string>; cleanup: () => void };
    try {
      envInjection = await this._resolveEngineEnv(engineId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ projectName, engineId, err: message }, 'Compose engine env resolution failed');
      _io?.emit(SOCKET_EVENTS.COMPOSE_FINISHED, { projectName, exitCode: 1, durationMs: 0 });
      return { exitCode: 1, stdout: '', stderr: message };
    }

    logger.info({ projectName, engineId, cmd: cmdString, idleTimeoutMs }, 'Running compose command');

    return new Promise((resolve) => {
      const startedAt = Date.now();
      const spawnArgs = ['compose', '-p', projectName, '-f', 'docker-compose.yml', ...args];
      const child = spawn('docker', spawnArgs, {
        cwd: stackDir,
        env: { ...process.env, ...envInjection.env },
      });

      activeProcesses.set(projectName, child);
      _io?.emit(SOCKET_EVENTS.COMPOSE_STARTED, { projectName, cmd: cmdString });

      let stdoutBuf = '';
      let stderrBuf = '';
      // Cap retained buffer to 5 MB per stream so very long-running commands don't OOM the server.
      // Live output still streams to clients in real time; this only affects the final result blob.
      const MAX_BUF = 5 * 1024 * 1024;

      let idleTimer: NodeJS.Timeout | null = null;
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (idleTimeoutMs > 0) {
          idleTimer = setTimeout(() => {
            logger.warn({ projectName, idleTimeoutMs }, 'Compose command idle timeout — killing process');
            try { child.kill('SIGTERM'); } catch { /* ignore */ }
            setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
          }, idleTimeoutMs);
        }
      };
      resetIdle();

      const onChunk = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
        resetIdle();
        const chunk = data.toString();
        if (stream === 'stdout') {
          stdoutBuf = (stdoutBuf + chunk).slice(-MAX_BUF);
        } else {
          stderrBuf = (stderrBuf + chunk).slice(-MAX_BUF);
        }
        _io?.emit(SOCKET_EVENTS.COMPOSE_LOG, { projectName, stream, chunk });
      };
      child.stdout?.on('data', onChunk('stdout'));
      child.stderr?.on('data', onChunk('stderr'));

      child.on('error', (err) => {
        if (idleTimer) clearTimeout(idleTimer);
        activeProcesses.delete(projectName);
        envInjection.cleanup();
        const message = err.message;
        _io?.emit(SOCKET_EVENTS.COMPOSE_FINISHED, { projectName, exitCode: 1, durationMs: Date.now() - startedAt });
        logger.warn({ projectName, err: message }, 'Compose spawn error');
        resolve({ exitCode: 1, stdout: stdoutBuf, stderr: stderrBuf || message });
      });

      child.on('close', (code, signal) => {
        if (idleTimer) clearTimeout(idleTimer);
        activeProcesses.delete(projectName);
        envInjection.cleanup();
        const killedByCancel = (child as ChildProcess & { _cancelled?: boolean })._cancelled === true;
        const exitCode = killedByCancel ? 130 : (code ?? (signal ? 1 : 0));
        const durationMs = Date.now() - startedAt;
        _io?.emit(SOCKET_EVENTS.COMPOSE_FINISHED, { projectName, exitCode, durationMs });
        logger.info({ projectName, exitCode, signal, durationMs, cancelled: killedByCancel }, 'Compose command finished');
        resolve({
          exitCode,
          stdout: stdoutBuf,
          stderr: killedByCancel ? 'Cancelled by user' : stderrBuf,
        });
      });
    });
  },

  /** Cancel an in-flight compose command for a project. Returns true if a process was killed. */
  cancel(projectName: string): boolean {
    const child = activeProcesses.get(projectName);
    if (!child || child.killed) return false;

    (child as ChildProcess & { _cancelled?: boolean })._cancelled = true;
    logger.warn({ projectName, pid: child.pid }, 'Cancelling compose command');

    try { child.kill('SIGTERM'); } catch { /* ignore */ }

    // Force kill after 3s if still alive
    setTimeout(() => {
      const stillRunning = activeProcesses.get(projectName);
      if (stillRunning && !stillRunning.killed) {
        try { stillRunning.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, 3000);

    return true;
  },

  /** Check if a compose command is currently running for a project */
  isRunning(projectName: string): boolean {
    const child = activeProcesses.get(projectName);
    return !!child && !child.killed;
  },

  /** Deploy a stack (up -d) — no timeout, user cancels via UI. */
  async deploy(projectName: string, composeContent: string, envContent: string | null, engineId: number | null = null): Promise<ComposeResult> {
    this.writeStackFiles(projectName, composeContent, envContent);
    // Make sure the shared `proxy` network exists on the target engine BEFORE compose up — if
    // the user's compose declares `networks: proxy: external: true` (the manual opt-in), compose
    // would error out without it. Idempotent: no-op if the network already exists.
    await dockerService.ensureProxyNetwork(engineId);
    const result = await this.runCompose(projectName, ['up', '-d', '--remove-orphans'], 0, engineId);
    // After a successful up, attach every container of this stack to the proxy network.
    // Fire-and-forget per container so a single failure doesn't taint the deploy result —
    // the user already gets compose's exit code as the authoritative success signal.
    if (result.exitCode === 0) {
      await this._attachStackToProxyNetwork(projectName, engineId);
    }
    return result;
  },

  /**
   * Auto-attach every container of a managed stack to the shared `proxy` network so that
   * Oblihub's integrated nginx can resolve `forward_host: <compose-service>` via Docker DNS
   * without published ports. Same-engine only — proxy network membership doesn't span daemons.
   */
  async _attachStackToProxyNetwork(projectName: string, engineId: number | null = null): Promise<void> {
    try {
      const docker = await dockerService.forEngine(engineId);
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`com.docker.compose.project=${projectName}`] },
      });
      for (const c of containers) {
        try {
          await dockerService.connectToProxyNetwork(c.Id, engineId);
        } catch (err) {
          logger.warn({ container: c.Id, project: projectName, err: err instanceof Error ? err.message : String(err) }, 'Failed to attach container to proxy network');
        }
      }
    } catch (err) {
      logger.warn({ projectName, engineId, err: err instanceof Error ? err.message : String(err) }, 'Could not list containers to attach to proxy network');
    }
  },

  /** Stop a stack */
  async stop(projectName: string, engineId: number | null = null): Promise<ComposeResult> {
    return this.runCompose(projectName, ['stop'], 0, engineId);
  },

  /** Down a stack (stop + remove containers + networks) */
  async down(projectName: string, removeVolumes = false, engineId: number | null = null): Promise<ComposeResult> {
    const args = ['down', '--remove-orphans'];
    if (removeVolumes) args.push('-v');
    return this.runCompose(projectName, args, 0, engineId);
  },

  /** Pull images for a stack — no timeout (multi-GB images over SSH can take 30+ minutes). */
  async pull(projectName: string, engineId: number | null = null): Promise<ComposeResult> {
    return this.runCompose(projectName, ['pull'], 0, engineId);
  },

  /** Get compose ps — keep a short idle safety net since it should never hang. */
  async ps(projectName: string, engineId: number | null = null): Promise<ComposeResult> {
    return this.runCompose(projectName, ['ps', '--format', 'json'], 60 * 1000, engineId);
  },

  /** Redeploy: pull + up — both with no timeout. */
  async redeploy(projectName: string, composeContent: string, envContent: string | null, engineId: number | null = null): Promise<ComposeResult> {
    this.writeStackFiles(projectName, composeContent, envContent);
    const pullResult = await this.runCompose(projectName, ['pull'], 0, engineId);
    if (pullResult.exitCode !== 0) return pullResult;
    return this.runCompose(projectName, ['up', '-d', '--remove-orphans'], 0, engineId);
  },

  /**
   * Deploy via a helper container — required for the Oblihub self-stack because `docker compose up`
   * would otherwise kill its own process when it stops the old server container.
   *
   * Writes the compose content to the host's compose workdir (overwriting), then spawns a short-lived
   * `docker:cli` helper that runs `docker compose up -d --remove-orphans` and exits.
   * Returns immediately with exit 0 — the server will be recreated and the new instance takes over.
   */
  async deployViaHelper(projectName: string, composeContent: string, envContent: string | null, pullFirst: boolean): Promise<ComposeResult> {
    const selfId = dockerService.getSelfContainerId();
    if (!selfId) throw new Error('Self-stack deploy requires running inside Docker');

    const docker = new Docker({ socketPath: config.dockerSocket });
    const self = docker.getContainer(selfId);
    const info = await self.inspect();
    const labels = info.Config.Labels || {};
    const hostWorkdir = labels['com.docker.compose.project.working_dir'];
    if (!hostWorkdir) throw new Error('Self-stack deploy requires com.docker.compose.project.working_dir label');

    // Find the host path of our stacks_data mount so the helper can read the content we wrote.
    const stacksMount = (info.Mounts || []).find((m) => m.Destination === '/data/stacks');
    if (!stacksMount?.Source) throw new Error('stacks_data mount not found');
    const hostStacksDir = stacksMount.Source;

    // Write new compose content to /data/stacks/<project>/ (accessible via the volume host path).
    this.writeStackFiles(projectName, composeContent, envContent);

    // Ensure docker:cli is available before we hand off.
    try { await docker.getImage('docker:cli').inspect(); }
    catch {
      logger.info('Self-stack deploy: pulling docker:cli...');
      await dockerService.pullImage('docker', 'cli');
    }

    const pullCmd = pullFirst ? `docker compose -p "${projectName}" pull && ` : '';
    const script = `
set -e
cp /stack-src/docker-compose.yml "${hostWorkdir}/docker-compose.yml"
if [ -f /stack-src/.env ]; then cp /stack-src/.env "${hostWorkdir}/.env"; fi
sleep 2
${pullCmd}docker compose -p "${projectName}" up -d --remove-orphans
`;

    const helper = await docker.createContainer({
      Image: 'docker:cli',
      Cmd: ['sh', '-c', script],
      HostConfig: {
        Binds: [
          '/var/run/docker.sock:/var/run/docker.sock',
          `${hostWorkdir}:${hostWorkdir}`,
          `${hostStacksDir}/${projectName}:/stack-src:ro`,
        ],
        AutoRemove: true,
      } as Docker.HostConfig,
      WorkingDir: hostWorkdir,
    });

    await helper.start();
    logger.info({ projectName, hostWorkdir, helperId: helper.id }, 'Self-stack deploy: helper container started');

    // We're about to be recreated. Return a synthetic success; the new server instance will take over.
    return { exitCode: 0, stdout: 'Self-stack deploy initiated via helper container', stderr: '' };
  },
};
