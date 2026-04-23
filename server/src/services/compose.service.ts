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

  /** Run a docker compose command */
  async runCompose(projectName: string, args: string[], timeoutMs = 120000): Promise<ComposeResult> {
    const stackDir = getStackDir(projectName);
    const cmd = `docker compose -p "${projectName}" -f docker-compose.yml ${args.join(' ')}`;

    logger.info({ projectName, cmd }, 'Running compose command');

    return new Promise((resolve) => {
      const child = exec(cmd, { cwd: stackDir, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        activeProcesses.delete(projectName);
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
  async deploy(projectName: string, composeContent: string, envContent: string | null): Promise<ComposeResult> {
    this.writeStackFiles(projectName, composeContent, envContent);
    return this.runCompose(projectName, ['up', '-d', '--remove-orphans']);
  },

  /** Stop a stack */
  async stop(projectName: string): Promise<ComposeResult> {
    return this.runCompose(projectName, ['stop']);
  },

  /** Down a stack (stop + remove containers + networks) */
  async down(projectName: string, removeVolumes = false): Promise<ComposeResult> {
    const args = ['down', '--remove-orphans'];
    if (removeVolumes) args.push('-v');
    return this.runCompose(projectName, args);
  },

  /** Pull images for a stack */
  async pull(projectName: string): Promise<ComposeResult> {
    return this.runCompose(projectName, ['pull']);
  },

  /** Get compose ps */
  async ps(projectName: string): Promise<ComposeResult> {
    return this.runCompose(projectName, ['ps', '--format', 'json']);
  },

  /** Redeploy: pull + up */
  async redeploy(projectName: string, composeContent: string, envContent: string | null): Promise<ComposeResult> {
    this.writeStackFiles(projectName, composeContent, envContent);
    const pullResult = await this.runCompose(projectName, ['pull']);
    if (pullResult.exitCode !== 0) return pullResult;
    return this.runCompose(projectName, ['up', '-d', '--remove-orphans']);
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
