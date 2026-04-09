import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

interface ComposeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

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
      // Remove .env if it existed before
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
      exec(cmd, { cwd: stackDir, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        const result = {
          exitCode: error ? (error as NodeJS.ErrnoException).code ? 1 : (error as { code?: number }).code ?? 1 : 0,
          stdout: stdout?.toString() || '',
          stderr: stderr?.toString() || '',
        };
        logger.info({ projectName, exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) }, 'Compose command finished');
        resolve(result);
      });
    });
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
};
