import type { Request, Response, NextFunction } from 'express';
import { managedStackService } from '../services/managed-stack.service';
import { composeService } from '../services/compose.service';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

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
      const { name, composeContent, envContent } = req.body;
      if (!name || !composeContent) throw new AppError(400, 'Name and compose content are required');
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
