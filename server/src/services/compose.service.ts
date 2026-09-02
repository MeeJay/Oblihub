import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import Docker from 'dockerode';
import yaml from 'js-yaml';
import type { Server as SocketIOServer } from 'socket.io';
import { SOCKET_EVENTS } from '@oblihub/shared';
import { config } from '../config';
import { logger } from '../utils/logger';
import { dockerService } from './docker.service';
import { db } from '../db';

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
  /**
   * Write compose + env files to disk. Aware of `compose_path`: when the managed_stack has a
   * subpath (e.g. `stack/docker-compose.yml`), the compose file, the `.env`, and any override
   * are written **inside that subdir** — not at the stackDir root. Getting this wrong was the
   * cause of Docker Compose reporting "POSTGRES_PASSWORD not set" despite the operator having
   * filled the env editor: the CLI's cwd is `stackDir/stack/`, so it looked for `.env` there,
   * but we were writing to `stackDir/.env` which it never sees.
   *
   * Legacy stacks (compose_path null) keep the previous root-only behavior.
   */
  async writeStackFiles(projectName: string, composeContent: string, envContent: string | null): Promise<string> {
    ensureStacksDir();
    const stackDir = getStackDir(projectName);
    if (!fs.existsSync(stackDir)) {
      fs.mkdirSync(stackDir, { recursive: true });
    }
    // Resolve the actual dir the compose CLI will run in — same logic as runCompose so both
    // sides always agree on where `.env` and the compose file live.
    const composePath = await this._resolveComposePath(projectName);
    const targetDir = composePath ? path.join(stackDir, path.dirname(composePath)) : stackDir;
    const composeFile = composePath ? path.basename(composePath) : 'docker-compose.yml';
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, composeFile), composeContent, 'utf8');
    const envPath = path.join(targetDir, '.env');
    if (envContent) {
      fs.writeFileSync(envPath, envContent, 'utf8');
      // Chmod 0o600 — the .env decrypts operator secrets to disk for the compose subprocess.
      // Best-effort: the mount may not honor mode changes (windowsfilesystems, etc.).
      try { fs.chmodSync(envPath, 0o600); } catch { /* ignore */ }
    } else if (fs.existsSync(envPath)) {
      fs.unlinkSync(envPath);
    }
    return stackDir;
  },

  /** Look up compose_path from DB — null when the stack is root-based or unknown. */
  async _resolveComposePath(projectName: string): Promise<string | null> {
    try {
      const row = await db('managed_stacks').where({ compose_project: projectName }).select('compose_path').first();
      return (row?.compose_path as string) || null;
    } catch { return null; }
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
    const baseStackDir = getStackDir(projectName);
    // Look up compose_path — set when the compose file lives at a subpath inside the source
    // (Trame-style: `stack/docker-compose.yml`). When set, we use `-f <fullPath>` AND cwd to
    // the compose file's parent directory so relative build.context paths (`./api`) resolve.
    // NULL / empty falls back to the legacy behavior (compose file at repo root).
    const stackRow = await db('managed_stacks').where({ compose_project: projectName }).select('compose_path').first();
    const composePath = (stackRow?.compose_path as string) || null;
    const composeFileArg = composePath ? path.basename(composePath) : 'docker-compose.yml';
    const stackDir = composePath ? path.join(baseStackDir, path.dirname(composePath)) : baseStackDir;
    // Auto-discovery of `docker-compose.override.yml` by Compose ONLY kicks in when the primary
    // file is one of the standard names (compose.yml / docker-compose.yml). For custom names
    // like `docker-compose.prod.yml` we HAVE to pass the override explicitly with `-f` or
    // Compose ignores it entirely — which silently drops Oblihub's proxy-network attachment
    // for every non-standard-name stack. Detect + include when present.
    const overridePath = path.join(stackDir, 'docker-compose.override.yml');
    const includeOverride = composeFileArg !== 'docker-compose.yml' && composeFileArg !== 'compose.yml' && fs.existsSync(overridePath);
    const composeFileArgs = includeOverride
      ? ['-f', composeFileArg, '-f', 'docker-compose.override.yml']
      : ['-f', composeFileArg];
    const cmdString = `docker compose -p "${projectName}" ${composeFileArgs.join(' ')} ${args.join(' ')}`;

    let envInjection: { env: Record<string, string>; cleanup: () => void };
    try {
      envInjection = await this._resolveEngineEnv(engineId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ projectName, engineId, err: message }, 'Compose engine env resolution failed');
      _io?.emit(SOCKET_EVENTS.COMPOSE_FINISHED, { projectName, exitCode: 1, durationMs: 0 });
      return { exitCode: 1, stdout: '', stderr: message };
    }

    // Build a per-stack DOCKER_CONFIG with private registry creds. Cleanup runs after compose
    // exits — no global ~/.docker/config.json pollution across stacks.
    const registryAuth = await this._resolveStackRegistryAuth(projectName);

    logger.info({ projectName, engineId, cmd: cmdString, idleTimeoutMs }, 'Running compose command');

    return new Promise((resolve) => {
      const startedAt = Date.now();
      const spawnArgs = ['compose', '-p', projectName, ...composeFileArgs, ...args];
      // ⚠ SECURITY-CRITICAL — env scrub.
      //
      // Spreading `process.env` into the subprocess used to leak Oblihub's OWN env (admin creds,
      // session secret, DB password, …) into every managed stack we deploy. Docker Compose
      // resolves `${VAR}` substitutions from the SHELL ENVIRONMENT first, .env file second.
      // So a child stack with `DEFAULT_ADMIN_USERNAME: ${DEFAULT_ADMIN_USERNAME:-admin}` in its
      // compose received Oblihub's value instead of the operator's intended value — even when
      // the stack's own .env file said something else. All deployed Obli* templates were
      // affected because they share Oblihub's env var names.
      //
      // Fix: ship only the OS basics + Docker routing the CLI actually needs. Everything else
      // (secrets, app config) comes from the stack's own .env file at `cwd: stackDir`.
      const SAFE_PASSTHROUGH = [
        'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE',
        'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'HOSTNAME',
        'TMPDIR', 'TEMP', 'TMP', 'PWD',
        'DOCKER_BUILDKIT', 'COMPOSE_DOCKER_CLI_BUILD',
      ];
      const childEnv: Record<string, string> = {};
      for (const k of SAFE_PASSTHROUGH) {
        const v = process.env[k];
        if (v !== undefined) childEnv[k] = v;
      }
      // Explicit overrides from _resolveEngineEnv (DOCKER_HOST, DOCKER_TLS_VERIFY, HOME for ssh,
      // etc.) come LAST and are always honored — these are the bits Oblihub legitimately needs
      // the CLI to see.
      Object.assign(childEnv, envInjection.env);
      // Per-stack DOCKER_CONFIG — only set when this stack actually has registry credentials.
      // The docker CLI reads `${DOCKER_CONFIG}/config.json` instead of `~/.docker/config.json`.
      if (registryAuth.dockerConfigDir) {
        childEnv.DOCKER_CONFIG = registryAuth.dockerConfigDir;
      }

      const child = spawn('docker', spawnArgs, {
        cwd: stackDir,
        env: childEnv,
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
        registryAuth.cleanup();
        const message = err.message;
        _io?.emit(SOCKET_EVENTS.COMPOSE_FINISHED, { projectName, exitCode: 1, durationMs: Date.now() - startedAt });
        logger.warn({ projectName, err: message }, 'Compose spawn error');
        resolve({ exitCode: 1, stdout: stdoutBuf, stderr: stderrBuf || message });
      });

      child.on('close', (code, signal) => {
        if (idleTimer) clearTimeout(idleTimer);
        activeProcesses.delete(projectName);
        envInjection.cleanup();
        registryAuth.cleanup();
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
    await this.writeStackFiles(projectName, composeContent, envContent);
    // Make sure the shared `proxy` network exists on the target engine BEFORE compose up — if
    // the user's compose declares `networks: proxy: external: true` (the manual opt-in), compose
    // would error out without it. Idempotent: no-op if the network already exists.
    await dockerService.ensureProxyNetwork(engineId);
    // Generate a docker-compose.override.yml that attaches the `proxy` network ONLY to the
    // services targeted by a proxy_host. Compose auto-discovers `docker-compose.override.yml`
    // and merges it into the deploy — no need for an explicit -f flag. Doing this declaratively
    // (instead of post-deploy `docker network connect`) keeps membership visible to the operator
    // AND survives compose down/up correctly.
    await this._writeProxyOverride(projectName, composeContent);
    const upArgs = await this._buildAwareUpArgs(projectName);
    const result = await this.runCompose(projectName, upArgs, 0, engineId);
    // After a successful up, reconcile: anything currently on `proxy` that ISN'T a targeted
    // service gets disconnected. Cleans up the legacy "everything attached" behaviour.
    if (result.exitCode === 0) {
      await this._reconcileProxyNetworkMembership(projectName, composeContent, engineId);
    }
    return result;
  },

  /**
   * Write `docker-compose.override.yml` next to the user's compose. The override attaches the
   * shared `proxy` network ONLY to services that are targeted by an existing proxy_host (by
   * matching `forward_host` against compose service names). Other services stay out of the
   * proxy network — Postgres, Redis, MinIO etc. don't need to be reachable by the public-facing
   * nginx.
   *
   * If the user's own compose already declares a top-level `proxy` network (manual opt-in or
   * advanced setup), we skip the override entirely and let them own the wiring.
   */
  async _writeProxyOverride(projectName: string, composeContent: string): Promise<void> {
    const baseStackDir = getStackDir(projectName);
    // Override must live NEXT to the compose file, not at the repo root — Docker Compose only
    // auto-discovers `docker-compose.override.yml` in the same directory as the file passed to
    // `-f` (or its cwd). Writing to the root when compose_path is set was a silent no-op — the
    // proxy network wiring never got applied on Trame-style stacks.
    const composePath = await this._resolveComposePath(projectName);
    const stackDir = composePath ? path.join(baseStackDir, path.dirname(composePath)) : baseStackDir;
    const overridePath = path.join(stackDir, 'docker-compose.override.yml');
    try {
      const targets = await this._detectProxiedServices(projectName, composeContent);
      if (targets.userOwnsProxyNetwork) {
        // Don't fight the operator. If their compose declares `proxy:` already, our override
        // would either be redundant or conflict — bail and let them do it their way.
        if (fs.existsSync(overridePath)) fs.unlinkSync(overridePath);
        return;
      }
      if (targets.services.length === 0) {
        // Nothing is proxied yet — no override needed. Clean up any stale override from a
        // previous deploy.
        if (fs.existsSync(overridePath)) fs.unlinkSync(overridePath);
        return;
      }
      // Collect the union of every network name referenced by every proxy_host targeting this
      // stack. A service can appear on multiple networks (e.g. one proxy_host on Oblihub's own
      // `proxy` + a second on `nginx-proxy-manager_default`) — the override wires both.
      const allNetworks = new Set<string>();
      const svcToNets = targets.servicesToNetworks || new Map<string, Set<string>>();
      for (const nets of svcToNets.values()) for (const n of nets) allNetworks.add(n);
      const networksBlock: Record<string, unknown> = {};
      for (const n of allNetworks) networksBlock[n] = { external: true, name: n };
      const override: { networks: Record<string, unknown>; services: Record<string, unknown> } = {
        networks: networksBlock,
        services: {},
      };
      for (const svc of targets.services) {
        const svcNets = [...(svcToNets.get(svc) || new Set<string>())];
        // Prepend `default` to preserve implicit-default connectivity for services that don't
        // declare their own networks in the base compose.
        override.services[svc] = { networks: ['default', ...svcNets] };
      }
      const netList = [...allNetworks].join(', ');
      const header = `# Auto-generated by Oblihub — DO NOT EDIT\n# Attaches the following network(s) to services targeted by a proxy_host: ${netList}\n# Re-generated on every deploy and every proxy_host save.\n`;
      fs.writeFileSync(overridePath, header + yaml.dump(override), 'utf8');
      logger.info({ projectName, services: targets.services, networks: [...allNetworks] }, 'Wrote proxy network override');
    } catch (err) {
      logger.warn({ projectName, err: err instanceof Error ? err.message : String(err) }, 'Failed to write proxy network override');
    }
  },

  /**
   * Given a stack's compose_project and its compose YAML, return the list of compose SERVICE
   * NAMES whose containers should be on the shared `proxy` network.
   *
   * Matching rule: for a proxy_host to target a service in THIS stack, its `forward_host`
   * must match either
   *   - the compose service name (`web`), OR
   *   - the container_name that compose will assign to that service — either the operator's
   *     explicit `container_name: foo` value, or the compose-default `<project>-<svc>-<n>` /
   *     `<project>_<svc>_<n>` form.
   *
   * Scoping: the proxy_host's `stack_id` (via `stacks.compose_project`) is used to filter
   * OUT proxy_hosts belonging to other stacks. Without this, a proxy_host targeting a `web`
   * service in stack A would also incorrectly target a `web` service in stack B (or any
   * container of another stack that happens to share a name), breaking every multi-stack
   * deployment. Unlinked proxy_hosts (stack_id null) fall back to global matching — legacy
   * behavior kept for backward compat.
   */
  async _detectProxiedServices(projectName: string, composeContent: string): Promise<{ services: string[]; userOwnsProxyNetwork: boolean; servicesToNetworks?: Map<string, Set<string>> }> {
    let parsed: { services?: Record<string, unknown>; networks?: Record<string, unknown> } = {};
    try {
      parsed = (yaml.load(composeContent) || {}) as typeof parsed;
    } catch (err) {
      logger.warn({ projectName, err }, 'Compose YAML parse failed during proxy override detection');
      return { services: [], userOwnsProxyNetwork: false };
    }
    const proxyNetworkName = await dockerService.getProxyNetworkName();
    const userOwnsProxyNetwork = !!(parsed.networks && Object.prototype.hasOwnProperty.call(parsed.networks, proxyNetworkName));
    const rawServices = parsed.services || {};
    const serviceNames = Object.keys(rawServices);
    if (serviceNames.length === 0) return { services: [], userOwnsProxyNetwork };

    // Load the stack's env for `${VAR}` substitution in container_name. Compose resolves
    // interpolations at runtime; a naive YAML parse leaves us with literal strings like
    // `${COMPOSE_PROJECT_NAME:-trameplm}-web` that won't match anything on disk.
    // COMPOSE_PROJECT_NAME defaults to the stack's compose_project when not explicitly set,
    // which mirrors compose's own behavior when invoked via `-p`.
    const stackRow = await db('managed_stacks').where({ compose_project: projectName }).select('env_content', 'env_content_enc').first();
    const envMap: Record<string, string> = { COMPOSE_PROJECT_NAME: projectName };
    let envText: string | null = null;
    if (stackRow?.env_content_enc) {
      try { const { decryptSecret } = await import('../utils/crypto'); envText = decryptSecret(stackRow.env_content_enc as string); } catch { /* ignore */ }
    }
    if (!envText && stackRow?.env_content) envText = stackRow.env_content as string;
    if (envText) {
      for (const line of envText.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        envMap[m[1]] = v;
      }
    }
    // CRITICAL: Docker Compose's `-p <name>` CLI flag always wins over any COMPOSE_PROJECT_NAME
    // from the .env — that's how compose's own variable substitution behaves at runtime, so the
    // container name compose actually creates is derived from `projectName` (what we invoke `-p`
    // with), not from whatever the operator wrote in their .env. If we let the operator env
    // overwrite this, our alias resolution ends up pointing at a container name that no real
    // container matches, and forward_host lookups silently fail. Force it back AFTER the env
    // merge so we mirror compose's runtime behavior exactly.
    envMap.COMPOSE_PROJECT_NAME = projectName;
    // Resolve `${VAR}` / `${VAR:-default}` / `${VAR-default}` / `${VAR:?err}` / `${VAR?err}`.
    // Supports one level of nesting (default value can be another ${...}) which covers all
    // realistic compose patterns.
    const resolveVars = (str: string): string => {
      return str.replace(/\$\{([A-Z_][A-Z0-9_]*)(:?[-?])?([^}]*)\}/g, (_full, name, sep, rest) => {
        const val = envMap[name];
        if (val !== undefined && val !== '') return val;
        if (val === '' && sep === '-') return val; // `${VAR-default}` treats empty as set
        if (sep === ':-' || sep === '-') return rest; // default value
        return val ?? ''; // `${VAR:?err}` etc — no value, best-effort empty for detection
      });
    };

    // Build service → set of names this service is reachable as (compose service + explicit
    // container_name resolved + compose-default forms). Any of these matching a proxy_host's
    // forward_host means the service is targeted.
    const serviceAliases = new Map<string, Set<string>>();
    for (const svc of serviceNames) {
      const aliases = new Set<string>([svc]);
      const svcDef = rawServices[svc] as { container_name?: string } | null;
      if (svcDef?.container_name) {
        aliases.add(svcDef.container_name);
        aliases.add(resolveVars(svcDef.container_name));
      }
      aliases.add(`${projectName}-${svc}-1`);
      aliases.add(`${projectName}_${svc}_1`);
      serviceAliases.set(svc, aliases);
    }

    // Resolve which stacks (from the discovery `stacks` table) belong to THIS managed_stack.
    // Filter only proxy_hosts whose stack_id points here — or those without a stack (global).
    const localStacks = await db('stacks').where({ compose_project: projectName }).select('id');
    const localStackIds = new Set<number>(localStacks.map(s => s.id as number));

    const proxyHosts = await db('proxy_hosts').select('forward_host', 'enabled', 'stack_id', 'docker_network');
    const relevantHosts = proxyHosts
      .filter(h => h.enabled !== false)
      .filter(h => h.stack_id == null || localStackIds.has(h.stack_id as number))
      .filter(h => (h.forward_host as string));

    // Build service → set of network names to attach to. A single service can have multiple
    // proxy_hosts (e.g. one on Oblihub's own shared network, one on an external NPM). We union
    // the networks so the override wires them all up in a single deploy. Fallback for a
    // proxy_host without an explicit docker_network is the configured proxy network name (was
    // hardcoded to "proxy" — broke installs where the actual name is `oblihub_proxy` etc.).
    const servicesToNetworks = new Map<string, Set<string>>();
    for (const svc of serviceNames) {
      const aliases = serviceAliases.get(svc);
      if (!aliases) continue;
      for (const h of relevantHosts) {
        if (aliases.has(h.forward_host as string)) {
          const raw = ((h.docker_network as string) || '').trim();
          const net = raw.length > 0 ? raw : proxyNetworkName;
          if (!servicesToNetworks.has(svc)) servicesToNetworks.set(svc, new Set());
          servicesToNetworks.get(svc)!.add(net);
        }
      }
    }
    const targeted = [...servicesToNetworks.keys()];
    return { services: targeted, userOwnsProxyNetwork, servicesToNetworks };
  },

  /**
   * Attach + optionally detach `proxy` network membership for a stack.
   *
   * `allowDetach` gates the destructive path:
   *   - `deploy()` sets it TRUE — the stack was just brought up fresh, the compose+override on
   *     disk is the source of truth, and it's safe to remove containers from `proxy` that no
   *     longer belong there.
   *   - `refreshProxyNetworksForAllStacks()` (called after any proxy_host CRUD) sets it FALSE
   *     — attach-only. Detaching from a live stack every time an unrelated proxy_host is
   *     modified is destructive: a transient parse failure of the compose YAML or a temporarily
   *     empty forward_host would silently kick every proxy-attached container out. Real
   *     cleanup happens on the next actual redeploy.
   *
   * ALSO: refuse to detach if the compose parse yielded zero services — we can't distinguish
   * "operator meant to remove all proxy attachments" from "compose has a syntax error and we
   * blindly nuked the whole stack". Fail-closed.
   */
  async _reconcileProxyNetworkMembership(projectName: string, composeContent: string, engineId: number | null = null, opts: { allowDetach?: boolean } = {}): Promise<void> {
    const allowDetach = opts.allowDetach !== false; // default true for backward-compat with deploy()
    try {
      const docker = await dockerService.forEngine(engineId);
      const targets = await this._detectProxiedServices(projectName, composeContent);
      const svcToNets = targets.servicesToNetworks || new Map<string, Set<string>>();
      // Union of every network name mentioned by any proxy_host — used to know which networks
      // we're allowed to detach from. We NEVER touch networks that aren't referenced by any
      // proxy_host (i.e. the operator's own `frontend`/`backend` custom networks — untouchable).
      const managedNetworks = new Set<string>();
      for (const nets of svcToNets.values()) for (const n of nets) managedNetworks.add(n);
      // Safety net: if the compose parse returned no services, we have no ground truth to
      // decide who should be on any proxy network. Don't detach — mass-detach is way worse than
      // leaving a stale attach for one deploy cycle. Attach can still run.
      let composeYieldedServices = true;
      try {
        const parsed = yaml.load(composeContent) as { services?: Record<string, unknown> } | null;
        composeYieldedServices = !!(parsed?.services && Object.keys(parsed.services).length > 0);
      } catch { composeYieldedServices = false; }
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`com.docker.compose.project=${projectName}`] },
      });
      for (const c of containers) {
        const serviceName = c.Labels?.['com.docker.compose.service'];
        if (!serviceName) continue;
        const wantedNetworks = svcToNets.get(serviceName) || new Set<string>();
        const currentNetworks = new Set(Object.keys(c.NetworkSettings?.Networks || {}));
        // ATTACH: any wanted network the container isn't on yet.
        for (const net of wantedNetworks) {
          if (currentNetworks.has(net)) continue;
          try {
            await docker.getNetwork(net).connect({ Container: c.Id });
            logger.info({ container: c.Id, serviceName, net }, 'Attached container to reverse-proxy network');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/already (exists|connected)/i.test(msg)) {
              logger.warn({ container: c.Id, net, err: msg }, 'Failed to attach to reverse-proxy network');
            }
          }
        }
        // DETACH: any MANAGED network the container is on but not currently wanted. Only
        // touches networks we own (proxy-host-referenced) — never the operator's frontend/backend.
        if (allowDetach && composeYieldedServices) {
          for (const net of currentNetworks) {
            if (!managedNetworks.has(net)) continue; // not a network we manage
            if (wantedNetworks.has(net)) continue;    // still wanted
            try {
              await docker.getNetwork(net).disconnect({ Container: c.Id });
              logger.info({ container: c.Id, serviceName, net, project: projectName }, 'Detached non-proxied container from reverse-proxy network');
            } catch (err) {
              logger.warn({ container: c.Id, net, err: err instanceof Error ? err.message : String(err) }, 'Failed to detach from reverse-proxy network');
            }
          }
        }
      }
      if (!composeYieldedServices && !allowDetach) {
        // Only worth mentioning once per refresh — surfaces silent YAML issues to the operator.
        logger.warn({ projectName }, 'Skipped detach step — compose parse yielded 0 services (YAML error?)');
      }
    } catch (err) {
      logger.warn({ projectName, err: err instanceof Error ? err.message : String(err) }, 'Reconcile proxy network membership failed');
    }
  },

  /**
   * Re-write the override + re-reconcile network membership for every managed stack that has
   * at least one proxy_host targeting one of its services. Called from proxy.controller after a
   * proxy_host is created / updated / deleted so that adding a new forward_host attaches the
   * target container without requiring an explicit redeploy.
   */
  async refreshProxyNetworksForAllStacks(): Promise<void> {
    try {
      const { managedStackService } = await import('./managed-stack.service');
      const stacks = await managedStackService.getAll();
      for (const s of stacks) {
        if (s.status !== 'deployed') continue;
        try {
          await this._writeProxyOverride(s.composeProject, s.composeContent);
          // Attach-only: safe path for the "someone edited a proxy_host" trigger. Detach is
          // reserved for explicit redeploys where the compose+override is guaranteed fresh.
          await this._reconcileProxyNetworkMembership(s.composeProject, s.composeContent, s.engineId, { allowDetach: false });
        } catch (err) {
          logger.warn({ project: s.composeProject, err: err instanceof Error ? err.message : String(err) }, 'Proxy network refresh failed for stack');
        }
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Bulk proxy network refresh failed');
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

  /** Redeploy: pull + up. When build_enabled is set on the stack, adds `--build` and skips the
   *  pull step (build-from-source stacks have no registry to pull from for build-only services). */
  async redeploy(projectName: string, composeContent: string, envContent: string | null, engineId: number | null = null): Promise<ComposeResult> {
    await this.writeStackFiles(projectName, composeContent, envContent);
    const upArgs = await this._buildAwareUpArgs(projectName);
    // Skip pull for build-enabled stacks — pull would try to fetch build-only services from
    // the registry and fail. Pure-image stacks still get the pull → up cycle unchanged.
    if (!upArgs.includes('--build')) {
      const pullResult = await this.runCompose(projectName, ['pull'], 0, engineId);
      if (pullResult.exitCode !== 0) return pullResult;
    }
    return this.runCompose(projectName, upArgs, 0, engineId);
  },

  /**
   * Assemble the `up -d` argument list, tacking on `--build` when the managed_stack has
   * build_enabled=true (Git/ZIP source with Dockerfiles). Falls back to the legacy pull-only
   * arg list for pre-existing stacks that have no build_enabled column value.
   */
  async _buildAwareUpArgs(projectName: string): Promise<string[]> {
    const args = ['up', '-d', '--remove-orphans'];
    try {
      const row = await db('managed_stacks').where({ compose_project: projectName }).select('build_enabled').first();
      if (row?.build_enabled) args.push('--build');
    } catch { /* fall through to pull-only */ }
    return args;
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
    await this.writeStackFiles(projectName, composeContent, envContent);

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

  /**
   * Build a temp DOCKER_CONFIG directory containing this stack's registry credentials. Each
   * cred row is decrypted on demand and encoded as base64(`username:password`) under the
   * canonical `auths.<registry>.auth` key the docker CLI expects.
   *
   * Returns the dir path + a cleanup function; the path is null when the stack has no creds
   * (or the project name doesn't match any stack record — e.g. during preview/test runs) so
   * the caller can skip setting DOCKER_CONFIG entirely and let the CLI use its defaults.
   */
  async _resolveStackRegistryAuth(projectName: string): Promise<{ dockerConfigDir: string | null; cleanup: () => void }> {
    try {
      const row = await db('managed_stacks').where({ compose_project: projectName }).select('registry_credentials').first();
      const raw = row?.registry_credentials;
      let creds: Array<{ registry?: string; username?: string; password_enc?: string }> = [];
      if (Array.isArray(raw)) creds = raw as typeof creds;
      else if (typeof raw === 'string' && raw) { try { creds = JSON.parse(raw); } catch { creds = []; } }
      const usable = creds.filter(c => c.registry && c.username && c.password_enc);
      if (usable.length === 0) return { dockerConfigDir: null, cleanup: () => {} };

      const { decryptSecret } = await import('../utils/crypto');
      const os = await import('node:os');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `oblihub-dockercfg-${projectName}-`));
      const auths: Record<string, { auth: string }> = {};
      for (const c of usable) {
        try {
          const pw = decryptSecret(c.password_enc!);
          auths[c.registry!] = { auth: Buffer.from(`${c.username}:${pw}`).toString('base64') };
        } catch (err) {
          logger.warn({ projectName, registry: c.registry, err: err instanceof Error ? err.message : String(err) }, 'Skipping registry cred — decrypt failed');
        }
      }
      // Also fold in the global Docker Hub creds (env-based) so a stack with private + Docker Hub
      // images uses both transparently. The stack's per-registry entries take precedence on
      // conflict because they're set last.
      if (config.dockerHubUsername && config.dockerHubToken && !auths['https://index.docker.io/v1/']) {
        auths['https://index.docker.io/v1/'] = {
          auth: Buffer.from(`${config.dockerHubUsername}:${config.dockerHubToken}`).toString('base64'),
        };
      }
      fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ auths }, null, 2), { mode: 0o600 });
      return {
        dockerConfigDir: tmpDir,
        cleanup: () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } },
      };
    } catch (err) {
      logger.warn({ projectName, err: err instanceof Error ? err.message : String(err) }, 'Failed to build per-stack DOCKER_CONFIG');
      return { dockerConfigDir: null, cleanup: () => {} };
    }
  },
};
