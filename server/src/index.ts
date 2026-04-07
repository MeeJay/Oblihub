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

async function main() {
  logger.info('Running database migrations...');
  await db.migrate.latest();
  logger.info('Migrations complete');

  await authService.ensureDefaultAdmin(config.defaultAdminUsername, config.defaultAdminPassword);

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
