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
import proxyRoutes from './proxy.routes';
import usersRoutes from './users.routes';
import permissionsRoutes from './permissions.routes';
import statsRoutes from './stats.routes';
import uptimeRoutes from './uptime.routes';
import templatesRoutes from './templates.routes';

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
router.use('/proxy', proxyRoutes);
router.use('/users', usersRoutes);
router.use('/', permissionsRoutes);
router.use('/stats', statsRoutes);
router.use('/uptime', uptimeRoutes);
router.use('/templates', templatesRoutes);

export { router as routes };
