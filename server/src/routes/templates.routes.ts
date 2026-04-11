import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { requireAuth } from '../middleware/auth';
import { managedStackService } from '../services/managed-stack.service';
import { composeService } from '../services/compose.service';
import { config } from '../config';
import { requirePermission } from '../middleware/permissions';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

const router = Router();
router.use(requireAuth);
router.use((_req: Request, res: Response, next: NextFunction) => {
  if (!config.allowStack) { res.status(403).json({ success: false, error: 'Stack management is disabled' }); return; }
  next();
});

// List all templates
router.get('/', requirePermission('templates.view'), async (_req, res, next) => {
  try {
    const rows = await db('app_templates').orderBy('category').orderBy('name');
    res.json({ success: true, data: rows.map(r => ({
      id: r.id, name: r.name, slug: r.slug, description: r.description, icon: r.icon,
      category: r.category, composeTemplate: r.compose_template,
      envSchema: r.env_schema, defaultProxyPort: r.default_proxy_port,
      documentationUrl: r.documentation_url, isBuiltin: r.is_builtin,
      createdAt: r.created_at, updatedAt: r.updated_at,
    })) });
  } catch (err) { next(err); }
});

// Deploy a template
router.post('/:id/deploy', requirePermission('templates.deploy'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const templateId = parseInt(req.params.id, 10);
    const template = await db('app_templates').where({ id: templateId }).first();
    if (!template) throw new AppError(404, 'Template not found');

    const { stackName, envValues } = req.body as { stackName: string; envValues: Record<string, string> };
    if (!stackName) throw new AppError(400, 'Stack name required');

    // Interpolate env values into compose template
    let composeContent = template.compose_template as string;
    const envLines: string[] = [];
    for (const [key, value] of Object.entries(envValues || {})) {
      envLines.push(`${key}=${value}`);
    }
    const envContent = envLines.length > 0 ? envLines.join('\n') : null;

    // Create managed stack
    const stack = await managedStackService.create({ name: stackName, composeContent, envContent });

    // Deploy in background
    (async () => {
      try {
        await managedStackService.setStatus(stack.id, 'deploying');
        const result = await composeService.deploy(stack.composeProject, composeContent, envContent);
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
        if (result.exitCode !== 0) {
          await managedStackService.setStatus(stack.id, 'error', output);
        } else {
          await managedStackService.setStatus(stack.id, 'deployed', output || null);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        await managedStackService.setStatus(stack.id, 'error', msg);
      }
    })();

    res.json({ success: true, data: { stackId: stack.id, stackName: stack.name } });
  } catch (err) { next(err); }
});

export default router;
