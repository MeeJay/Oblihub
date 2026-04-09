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

  server.listen(config.port, () => {
    logger.info(`Oblihub server listening on port ${config.port}`);
    logger.info({ allowConsole: config.allowConsole, allowStack: config.allowStack, stacksDir: config.stacksDir }, 'Feature flags');
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    stopDiscoveryWorker();
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
