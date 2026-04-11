import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { teamService } from '../services/team.service';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

const router = Router();
router.use(requireAuth);

function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if ((req.session as { role?: string }).role !== 'admin') return next(new AppError(403, 'Admin access required'));
  next();
}

// List all teams (any user can see their teams)
router.get('/', async (req, res, next) => {
  try {
    const role = (req.session as { role?: string }).role;
    if (role === 'admin') {
      res.json({ success: true, data: await teamService.getAll() });
    } else {
      const userId = (req.session as { userId?: number }).userId!;
      res.json({ success: true, data: await teamService.getTeamsForUser(userId) });
    }
  } catch (err) { next(err); }
});

// Get my accessible resources
router.get('/my-resources', async (req, res, next) => {
  try {
    const userId = (req.session as { userId?: number }).userId!;
    const role = (req.session as { role?: string }).role;
    if (role === 'admin') {
      res.json({ success: true, data: { all: true, stackIds: [], containerIds: [] } });
      return;
    }
    const teams = await teamService.getTeamsForUser(userId);
    const hasAll = teams.some(t => t.allResources);
    const stackIds = new Set<number>();
    const containerIds = new Set<number>();
    const excludedContainerIds = new Set<number>();
    for (const team of teams) {
      for (const r of team.resources) {
        if (r.excluded) {
          if (r.resourceType === 'container') excludedContainerIds.add(r.resourceId);
        } else {
          if (r.resourceType === 'stack') stackIds.add(r.resourceId);
          else containerIds.add(r.resourceId);
        }
      }
    }
    res.json({ success: true, data: { all: hasAll, stackIds: [...stackIds], containerIds: [...containerIds], excludedContainerIds: [...excludedContainerIds] } });
  } catch (err) { next(err); }
});

// Get team names for each stack (for dashboard labels)
router.get('/by-stacks', async (_req, res, next) => {
  try {
    const allTeams = await teamService.getAll();
    const stackTeams: Record<number, string[]> = {};
    for (const team of allTeams) {
      if (team.allResources) {
        // This team has access to all stacks - handled in frontend
        continue;
      }
      for (const r of team.resources) {
        if (r.resourceType === 'stack' && !r.excluded) {
          if (!stackTeams[r.resourceId]) stackTeams[r.resourceId] = [];
          stackTeams[r.resourceId].push(team.name);
        }
      }
    }
    const globalTeams = allTeams.filter(t => t.allResources).map(t => t.name);
    res.json({ success: true, data: { stackTeams, globalTeams } });
  } catch (err) { next(err); }
});

// Admin-only: CRUD
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { name, description, allResources } = req.body;
    if (!name) throw new AppError(400, 'Name required');
    const team = await teamService.create({ name, description, allResources });
    res.json({ success: true, data: team });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const team = await teamService.getById(parseInt(req.params.id, 10));
    if (!team) throw new AppError(404, 'Team not found');
    res.json({ success: true, data: team });
  } catch (err) { next(err); }
});

router.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const team = await teamService.update(parseInt(req.params.id, 10), req.body);
    if (!team) throw new AppError(404, 'Team not found');
    res.json({ success: true, data: team });
  } catch (err) { next(err); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await teamService.delete(parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Members
router.post('/:id/members', requireAdmin, async (req, res, next) => {
  try {
    await teamService.addMember(parseInt(req.params.id, 10), req.body.userId);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete('/:id/members/:userId', requireAdmin, async (req, res, next) => {
  try {
    await teamService.removeMember(parseInt(req.params.id, 10), parseInt(req.params.userId, 10));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Resources (bulk set)
router.put('/:id/resources', requireAdmin, async (req, res, next) => {
  try {
    const { resources } = req.body as { resources: { type: 'stack' | 'container'; id: number; excluded?: boolean }[] };
    await teamService.setResources(parseInt(req.params.id, 10), resources || []);
    const team = await teamService.getById(parseInt(req.params.id, 10));
    res.json({ success: true, data: team });
  } catch (err) { next(err); }
});

export default router;
