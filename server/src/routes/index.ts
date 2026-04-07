import { Router } from 'express';
import authRoutes from './auth.routes';
import stackRoutes from './stacks.routes';
import containerRoutes from './containers.routes';
import systemRoutes from './system.routes';
import notificationRoutes from './notifications.routes';
import settingsRoutes from './settings.routes';
import profileRoutes from './profile.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/stacks', stackRoutes);
router.use('/containers', containerRoutes);
router.use('/system', systemRoutes);
router.use('/notifications', notificationRoutes);
router.use('/settings', settingsRoutes);
router.use('/profile', profileRoutes);

export { router as routes };
