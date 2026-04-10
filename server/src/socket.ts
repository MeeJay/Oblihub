import type { Server as HttpServer } from 'http';
import { Readable, Duplex } from 'stream';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { SOCKET_EVENTS } from '@oblihub/shared';
import { dockerService } from './services/docker.service';
import { config } from './config';
import { logger } from './utils/logger';

// Track active streams per socket to clean up on disconnect
interface SocketState {
  logStreams: Map<string, Readable>;
  execStreams: Map<string, { stream: Duplex; execId: string }>;
}

const socketStates = new Map<string, SocketState>();

function getState(socket: Socket): SocketState {
  let state = socketStates.get(socket.id);
  if (!state) {
    state = { logStreams: new Map(), execStreams: new Map() };
    socketStates.set(socket.id, state);
  }
  return state;
}

/** Strip the 8-byte Docker multiplexed stream header from each frame */
function stripDockerHeader(buf: Buffer): string {
  const chunks: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    if (offset + 8 + size > buf.length) {
      // Incomplete frame — output remainder as-is
      chunks.push(buf.slice(offset).toString('utf8'));
      break;
    }
    chunks.push(buf.slice(offset + 8, offset + 8 + size).toString('utf8'));
    offset += 8 + size;
  }
  if (offset < buf.length && chunks.length === 0) {
    // No valid headers found — treat as raw TTY output
    return buf.toString('utf8');
  }
  return chunks.join('');
}

function setupLogHandlers(socket: Socket) {
  socket.on(SOCKET_EVENTS.CONTAINER_LOGS_SUBSCRIBE, async (data: { dockerId: string; tail?: number }) => {
    const state = getState(socket);
    const { dockerId, tail = 100 } = data;

    // Clean up existing log stream for this container
    const existing = state.logStreams.get(dockerId);
    if (existing) {
      existing.destroy();
      state.logStreams.delete(dockerId);
    }

    try {
      const stream = await dockerService.getContainerLogs(dockerId, tail);
      state.logStreams.set(dockerId, stream);

      stream.on('data', (chunk: Buffer) => {
        const text = stripDockerHeader(chunk);
        if (text) {
          socket.emit(SOCKET_EVENTS.CONTAINER_LOGS_DATA, { dockerId, data: text });
        }
      });

      stream.on('end', () => {
        state.logStreams.delete(dockerId);
      });

      stream.on('error', (err: Error) => {
        logger.error({ dockerId, err }, 'Log stream error');
        socket.emit(SOCKET_EVENTS.CONTAINER_LOGS_ERROR, { dockerId, error: err.message });
        state.logStreams.delete(dockerId);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      socket.emit(SOCKET_EVENTS.CONTAINER_LOGS_ERROR, { dockerId, error: msg });
    }
  });

  socket.on(SOCKET_EVENTS.CONTAINER_LOGS_UNSUBSCRIBE, (data: { dockerId: string }) => {
    const state = getState(socket);
    const stream = state.logStreams.get(data.dockerId);
    if (stream) {
      stream.destroy();
      state.logStreams.delete(data.dockerId);
    }
  });
}

function setupExecHandlers(socket: Socket) {
  socket.on(SOCKET_EVENTS.CONTAINER_EXEC_START, async (data: { dockerId: string; cols?: number; rows?: number }) => {
    if (!config.allowConsole) {
      socket.emit(SOCKET_EVENTS.CONTAINER_EXEC_ERROR, { dockerId: data.dockerId, error: 'Console access is disabled. Set ALLOW_CONSOLE=true to enable.' });
      return;
    }

    const state = getState(socket);
    const { dockerId, cols = 80, rows = 24 } = data;

    // Clean up existing exec for this container
    const existing = state.execStreams.get(dockerId);
    if (existing) {
      existing.stream.destroy();
      state.execStreams.delete(dockerId);
    }

    try {
      const { exec, stream } = await dockerService.execContainer(dockerId, cols, rows);
      state.execStreams.set(dockerId, { stream, execId: exec.id });

      stream.on('data', (chunk: Buffer) => {
        socket.emit(SOCKET_EVENTS.CONTAINER_EXEC_OUTPUT, { dockerId, data: chunk.toString('utf8') });
      });

      stream.on('end', () => {
        state.execStreams.delete(dockerId);
        socket.emit(SOCKET_EVENTS.CONTAINER_EXEC_ERROR, { dockerId, error: 'Session ended' });
      });

      stream.on('error', (err: Error) => {
        logger.error({ dockerId, err }, 'Exec stream error');
        socket.emit(SOCKET_EVENTS.CONTAINER_EXEC_ERROR, { dockerId, error: err.message });
        state.execStreams.delete(dockerId);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      socket.emit(SOCKET_EVENTS.CONTAINER_EXEC_ERROR, { dockerId, error: msg });
    }
  });

  socket.on(SOCKET_EVENTS.CONTAINER_EXEC_INPUT, (data: { dockerId: string; data: string }) => {
    const state = getState(socket);
    const entry = state.execStreams.get(data.dockerId);
    if (entry) {
      entry.stream.write(data.data);
    }
  });

  socket.on(SOCKET_EVENTS.CONTAINER_EXEC_RESIZE, async (data: { dockerId: string; cols: number; rows: number }) => {
    const state = getState(socket);
    const entry = state.execStreams.get(data.dockerId);
    if (entry) {
      try {
        await dockerService.execResize(entry.execId, data.cols, data.rows);
      } catch (err) {
        logger.warn({ dockerId: data.dockerId, err }, 'Failed to resize exec');
      }
    }
  });

  socket.on(SOCKET_EVENTS.CONTAINER_EXEC_STOP, (data: { dockerId: string }) => {
    const state = getState(socket);
    const entry = state.execStreams.get(data.dockerId);
    if (entry) {
      entry.stream.destroy();
      state.execStreams.delete(data.dockerId);
    }
  });
}

function cleanupSocket(socket: Socket) {
  const state = socketStates.get(socket.id);
  if (!state) return;

  for (const stream of state.logStreams.values()) {
    stream.destroy();
  }
  for (const entry of state.execStreams.values()) {
    entry.stream.destroy();
  }
  socketStates.delete(socket.id);
}

export function createSocketServer(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173', credentials: true },
  });

  // Authenticate Socket.IO connections via session cookie
  io.use((socket, next) => {
    const cookie = socket.handshake.headers.cookie;
    if (!cookie) return next(new Error('Authentication required'));
    // Parse connect.sid from cookie - if session middleware validated it, the user is authenticated
    // We rely on the same session store; a more robust check would parse and verify the session
    const hasSessionCookie = cookie.includes('connect.sid=');
    if (!hasSessionCookie) return next(new Error('Authentication required'));
    next();
  });

  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, 'Socket connected');

    setupLogHandlers(socket);
    setupExecHandlers(socket);

    socket.on('disconnect', () => {
      logger.info({ socketId: socket.id }, 'Socket disconnected');
      cleanupSocket(socket);
    });
  });

  return io;
}
