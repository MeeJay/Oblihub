import type { Request, Response, NextFunction } from 'express';
import { managedStackService } from '../services/managed-stack.service';
import { composeService } from '../services/compose.service';
import { dockerService } from '../services/docker.service';
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
  async list(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const stacks = await managedStackService.getAll();
      res.json({ success: true, data: stacks });
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
      const { name, composeContent, envContent, teamId } = req.body;
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

        const stack = await managedStackService.create({ name, composeContent, envContent });

        // Auto-assign the new stack to the team's resources
        await teamService.addResource(targetTeamId, 'stack', stack.id);
        // Also set stack.team_id for reference
        const { db } = await import('../db');
        await db('stacks').where({ compose_project: stack.composeProject }).update({ team_id: targetTeamId });

        res.json({ success: true, data: stack });
        return;
      }

      const stack = await managedStackService.create({ name, composeContent, envContent });
      res.json({ success: true, data: stack });
    } catch (err) { next(err); }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.allowStack) throw new AppError(403, 'Stack management is disabled');
      const id = parseInt(req.params.id, 10);
      const { name, composeContent, envContent } = req.body;
      const stack = await managedStackService.update(id, { name, composeContent, envContent });
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
        await composeService.down(stack.composeProject);
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
      res.json({ success: true, message: 'Deploy started' });

      // Run in background
      (async () => {
        try {
          const result = await composeService.deploy(stack.composeProject, stack.composeContent, stack.envContent);
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
          if (result.exitCode !== 0) {
            await managedStackService.setStatus(id, 'error', output || 'Deploy failed');
            logger.error({ projectName: stack.composeProject, stderr: result.stderr }, 'Compose deploy failed');
          } else {
            // Store output as success message (visible in UI)
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

      const result = await composeService.stop(stack.composeProject);
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
      const result = await composeService.down(stack.composeProject, removeVolumes);
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
      const result = await composeService.pull(stack.composeProject);
      res.json({ success: true, data: { exitCode: result.exitCode, output: result.stdout + result.stderr } });
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
      res.json({ success: true, message: 'Redeploy started' });

      (async () => {
        try {
          const result = await composeService.redeploy(stack.composeProject, stack.composeContent, stack.envContent);
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
};
