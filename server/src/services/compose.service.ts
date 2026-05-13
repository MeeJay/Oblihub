import { exec, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import Docker from 'dockerode';
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
      // Need the private key. Fetch decrypted version via engine.service (which does the AES decrypt).
      const { db } = await import('../db');
      const row = await db('docker_engines').where({ id: engineId }).first() as { ssh_private_key_enc: string | null } | undefined;
      if (!row?.ssh_private_key_enc) { cleanup(); throw new Error(`Engine ${engineId} (ssh) missing private key`); }
      const { decryptSecret } = await import('../utils/crypto');
      const privateKey = decryptSecret(row.ssh_private_key_enc);
      const keyFile = path.join(tmp, 'id_engine');
      fs2.writeFileSync(keyFile, privateKey, { mode: 0o600 });
      // We need IdentityFile + StrictHostKeyChecking off (could pin via known_hosts later)
      const sshArgs = `-i ${keyFile} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
      const dockerHost = `ssh://${engine.sshUser}@${engine.host}:${engine.port ?? 22}`;
      return {
        env: {
          DOCKER_HOST: dockerHost,
          // Forwarded to the docker CLI's ssh helper
          GIT_SSH_COMMAND: `ssh ${sshArgs}`,
          DOCKER_SSH_OPTS: sshArgs,
        },
        cleanup,
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

  /** Run a docker compose command — optionally targeting a remote engine. */
  async runCompose(projectName: string, args: string[], timeoutMs = 120000, engineId: number | null = null): Promise<ComposeResult> {
    const stackDir = getStackDir(projectName);
    const cmd = `docker compose -p "${projectName}" -f docker-compose.yml ${args.join(' ')}`;

    let envInjection: { env: Record<string, string>; cleanup: () => void };
    try {
      envInjection = await this._resolveEngineEnv(engineId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ projectName, engineId, err: message }, 'Compose engine env resolution failed');
      return { exitCode: 1, stdout: '', stderr: message };
    }

    logger.info({ projectName, engineId, cmd }, 'Running compose command');

    return new Promise((resolve) => {
      const child = exec(cmd, {
        cwd: stackDir,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...envInjection.env },
      }, (error, stdout, stderr) => {
        activeProcesses.delete(projectName);
        envInjection.cleanup();
        const killedByCancel = (child as ChildProcess & { _cancelled?: boolean })._cancelled === true;
        const result = {
          exitCode: killedByCancel ? 130 : error ? (error as NodeJS.ErrnoException).code ? 1 : (error as { code?: number }).code ?? 1 : 0,
          stdout: stdout?.toString() || '',
          stderr: killedByCancel ? 'Cancelled by user' : (stderr?.toString() || ''),
        };
        logger.info({ projectName, exitCode: result.exitCode, cancelled: killedByCancel, stderr: result.stderr.slice(0, 500) }, 'Compose command finished');
        resolve(result);
      });
      activeProcesses.set(projectName, child);
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

  /** Deploy a stack (up -d) */
  async deploy(projectName: string, composeContent: string, envContent: string | null, engineId: number | null = null): Promise<ComposeResult> {
    this.writeStackFiles(projectName, composeContent, envContent);
    return this.runCompose(projectName, ['up', '-d', '--remove-orphans'], 120000, engineId);
  },

  /** Stop a stack */
  async stop(projectName: string, engineId: number | null = null): Promise<ComposeResult> {
    return this.runCompose(projectName, ['stop'], 120000, engineId);
  },

  /** Down a stack (stop + remove containers + networks) */
  async down(projectName: string, removeVolumes = false, engineId: number | null = null): Promise<ComposeResult> {
    const args = ['down', '--remove-orphans'];
    if (removeVolumes) args.push('-v');
    return this.runCompose(projectName, args, 120000, engineId);
  },

  /** Pull images for a stack */
  async pull(projectName: string, engineId: number | null = null): Promise<ComposeResult> {
    return this.runCompose(projectName, ['pull'], 120000, engineId);
  },

  /** Get compose ps */
  async ps(projectName: string, engineId: number | null = null): Promise<ComposeResult> {
    return this.runCompose(projectName, ['ps', '--format', 'json'], 120000, engineId);
  },

  /** Redeploy: pull + up */
  async redeploy(projectName: string, composeContent: string, envContent: string | null, engineId: number | null = null): Promise<ComposeResult> {
    this.writeStackFiles(projectName, composeContent, envContent);
    const pullResult = await this.runCompose(projectName, ['pull'], 120000, engineId);
    if (pullResult.exitCode !== 0) return pullResult;
    return this.runCompose(projectName, ['up', '-d', '--remove-orphans'], 120000, engineId);
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
