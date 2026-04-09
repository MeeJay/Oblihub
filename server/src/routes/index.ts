import { Router } from 'express';
import authRoutes from './auth.routes';
import stackRoutes from './stacks.routes';
import containerRoutes from './containers.routes';
import systemRoutes from './system.routes';
import notificationRoutes from './notifications.routes';
import settingsRoutes from './settings.routes';
import profileRoutes from './profile.routes';
import dockerRoutes from './docker.routes';
import managedStackRoutes from './managed-stacks.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/stacks', stackRoutes);
router.use('/containers', containerRoutes);
router.use('/system', systemRoutes);
router.use('/notifications', notificationRoutes);
router.use('/settings', settingsRoutes);
router.use('/profile', profileRoutes);
router.use('/docker', dockerRoutes);
router.use('/managed-stacks', managedStackRoutes);

export { router as routes };
