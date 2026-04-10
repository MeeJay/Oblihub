import './env';
import http from 'http';
import { createApp } from './app';
import { createSocketServer } from './socket';
import { db } from './db';
import { config } from './config';
import { logger } from './utils/logger';
import { authService } from './services/auth.service';
import { setUpdateServiceIO } from './services/update.service';
import { startDiscoveryWorker, stopDiscoveryWorker } from './workers/DiscoveryWorker';
import { startStatsWorker, stopStatsWorker, cleanupOldStats } from './workers/StatsWorker';
import { startUptimeWorker, stopUptimeWorker } from './workers/UptimeWorker';
import { schedulerService } from './services/scheduler.service';
import { dockerService } from './services/docker.service';

async function waitForDatabase(maxRetries = 30, delayMs = 2000): Promise<void> {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      await db.raw('SELECT 1');
      logger.info(`Database connected (attempt ${i})`);
      return;
    } catch {
      logger.warn(`Database not ready (attempt ${i}/${maxRetries}), retrying in ${delayMs / 1000}s...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Database unreachable after ${maxRetries} attempts`);
}

async function main() {
  // Wait for PostgreSQL to be ready (up to 60s)
  await waitForDatabase();

  logger.info('Running database migrations...');
  await db.migrate.latest();
  logger.info('Migrations complete');

  await authService.ensureDefaultAdmin(config.defaultAdminUsername, config.defaultAdminPassword);

  // Clean up old containers left from self-updates
  await dockerService.cleanupOldSelfContainers();

  const app = createApp();
  const server = http.createServer(app);
  const io = createSocketServer(server);
  app.set('io', io);

  // Provide io to update service for real-time progress events
  setUpdateServiceIO(io);

  // Start Docker discovery worker
  startDiscoveryWorker(io);

  // Start per-stack check scheduler
  await schedulerService.startAll();

  // Start container stats worker
  startStatsWorker(io);
  // Cleanup old stats every hour
  setInterval(() => cleanupOldStats(), 60 * 60 * 1000);

  // Start uptime monitoring worker
  await startUptimeWorker();

  // Nginx proxy: regenerate configs on startup + auto-renewal
  if (config.allowNginx) {
    const { nginxService } = await import('./services/nginx.service');
    const { letsEncryptService } = await import('./services/certificate.service');
    nginxService.regenerateAndReload().then(() => {
      logger.info('Nginx proxy configs regenerated on startup');
    }).catch(err => {
      logger.warn({ err }, 'Nginx proxy config regeneration failed on startup (proxy may not be running yet)');
    });
    setInterval(() => letsEncryptService.checkRenewals(), 12 * 60 * 60 * 1000);
    logger.info('Certificate auto-renewal scheduler started (12h interval)');
  }

  server.listen(config.port, () => {
    logger.info(`Oblihub server listening on port ${config.port}`);
    logger.info({ allowConsole: config.allowConsole, allowStack: config.allowStack, allowNginx: config.allowNginx, stacksDir: config.stacksDir }, 'Feature flags');
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    stopDiscoveryWorker();
    stopStatsWorker();
    stopUptimeWorker();
    schedulerService.stopAll();
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error(err, 'Failed to start server');
  process.exit(1);
});
