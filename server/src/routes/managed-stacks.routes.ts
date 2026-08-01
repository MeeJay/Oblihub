import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { managedStackController } from '../controllers/managed-stack.controller';
import { requireAuth } from '../middleware/auth';
import { config } from '../config';

const router = Router();

router.use(requireAuth);
router.use((_req: Request, res: Response, next: NextFunction) => {
  if (!config.allowStack) { res.status(403).json({ success: false, error: 'Stack management is disabled' }); return; }
  next();
});

// In-memory uploads capped at 100 MB. Source archives for build stacks are typically <10 MB;
// the cap protects against accidental dumps of node_modules / built artifacts. Bump if needed.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

router.get('/', managedStackController.list);
router.post('/', managedStackController.create);
router.post('/check-port-conflicts', managedStackController.checkPortConflicts);
router.get('/:id', managedStackController.getById);
router.put('/:id', managedStackController.update);
router.delete('/:id', managedStackController.delete);
router.post('/:id/deploy', managedStackController.deploy);
router.post('/:id/stop', managedStackController.stop);
router.post('/:id/down', managedStackController.down);
router.post('/:id/pull', managedStackController.pull);
router.post('/:id/redeploy', managedStackController.redeploy);
router.post('/:id/cancel', managedStackController.cancel);

// Build-pipeline source management
router.post('/:id/source/zip', upload.single('file'), managedStackController.uploadZip);
router.post('/:id/source/git', managedStackController.setGit);
router.post('/:id/source/git-pull', managedStackController.gitPull);
router.get('/:id/source/files', managedStackController.listSourceFiles);
router.get('/:id/source/generated', managedStackController.getGeneratedFiles);
router.get('/:id/effective-config', managedStackController.getEffectiveConfig);

// Engine migration
router.get('/:id/migration-preview', managedStackController.previewMigration);
router.post('/:id/migrate-engine', managedStackController.migrateEngine);

// Deploy history + rollback (Git-sourced stacks)
router.get('/:id/deploy-history', managedStackController.getDeployHistory);
router.post('/:id/rollback', managedStackController.rollback);

export default router;
