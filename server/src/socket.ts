import type { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { logger } from './utils/logger';

export function createSocketServer(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173', credentials: true },
  });

  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, 'Socket connected');
    socket.on('disconnect', () => {
      logger.info({ socketId: socket.id }, 'Socket disconnected');
    });
  });

  return io;
}
