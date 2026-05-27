import type { Request, Response, NextFunction } from 'express';
import { managedStackService } from '../services/managed-stack.service';
import { composeService } from '../services/compose.service';
import { dockerService } from '../services/docker.service';
import { sourceManagerService } from '../services/sourceManager.service';
import { volumeMigrationService } from '../services/volumeMigration.service';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

async function isSelfStack(composeProject: string): Promise<boolean> {
  try {
    const selfId = dockerService.getSelfContainerId();
    if (!selfId) return false;
    const info = await dockerService.inspectContainer(selfId);
    return (info.Config?.Labels?.['com.docker.compose.project'] || null) === composeProject;
  } catch { return false; }
}

export const managedStackController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const session = req.session as { userId?: number; role?: string };
      const allStacks = await managedStackService.getAll();
      if (session.role === 'admin') {
        res.json({ success: true, data: allStacks });
        return;
      }
      // Filter by team access
      const { teamService } = await import('../services/team.service');
      const teams = await teamService.getTeamsForUser(session.userId!);
      if (teams.length === 0) { res.json({ success: true, data: [] }); return; }
      if (teams.some(t => t.allResources)) { res.json({ success: true, data: allStacks }); return; }
      const accessibleProjects = new Set<string>();
      for (const team of teams) {
        for (const r of team.resources) {
          if (r.resourceType === 'stack' && !r.excluded) {
            // Get the stack's compose_project to match with managed stacks
            const { db } = await import('../db');
            const stack = await db('stacks').where({ id: r.resourceId }).first();
            if (stack?.compose_project) accessibleProjects.add(stack.compose_project);
          }
        }
      }
      const filtered = allStacks.filter(s => accessibleProjects.has(s.composeProject));
      res.json({ success: true, data: filtered });
    } catch (err) { next(err); }
  },

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Managed stack not found');
      res.json({ success: true, data: stack });
    } catch (err) { next(err); }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled. Set ALLOW_STACK=true to enable.');
      const session = req.session as { userId?: number; role?: string };
      const { name, composeContent, envContent, teamId, engineId } = req.body;
      if (!name || !composeContent) throw new AppError(400, 'Name and compose content are required');

      // Non-admin must have a team to create a stack
      if (session.role !== 'admin') {
        const { teamService } = await import('../services/team.service');
        const userTeams = await teamService.getTeamsForUser(session.userId!);
        if (userTeams.length === 0) throw new AppError(403, 'You must be in a team to create stacks');

        // Auto-assign to first team if no teamId specified, or validate the teamId
        const targetTeamId = teamId || userTeams[0].id;
        const isInTeam = userTeams.some(t => t.id === targetTeamId);
        if (!isInTeam) throw new AppError(403, 'You are not a member of this team');

        const stack = await managedStackService.create({ name, composeContent, envContent, engineId });

        // Ensure the stack exists in the stacks table and assign to team
        const { db } = await import('../db');
        let discoveredStack = await db('stacks').where({ compose_project: stack.composeProject }).first();
        if (!discoveredStack) {
          // Pre-create the stack entry so team assignment works immediately
          const [newStack] = await db('stacks').insert({ name: stack.name, compose_project: stack.composeProject, team_id: targetTeamId }).returning('*');
          discoveredStack = newStack;
        } else {
          await db('stacks').where({ id: discoveredStack.id }).update({ team_id: targetTeamId });
        }
        // Assign stack to team resources using the stacks table ID
        await teamService.addResource(targetTeamId, 'stack', discoveredStack.id);

        res.json({ success: true, data: stack });
        return;
      }

      const stack = await managedStackService.create({ name, composeContent, envContent, engineId });
      res.json({ success: true, data: stack });
    } catch (err) { next(err); }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const { name, composeContent, envContent, engineId } = req.body;
      const stack = await managedStackService.update(id, { name, composeContent, envContent, engineId });
      if (!stack) throw new AppError(404, 'Managed stack not found');
      res.json({ success: true, data: stack });
    } catch (err) { next(err); }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Managed stack not found');
      if (await isSelfStack(stack.composeProject)) throw new AppError(403, 'Cannot delete Oblihub\'s own stack');
      // Down the stack if deployed
      if (stack.status === 'deployed') {
        await composeService.down(stack.composeProject, false, stack.engineId);
      }
      composeService.removeStackFiles(stack.composeProject);
      await managedStackService.delete(id);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async deploy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Managed stack not found');

      // Safety: refuse to deploy empty/placeholder compose
      const content = stack.composeContent.trim();
      if (!content || !content.includes('image:') && !content.includes('build:')) {
        throw new AppError(400, 'Cannot deploy: compose file has no services with an image or build directive. Please define at least one valid service.');
      }

      await managedStackService.setStatus(id, 'deploying');

      const selfStack = await isSelfStack(stack.composeProject);
      if (selfStack) {
        // Self-deploy: hand off to helper container, return immediately — we're about to be recreated.
        res.json({ success: true, message: 'Self-stack deploy handed off to helper' });
        try {
          await composeService.deployViaHelper(stack.composeProject, stack.composeContent, stack.envContent, false);
          logger.info({ projectName: stack.composeProject }, 'Self-stack deploy helper launched');
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          await managedStackService.setStatus(id, 'error', `Self-deploy helper failed: ${msg}`);
          logger.error({ projectName: stack.composeProject, err }, 'Self-stack deploy helper error');
        }
        return;
      }

      res.json({ success: true, message: 'Deploy started' });

      // Run in background
      (async () => {
        try {
          const result = await composeService.deploy(stack.composeProject, stack.composeContent, stack.envContent, stack.engineId);
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
          if (result.exitCode !== 0) {
            await managedStackService.setStatus(id, 'error', output || 'Deploy failed');
            logger.error({ projectName: stack.composeProject, stderr: result.stderr }, 'Compose deploy failed');
          } else {
            await managedStackService.setStatus(id, 'deployed', output || null);
            logger.info({ projectName: stack.composeProject }, 'Stack deployed');
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          await managedStackService.setStatus(id, 'error', msg);
          logger.error({ projectName: stack.composeProject, err }, 'Compose deploy error');
        }
      })();
    } catch (err) { next(err); }
  },

  async stop(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Managed stack not found');
      if (await isSelfStack(stack.composeProject)) throw new AppError(403, 'Cannot stop Oblihub\'s own stack');

      const result = await composeService.stop(stack.composeProject, stack.engineId);
      if (result.exitCode !== 0) {
        await managedStackService.setStatus(id, 'error', result.stderr);
        throw new AppError(500, result.stderr || 'Stop failed');
      }
      await managedStackService.setStatus(id, 'stopped');
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async down(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Managed stack not found');
      if (await isSelfStack(stack.composeProject)) throw new AppError(403, 'Cannot down Oblihub\'s own stack');

      const removeVolumes = req.query.volumes === 'true';
      const result = await composeService.down(stack.composeProject, removeVolumes, stack.engineId);
      if (result.exitCode !== 0) {
        await managedStackService.setStatus(id, 'error', result.stderr);
        throw new AppError(500, result.stderr || 'Down failed');
      }
      await managedStackService.setStatus(id, 'stopped');
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async pull(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Managed stack not found');

      // Ensure files exist on disk
      composeService.writeStackFiles(stack.composeProject, stack.composeContent, stack.envContent);
      const result = await composeService.pull(stack.composeProject, stack.engineId);
      res.json({ success: true, data: { exitCode: result.exitCode, output: result.stdout + result.stderr } });
    } catch (err) { next(err); }
  },

  async cancel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Managed stack not found');

      const wasRunning = composeService.cancel(stack.composeProject);
      // Always reset status — also unblocks stacks stuck in 'deploying' after a server restart mid-deploy.
      await managedStackService.setStatus(
        id,
        'error',
        wasRunning ? 'Cancelled by user' : 'Deploy status reset (no active process)',
      );

      logger.warn({ projectName: stack.composeProject, wasRunning }, 'Deploy cancelled');
      res.json({ success: true, data: { killed: wasRunning } });
    } catch (err) { next(err); }
  },

  async redeploy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Managed stack not found');

      const content = stack.composeContent.trim();
      if (!content || !content.includes('image:') && !content.includes('build:')) {
        throw new AppError(400, 'Cannot deploy: compose file has no valid services.');
      }

      await managedStackService.setStatus(id, 'deploying');

      const selfStack = await isSelfStack(stack.composeProject);
      if (selfStack) {
        res.json({ success: true, message: 'Self-stack redeploy handed off to helper' });
        try {
          await composeService.deployViaHelper(stack.composeProject, stack.composeContent, stack.envContent, true);
          logger.info({ projectName: stack.composeProject }, 'Self-stack redeploy helper launched');
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          await managedStackService.setStatus(id, 'error', `Self-redeploy helper failed: ${msg}`);
          logger.error({ projectName: stack.composeProject, err }, 'Self-stack redeploy helper error');
        }
        return;
      }

      res.json({ success: true, message: 'Redeploy started' });

      (async () => {
        try {
          const result = await composeService.redeploy(stack.composeProject, stack.composeContent, stack.envContent, stack.engineId);
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
          if (result.exitCode !== 0) {
            await managedStackService.setStatus(id, 'error', output || 'Redeploy failed');
          } else {
            await managedStackService.setStatus(id, 'deployed', output || null);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          await managedStackService.setStatus(id, 'error', msg);
        }
      })();
    } catch (err) { next(err); }
  },

  /**
   * Given a list of host ports the user wants to claim on a specific Docker engine, return
   * which ones are already in use by other containers on that engine — along with which
   * stack/container is holding each one. The client uses this for pre-deploy validation in
   * the stack editor so port conflicts surface before `docker compose up` fails.
   *
   * Body: { engineId: number | null, ports: number[], excludeComposeProject?: string }
   *  - engineId: which engine to check against (null = local/default)
   *  - ports: host ports the user is about to claim
   *  - excludeComposeProject: optional compose_project name to skip — the stack being edited
   *                           must not count as conflicting with itself. We match by compose
   *                           project name because that's the natural link between the
   *                           `managed_stacks` table (the user's definition) and the `stacks`
   *                           table (what DiscoveryWorker actually sees running on Docker) —
   *                           those two tables have unrelated IDs.
   */
  async checkPortConflicts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as { engineId?: number | null; ports?: number[]; excludeComposeProject?: string };
      const ports = Array.isArray(body.ports) ? body.ports.filter(p => Number.isInteger(p) && p > 0 && p < 65536) : [];
      if (ports.length === 0) { res.json({ success: true, data: { conflicts: [] } }); return; }
      const engineId = body.engineId ?? null;

      // Resolve the default engine id when engineId is null — discovery stamps each container
      // row with engine_id, so we need to know which one to filter on.
      let effectiveEngineId: number | null = engineId;
      if (effectiveEngineId == null) {
        const { engineService } = await import('../services/engine.service');
        const def = await engineService.getDefault();
        effectiveEngineId = def?.id ?? null;
      }

      const { db } = await import('../db');
      let q = db('containers')
        .leftJoin('stacks', 'containers.stack_id', 'stacks.id')
        .select('containers.id as containerId',
                'containers.container_name as containerName',
                'containers.ports as ports',
                'stacks.id as stackId',
                'stacks.name as stackName',
                'stacks.compose_project as composeProject');
      if (effectiveEngineId != null) q = q.where('containers.engine_id', effectiveEngineId);

      const rows = await q;
      const conflicts: { port: number; stackName: string | null; containerName: string; containerId: number }[] = [];
      const requested = new Set(ports);
      const excludeProject = body.excludeComposeProject || null;
      for (const row of rows) {
        // Skip rows belonging to the same compose project as the stack being edited — its own
        // containers' ports don't conflict with itself, even if those containers will be
        // recreated as part of the redeploy.
        if (excludeProject && row.composeProject === excludeProject) continue;
        let portsArr: { hostPort?: number | null }[] = [];
        try {
          const raw = row.ports;
          portsArr = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
        } catch { /* skip malformed rows */ }
        for (const p of portsArr) {
          if (p?.hostPort && requested.has(p.hostPort)) {
            conflicts.push({
              port: p.hostPort,
              stackName: row.stackName ?? null,
              containerName: row.containerName,
              containerId: row.containerId,
            });
          }
        }
      }
      res.json({ success: true, data: { conflicts } });
    } catch (err) { next(err); }
  },

  /**
   * Receive a multipart/form-data zip upload and replace the stack's source files with it.
   * Re-uploads are clean: the project dir is wiped (except .env, docker-compose.yml at root,
   * and .oblihub state) before extraction.
   */
  async uploadZip(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) throw new AppError(400, 'No file uploaded (expected field "file")');
      await sourceManagerService.receiveZip(id, file.buffer);
      const stack = await managedStackService.getById(id);
      res.json({ success: true, data: stack });
    } catch (err) { next(err); }
  },

  /** Configure / replace the git source for this stack. */
  async setGit(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const { gitUrl, gitBranch } = req.body as { gitUrl?: string; gitBranch?: string };
      if (!gitUrl) throw new AppError(400, 'gitUrl required');
      await sourceManagerService.setGitSource(id, gitUrl, gitBranch || 'main');
      const stack = await managedStackService.getById(id);
      res.json({ success: true, data: stack });
    } catch (err) { next(err); }
  },

  /** Pull latest commits on the configured branch. */
  async gitPull(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await sourceManagerService.gitPull(id);
      const stack = await managedStackService.getById(id);
      res.json({ success: true, data: stack });
    } catch (err) { next(err); }
  },

  /** List the files currently present in the stack's source dir (excluding .git/.oblihub). */
  async listSourceFiles(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const files = await sourceManagerService.listFiles(id);
      res.json({ success: true, data: files });
    } catch (err) { next(err); }
  },

  /**
   * Preview what volumes / bind mounts the stack uses on its current engine. Called by the
   * client BEFORE showing the engine-migration modal so the user sees what they're about to
   * move (or skip, in the case of bind mounts).
   */
  async previewMigration(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Stack not found');
      const vols = await volumeMigrationService.discoverVolumes(stack.composeProject, stack.engineId);
      res.json({ success: true, data: vols });
    } catch (err) { next(err); }
  },

  /**
   * Re-target a deployed stack to a different engine.
   *
   *   strategy = 'just-save'        — flip engine_id in DB only. Orphans the old containers.
   *                                    Use when the operator will clean up the old engine
   *                                    by hand or just doesn't care.
   *   strategy = 'stop-and-deploy'  — `docker compose down` on old, flip DB, `up -d` on new.
   *                                    Data is NOT migrated — new volumes will be empty.
   *   strategy = 'migrate-data'     — `down` on old → tar-stream every named volume from old
   *                                    to new → flip DB → `up -d` on new. Bind mounts are
   *                                    surfaced as skipped. The longest path; live progress
   *                                    streams via compose:log.
   *
   * Runs synchronously so the HTTP response only returns when the migration is fully done.
   * For long transfers (multi-GB DB volumes) the client gets progress via the socket and can
   * cancel via /cancel-update on the stack.
   */
  async migrateEngine(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const body = req.body as { targetEngineId: number | null; strategy: 'just-save' | 'stop-and-deploy' | 'migrate-data' };
      if (!('targetEngineId' in body)) throw new AppError(400, 'targetEngineId required');
      if (!['just-save', 'stop-and-deploy', 'migrate-data'].includes(body.strategy)) {
        throw new AppError(400, 'Invalid strategy');
      }
      const stack = await managedStackService.getById(id);
      if (!stack) throw new AppError(404, 'Stack not found');
      const sourceEngineId = stack.engineId;
      const targetEngineId = body.targetEngineId;
      if (sourceEngineId === targetEngineId) {
        res.json({ success: true, data: { changed: false, message: 'Already on this engine' } });
        return;
      }

      const { db } = await import('../db');
      const { setComposeServiceIO } = await import('../services/compose.service');
      void setComposeServiceIO;

      // ── Strategy: just-save ──
      if (body.strategy === 'just-save') {
        await db('managed_stacks').where({ id }).update({ engine_id: targetEngineId, updated_at: new Date() });
        const updated = await managedStackService.getById(id);
        res.json({ success: true, data: { stack: updated, migrated: [], skippedBinds: [] } });
        return;
      }

      // ── Strategy: stop-and-deploy + migrate-data both start with `down` on the old engine ──
      await managedStackService.setStatus(id, 'deploying', null);
      try {
        const downResult = await composeService.down(stack.composeProject, false, sourceEngineId);
        if (downResult.exitCode !== 0) {
          throw new AppError(500, `Failed to stop on source engine: ${downResult.stderr.slice(0, 500)}`);
        }

        let migration: Awaited<ReturnType<typeof volumeMigrationService.migrateAll>> = { migrated: [], skippedBinds: [] };
        if (body.strategy === 'migrate-data') {
          migration = await volumeMigrationService.migrateAll(stack.composeProject, sourceEngineId, targetEngineId);
        }

        await db('managed_stacks').where({ id }).update({ engine_id: targetEngineId, updated_at: new Date() });
        const stackForDeploy = await managedStackService.getById(id);
        if (!stackForDeploy) throw new AppError(500, 'Stack disappeared mid-migration');

        const upResult = await composeService.deploy(
          stackForDeploy.composeProject,
          stackForDeploy.composeContent,
          stackForDeploy.envContent,
          targetEngineId,
        );
        if (upResult.exitCode !== 0) {
          await managedStackService.setStatus(id, 'error', `Deploy on new engine failed: ${upResult.stderr.slice(0, 500)}`);
          throw new AppError(500, `Deploy on target engine failed: ${upResult.stderr.slice(0, 500)}`);
        }
        await managedStackService.setStatus(id, 'deployed', null);
        const updated = await managedStackService.getById(id);
        res.json({ success: true, data: { stack: updated, ...migration } });
      } catch (err) {
        await managedStackService.setStatus(id, 'error', err instanceof Error ? err.message : String(err));
        throw err;
      }
    } catch (err) { next(err); }
  },
};
