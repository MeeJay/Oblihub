import Docker from 'dockerode';
import { db } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { encryptSecret, decryptSecret } from '../utils/crypto';
import type { DockerEngine, DockerEngineType } from '@oblihub/shared';

/**
 * Docker engine management.
 *
 * Supports four transports:
 *  - local          → unix socket on the Oblihub host (default seeded engine)
 *  - ssh            → ssh://user@host:port using a stored private key
 *  - https-apikey   → HTTP(S) Docker API behind a socket-proxy with a shared header
 *  - tls            → raw Docker TCP + mTLS (ca/cert/key)
 *
 * `dockerService.forEngine(engineId)` returns a cached dockerode client. Cache is invalidated
 * when an engine is updated or deleted. A failed test re-uses the same builder so the user can
 * iterate on config without restart.
 */

interface EngineRow {
  id: number;
  name: string;
  type: string;
  host: string | null;
  port: number | null;
  ssh_user: string | null;
  ssh_private_key_enc: string | null;
  ssh_known_host: string | null;
  api_key_enc: string | null;
  api_key_header: string | null;
  tls_ca: string | null;
  tls_cert: string | null;
  tls_key_enc: string | null;
  is_default: boolean;
  enabled: boolean;
  last_ping_at: Date | null;
  last_ping_status: string | null;
  last_ping_message: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToEngine(row: EngineRow): DockerEngine {
  return {
    id: row.id,
    name: row.name,
    type: row.type as DockerEngineType,
    host: row.host,
    port: row.port,
    sshUser: row.ssh_user,
    hasSshPrivateKey: !!row.ssh_private_key_enc,
    sshKnownHost: row.ssh_known_host,
    hasApiKey: !!row.api_key_enc,
    apiKeyHeader: row.api_key_header,
    tlsCa: row.tls_ca,
    tlsCert: row.tls_cert,
    hasTlsKey: !!row.tls_key_enc,
    isDefault: row.is_default,
    enabled: row.enabled,
    lastPingAt: row.last_ping_at?.toISOString() ?? null,
    lastPingStatus: (row.last_ping_status as 'ok' | 'error' | null) ?? null,
    lastPingMessage: row.last_ping_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

interface EngineCacheEntry {
  client: Docker;
  builtAt: number;
}

const clientCache = new Map<number, EngineCacheEntry>();

function buildDockerClient(row: EngineRow): Docker {
  if (row.type === 'local') {
    return new Docker({ socketPath: config.dockerSocket });
  }

  if (row.type === 'ssh') {
    if (!row.host || !row.ssh_user || !row.ssh_private_key_enc) {
      throw new Error(`Engine ${row.id} (ssh): host, ssh_user and ssh_private_key are required`);
    }
    const privateKey = decryptSecret(row.ssh_private_key_enc);
    // dockerode delegates SSH transport to ssh2 — we pass ssh2 options under `sshOptions`.
    return new Docker({
      protocol: 'ssh',
      host: row.host,
      port: row.port ?? 22,
      username: row.ssh_user,
      sshOptions: {
        privateKey,
      },
    } as unknown as Docker.DockerOptions);
  }

  if (row.type === 'https-apikey') {
    if (!row.host || !row.api_key_enc) {
      throw new Error(`Engine ${row.id} (https-apikey): host and api_key are required`);
    }
    const apiKey = decryptSecret(row.api_key_enc);
    const headerName = row.api_key_header || 'X-API-Key';
    // dockerode v3+ accepts `headers` in DockerOptions — added to every request.
    return new Docker({
      protocol: 'http',
      host: row.host,
      port: row.port ?? 2375,
      headers: { [headerName]: apiKey },
    } as unknown as Docker.DockerOptions);
  }

  if (row.type === 'tls') {
    if (!row.host || !row.tls_ca || !row.tls_cert || !row.tls_key_enc) {
      throw new Error(`Engine ${row.id} (tls): host, tls_ca, tls_cert and tls_key are required`);
    }
    const tlsKey = decryptSecret(row.tls_key_enc);
    return new Docker({
      protocol: 'https',
      host: row.host,
      port: row.port ?? 2376,
      ca: row.tls_ca,
      cert: row.tls_cert,
      key: tlsKey,
    });
  }

  throw new Error(`Unsupported engine type: ${row.type}`);
}

interface EngineCreateInput {
  name: string;
  type: DockerEngineType;
  host?: string;
  port?: number;
  sshUser?: string;
  sshPrivateKey?: string;
  sshKnownHost?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  tlsCa?: string;
  tlsCert?: string;
  tlsKey?: string;
  enabled?: boolean;
}

async function fetchRow(id: number): Promise<EngineRow | null> {
  const row = await db<EngineRow>('docker_engines').where({ id }).first();
  return row ?? null;
}

export const engineService = {
  async getAll(): Promise<DockerEngine[]> {
    const rows = await db<EngineRow>('docker_engines').orderBy('id');
    return rows.map(rowToEngine);
  },

  async getById(id: number): Promise<DockerEngine | null> {
    const row = await fetchRow(id);
    return row ? rowToEngine(row) : null;
  },

  async getDefault(): Promise<DockerEngine | null> {
    const row = await db<EngineRow>('docker_engines').where({ is_default: true, enabled: true }).first();
    return row ? rowToEngine(row) : null;
  },

  async create(data: EngineCreateInput): Promise<DockerEngine> {
    const insert: Record<string, unknown> = {
      name: data.name,
      type: data.type,
      host: data.host || null,
      port: data.port || null,
      ssh_user: data.sshUser || null,
      ssh_private_key_enc: data.sshPrivateKey ? encryptSecret(data.sshPrivateKey) : null,
      ssh_known_host: data.sshKnownHost || null,
      api_key_enc: data.apiKey ? encryptSecret(data.apiKey) : null,
      api_key_header: data.apiKeyHeader || (data.type === 'https-apikey' ? 'X-API-Key' : null),
      tls_ca: data.tlsCa || null,
      tls_cert: data.tlsCert || null,
      tls_key_enc: data.tlsKey ? encryptSecret(data.tlsKey) : null,
      is_default: false,
      enabled: data.enabled !== false,
    };
    const [row] = await db<EngineRow>('docker_engines').insert(insert).returning('*');
    return rowToEngine(row);
  },

  async update(id: number, data: Partial<{
    name: string;
    host: string | null;
    port: number | null;
    sshUser: string | null;
    sshPrivateKey: string;
    sshKnownHost: string | null;
    apiKey: string;
    apiKeyHeader: string | null;
    tlsCa: string | null;
    tlsCert: string | null;
    tlsKey: string;
    enabled: boolean;
  }>): Promise<DockerEngine | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.host !== undefined) update.host = data.host;
    if (data.port !== undefined) update.port = data.port;
    if (data.sshUser !== undefined) update.ssh_user = data.sshUser;
    if (data.sshPrivateKey !== undefined && data.sshPrivateKey !== '') update.ssh_private_key_enc = encryptSecret(data.sshPrivateKey);
    if (data.sshKnownHost !== undefined) update.ssh_known_host = data.sshKnownHost;
    if (data.apiKey !== undefined && data.apiKey !== '') update.api_key_enc = encryptSecret(data.apiKey);
    if (data.apiKeyHeader !== undefined) update.api_key_header = data.apiKeyHeader;
    if (data.tlsCa !== undefined) update.tls_ca = data.tlsCa;
    if (data.tlsCert !== undefined) update.tls_cert = data.tlsCert;
    if (data.tlsKey !== undefined && data.tlsKey !== '') update.tls_key_enc = encryptSecret(data.tlsKey);
    if (data.enabled !== undefined) update.enabled = data.enabled;

    await db('docker_engines').where({ id }).update(update);
    clientCache.delete(id);
    const row = await fetchRow(id);
    return row ? rowToEngine(row) : null;
  },

  async delete(id: number): Promise<void> {
    const row = await fetchRow(id);
    if (!row) return;
    if (row.is_default) throw new Error('Cannot delete the default engine');
    // ON DELETE SET NULL on engine_id FKs means stacks/containers don't get cascaded;
    // they'll keep their last-known state but won't be polled anymore.
    await db('docker_engines').where({ id }).delete();
    clientCache.delete(id);
  },

  async setDefault(id: number): Promise<void> {
    await db.transaction(async (trx) => {
      await trx('docker_engines').update({ is_default: false });
      await trx('docker_engines').where({ id }).update({ is_default: true });
    });
  },

  /** Get a dockerode client for an engine, using cache. Throws if the engine doesn't exist or is misconfigured. */
  async getClient(id: number): Promise<Docker> {
    const cached = clientCache.get(id);
    if (cached) return cached.client;
    const row = await fetchRow(id);
    if (!row) throw new Error(`Engine ${id} not found`);
    if (!row.enabled) throw new Error(`Engine ${id} is disabled`);
    const client = buildDockerClient(row);
    clientCache.set(id, { client, builtAt: Date.now() });
    return client;
  },

  /** Open a fresh client without caching — used by testConnection so we don't poison the cache on failure. */
  async _buildEphemeralClient(row: EngineRow): Promise<Docker> {
    return buildDockerClient(row);
  },

  /** Try a no-op call (ping) and update last_ping_*. Returns { ok, message }. */
  async testConnection(id: number): Promise<{ ok: boolean; message?: string; serverVersion?: string }> {
    const row = await fetchRow(id);
    if (!row) return { ok: false, message: 'Engine not found' };
    try {
      const client = buildDockerClient(row);
      const info = await client.version();
      await db('docker_engines').where({ id }).update({
        last_ping_at: new Date(),
        last_ping_status: 'ok',
        last_ping_message: `Docker ${info.Version} (API ${info.ApiVersion})`,
      });
      // Cache the working client.
      clientCache.set(id, { client, builtAt: Date.now() });
      return { ok: true, serverVersion: info.Version };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ engineId: id, err }, 'Engine test connection failed');
      await db('docker_engines').where({ id }).update({
        last_ping_at: new Date(),
        last_ping_status: 'error',
        last_ping_message: message.slice(0, 1000),
      });
      clientCache.delete(id);
      return { ok: false, message };
    }
  },

  /** Test a transient config that hasn't been persisted yet — for the "Test connection" button in the form. */
  async testConfig(data: EngineCreateInput): Promise<{ ok: boolean; message?: string; serverVersion?: string }> {
    const fakeRow: EngineRow = {
      id: 0,
      name: data.name,
      type: data.type,
      host: data.host || null,
      port: data.port || null,
      ssh_user: data.sshUser || null,
      ssh_private_key_enc: data.sshPrivateKey ? encryptSecret(data.sshPrivateKey) : null,
      ssh_known_host: data.sshKnownHost || null,
      api_key_enc: data.apiKey ? encryptSecret(data.apiKey) : null,
      api_key_header: data.apiKeyHeader || null,
      tls_ca: data.tlsCa || null,
      tls_cert: data.tlsCert || null,
      tls_key_enc: data.tlsKey ? encryptSecret(data.tlsKey) : null,
      is_default: false,
      enabled: true,
      last_ping_at: null,
      last_ping_status: null,
      last_ping_message: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    try {
      const client = buildDockerClient(fakeRow);
      const info = await client.version();
      return { ok: true, serverVersion: info.Version };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },

  /** Invalidate cached clients — called when secrets are rotated externally. */
  invalidateCache(id?: number): void {
    if (id == null) clientCache.clear();
    else clientCache.delete(id);
  },
};
