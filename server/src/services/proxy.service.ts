import { db } from '../db';
import type { ProxyHost, RedirectionHost, StreamHost, DeadHost, AccessList, Certificate, CustomPage } from '@oblihub/shared';
import { logger } from '../utils/logger';

// ── Helpers ──

function certRow(row: Record<string, unknown>): Certificate {
  return {
    id: row.id as number,
    domainNames: (row.domain_names as string[]) || [],
    provider: row.provider as Certificate['provider'],
    expiresAt: row.expires_at ? (row.expires_at as Date).toISOString() : null,
    status: row.status as Certificate['status'],
    errorMessage: (row.error_message as string) || null,
    acmeEmail: (row.acme_email as string) || null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function proxyRow(row: Record<string, unknown>, cert?: Certificate | null): ProxyHost {
  return {
    id: row.id as number,
    domainNames: (row.domain_names as string[]) || [],
    forwardScheme: (row.forward_scheme as 'http' | 'https') || 'http',
    forwardHost: row.forward_host as string,
    forwardPort: row.forward_port as number,
    certificateId: (row.certificate_id as number) || null,
    sslForced: row.ssl_forced as boolean,
    http2Support: row.http2_support as boolean,
    hstsEnabled: row.hsts_enabled as boolean,
    hstsSubdomains: row.hsts_subdomains as boolean,
    blockExploits: row.block_exploits as boolean,
    cachingEnabled: row.caching_enabled as boolean,
    websocketSupport: row.websocket_support as boolean,
    accessListId: (row.access_list_id as number) || null,
    advancedConfig: (row.advanced_config as string) || null,
    enabled: row.enabled as boolean,
    stackId: (row.stack_id as number) || null,
    clientMaxBodySize: (row.client_max_body_size as string) || null,
    proxyConnectTimeout: (row.proxy_connect_timeout as number) || null,
    proxySendTimeout: (row.proxy_send_timeout as number) || null,
    proxyReadTimeout: (row.proxy_read_timeout as number) || null,
    proxyBuffering: row.proxy_buffering as boolean | null ?? null,
    rateLimitRps: (row.rate_limit_rps as number) || null,
    rateLimitBurst: (row.rate_limit_burst as number) || null,
    gzipEnabled: (row.gzip_enabled as boolean) || false,
    corsEnabled: (row.cors_enabled as boolean) || false,
    customResponseHeaders: (row.custom_response_headers as { name: string; value: string; action: 'add' | 'remove' }[]) || null,
    errorPageId: (row.error_page_id as number) || null,
    autoMonitor: (row.auto_monitor as boolean) || false,
    certificate: cert || null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function redirectRow(row: Record<string, unknown>, cert?: Certificate | null): RedirectionHost {
  return {
    id: row.id as number,
    domainNames: (row.domain_names as string[]) || [],
    forwardScheme: (row.forward_scheme as 'http' | 'https') || 'https',
    forwardDomain: row.forward_domain as string,
    forwardPath: (row.forward_path as string) || '/',
    preservePath: row.preserve_path as boolean,
    certificateId: (row.certificate_id as number) || null,
    sslForced: row.ssl_forced as boolean,
    http2Support: row.http2_support as boolean,
    hstsEnabled: row.hsts_enabled as boolean,
    blockExploits: row.block_exploits as boolean,
    advancedConfig: (row.advanced_config as string) || null,
    enabled: row.enabled as boolean,
    certificate: cert || null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function streamRow(row: Record<string, unknown>): StreamHost {
  return {
    id: row.id as number,
    incomingPort: row.incoming_port as number,
    forwardingHost: row.forwarding_host as string,
    forwardingPort: row.forwarding_port as number,
    tcpForwarding: row.tcp_forwarding as boolean,
    udpForwarding: row.udp_forwarding as boolean,
    enabled: row.enabled as boolean,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function deadRow(row: Record<string, unknown>, cert?: Certificate | null): DeadHost {
  return {
    id: row.id as number,
    domainNames: (row.domain_names as string[]) || [],
    certificateId: (row.certificate_id as number) || null,
    sslForced: row.ssl_forced as boolean,
    http2Support: row.http2_support as boolean,
    hstsEnabled: row.hsts_enabled as boolean,
    advancedConfig: (row.advanced_config as string) || null,
    enabled: row.enabled as boolean,
    certificate: cert || null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

async function getCert(id: number | null): Promise<Certificate | null> {
  if (!id) return null;
  const row = await db('certificates').where({ id }).first();
  return row ? certRow(row) : null;
}

// ── Certificates ──

export const certificateService = {
  async getAll(): Promise<Certificate[]> {
    const rows = await db('certificates').orderBy('id');
    return rows.map(certRow);
  },

  async getById(id: number): Promise<Certificate | null> {
    const row = await db('certificates').where({ id }).first();
    return row ? certRow(row) : null;
  },

  async create(data: { domainNames: string[]; provider: string; acmeEmail?: string }): Promise<Certificate> {
    const [row] = await db('certificates').insert({
      domain_names: JSON.stringify(data.domainNames),
      provider: data.provider || 'letsencrypt',
      acme_email: data.acmeEmail || null,
      status: 'pending',
    }).returning('*');
    return certRow(row);
  },

  async updateStatus(id: number, status: string, paths?: { cert?: string; key?: string; chain?: string; expiresAt?: Date }, errorMessage?: string | null): Promise<void> {
    const update: Record<string, unknown> = { status, updated_at: new Date() };
    if (paths?.cert) update.certificate_path = paths.cert;
    if (paths?.key) update.key_path = paths.key;
    if (paths?.chain) update.chain_path = paths.chain;
    if (paths?.expiresAt) update.expires_at = paths.expiresAt;
    if (errorMessage !== undefined) update.error_message = errorMessage;
    await db('certificates').where({ id }).update(update);
  },

  async delete(id: number): Promise<void> {
    await db('certificates').where({ id }).delete();
  },
};

// ── Proxy Hosts ──

export const proxyHostService = {
  async getAll(): Promise<ProxyHost[]> {
    const rows = await db('proxy_hosts').orderBy('id');
    return Promise.all(rows.map(async (r) => proxyRow(r, await getCert(r.certificate_id))));
  },

  async getById(id: number): Promise<ProxyHost | null> {
    const row = await db('proxy_hosts').where({ id }).first();
    return row ? proxyRow(row, await getCert(row.certificate_id)) : null;
  },

  async getByStackId(stackId: number): Promise<ProxyHost[]> {
    const rows = await db('proxy_hosts').where({ stack_id: stackId }).orderBy('id');
    return Promise.all(rows.map(async (r) => proxyRow(r, await getCert(r.certificate_id))));
  },

  async create(data: Partial<ProxyHost>): Promise<ProxyHost> {
    const [row] = await db('proxy_hosts').insert({
      domain_names: JSON.stringify(data.domainNames || []),
      forward_scheme: data.forwardScheme || 'http',
      forward_host: data.forwardHost,
      forward_port: data.forwardPort || 80,
      certificate_id: data.certificateId || null,
      ssl_forced: data.sslForced || false,
      http2_support: data.http2Support || false,
      hsts_enabled: data.hstsEnabled || false,
      hsts_subdomains: data.hstsSubdomains || false,
      block_exploits: data.blockExploits || false,
      caching_enabled: data.cachingEnabled || false,
      websocket_support: data.websocketSupport || false,
      access_list_id: data.accessListId || null,
      advanced_config: data.advancedConfig || null,
      enabled: data.enabled !== false,
      stack_id: data.stackId || null,
      client_max_body_size: data.clientMaxBodySize || null,
      proxy_connect_timeout: data.proxyConnectTimeout || null,
      proxy_send_timeout: data.proxySendTimeout || null,
      proxy_read_timeout: data.proxyReadTimeout || null,
      proxy_buffering: data.proxyBuffering ?? null,
      rate_limit_rps: data.rateLimitRps || null,
      rate_limit_burst: data.rateLimitBurst || null,
      gzip_enabled: data.gzipEnabled || false,
      cors_enabled: data.corsEnabled || false,
      custom_response_headers: data.customResponseHeaders ? JSON.stringify(data.customResponseHeaders) : null,
      error_page_id: data.errorPageId || null,
      auto_monitor: data.autoMonitor || false,
    }).returning('*');
    return proxyRow(row, await getCert(row.certificate_id));
  },

  async update(id: number, data: Partial<ProxyHost>): Promise<ProxyHost | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.domainNames !== undefined) update.domain_names = JSON.stringify(data.domainNames);
    if (data.forwardScheme !== undefined) update.forward_scheme = data.forwardScheme;
    if (data.forwardHost !== undefined) update.forward_host = data.forwardHost;
    if (data.forwardPort !== undefined) update.forward_port = data.forwardPort;
    if (data.certificateId !== undefined) update.certificate_id = data.certificateId;
    if (data.sslForced !== undefined) update.ssl_forced = data.sslForced;
    if (data.http2Support !== undefined) update.http2_support = data.http2Support;
    if (data.hstsEnabled !== undefined) update.hsts_enabled = data.hstsEnabled;
    if (data.hstsSubdomains !== undefined) update.hsts_subdomains = data.hstsSubdomains;
    if (data.blockExploits !== undefined) update.block_exploits = data.blockExploits;
    if (data.cachingEnabled !== undefined) update.caching_enabled = data.cachingEnabled;
    if (data.websocketSupport !== undefined) update.websocket_support = data.websocketSupport;
    if (data.accessListId !== undefined) update.access_list_id = data.accessListId;
    if (data.advancedConfig !== undefined) update.advanced_config = data.advancedConfig;
    if (data.enabled !== undefined) update.enabled = data.enabled;
    if (data.stackId !== undefined) update.stack_id = data.stackId;
    if (data.clientMaxBodySize !== undefined) update.client_max_body_size = data.clientMaxBodySize;
    if (data.proxyConnectTimeout !== undefined) update.proxy_connect_timeout = data.proxyConnectTimeout;
    if (data.proxySendTimeout !== undefined) update.proxy_send_timeout = data.proxySendTimeout;
    if (data.proxyReadTimeout !== undefined) update.proxy_read_timeout = data.proxyReadTimeout;
    if (data.proxyBuffering !== undefined) update.proxy_buffering = data.proxyBuffering;
    if (data.rateLimitRps !== undefined) update.rate_limit_rps = data.rateLimitRps;
    if (data.rateLimitBurst !== undefined) update.rate_limit_burst = data.rateLimitBurst;
    if (data.gzipEnabled !== undefined) update.gzip_enabled = data.gzipEnabled;
    if (data.corsEnabled !== undefined) update.cors_enabled = data.corsEnabled;
    if (data.customResponseHeaders !== undefined) update.custom_response_headers = data.customResponseHeaders ? JSON.stringify(data.customResponseHeaders) : null;
    if (data.errorPageId !== undefined) update.error_page_id = data.errorPageId;
    if (data.autoMonitor !== undefined) update.auto_monitor = data.autoMonitor;
    const [row] = await db('proxy_hosts').where({ id }).update(update).returning('*');
    return row ? proxyRow(row, await getCert(row.certificate_id)) : null;
  },

  async delete(id: number): Promise<void> {
    await db('proxy_hosts').where({ id }).delete();
  },

  async getEnabled(): Promise<ProxyHost[]> {
    const rows = await db('proxy_hosts').where({ enabled: true }).orderBy('id');
    return Promise.all(rows.map(async (r) => proxyRow(r, await getCert(r.certificate_id))));
  },
};

// ── Redirection Hosts ──

export const redirectionService = {
  async getAll(): Promise<RedirectionHost[]> {
    const rows = await db('redirection_hosts').orderBy('id');
    return Promise.all(rows.map(async (r) => redirectRow(r, await getCert(r.certificate_id))));
  },

  async create(data: Partial<RedirectionHost>): Promise<RedirectionHost> {
    const [row] = await db('redirection_hosts').insert({
      domain_names: JSON.stringify(data.domainNames || []),
      forward_scheme: data.forwardScheme || 'https',
      forward_domain: data.forwardDomain,
      forward_path: data.forwardPath || '/',
      preserve_path: data.preservePath !== false,
      certificate_id: data.certificateId || null,
      ssl_forced: data.sslForced || false,
      http2_support: data.http2Support || false,
      hsts_enabled: data.hstsEnabled || false,
      block_exploits: data.blockExploits || false,
      advanced_config: data.advancedConfig || null,
      enabled: data.enabled !== false,
    }).returning('*');
    return redirectRow(row, await getCert(row.certificate_id));
  },

  async update(id: number, data: Partial<RedirectionHost>): Promise<RedirectionHost | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.domainNames !== undefined) update.domain_names = JSON.stringify(data.domainNames);
    if (data.forwardScheme !== undefined) update.forward_scheme = data.forwardScheme;
    if (data.forwardDomain !== undefined) update.forward_domain = data.forwardDomain;
    if (data.forwardPath !== undefined) update.forward_path = data.forwardPath;
    if (data.preservePath !== undefined) update.preserve_path = data.preservePath;
    if (data.certificateId !== undefined) update.certificate_id = data.certificateId;
    if (data.sslForced !== undefined) update.ssl_forced = data.sslForced;
    if (data.http2Support !== undefined) update.http2_support = data.http2Support;
    if (data.hstsEnabled !== undefined) update.hsts_enabled = data.hstsEnabled;
    if (data.blockExploits !== undefined) update.block_exploits = data.blockExploits;
    if (data.advancedConfig !== undefined) update.advanced_config = data.advancedConfig;
    if (data.enabled !== undefined) update.enabled = data.enabled;
    const [row] = await db('redirection_hosts').where({ id }).update(update).returning('*');
    return row ? redirectRow(row, await getCert(row.certificate_id)) : null;
  },

  async delete(id: number): Promise<void> {
    await db('redirection_hosts').where({ id }).delete();
  },
};

// ── Streams ──

export const streamService = {
  async getAll(): Promise<StreamHost[]> {
    const rows = await db('streams').orderBy('id');
    return rows.map(streamRow);
  },

  async create(data: Partial<StreamHost>): Promise<StreamHost> {
    const [row] = await db('streams').insert({
      incoming_port: data.incomingPort,
      forwarding_host: data.forwardingHost,
      forwarding_port: data.forwardingPort,
      tcp_forwarding: data.tcpForwarding !== false,
      udp_forwarding: data.udpForwarding || false,
      enabled: data.enabled !== false,
    }).returning('*');
    return streamRow(row);
  },

  async update(id: number, data: Partial<StreamHost>): Promise<StreamHost | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.incomingPort !== undefined) update.incoming_port = data.incomingPort;
    if (data.forwardingHost !== undefined) update.forwarding_host = data.forwardingHost;
    if (data.forwardingPort !== undefined) update.forwarding_port = data.forwardingPort;
    if (data.tcpForwarding !== undefined) update.tcp_forwarding = data.tcpForwarding;
    if (data.udpForwarding !== undefined) update.udp_forwarding = data.udpForwarding;
    if (data.enabled !== undefined) update.enabled = data.enabled;
    const [row] = await db('streams').where({ id }).update(update).returning('*');
    return row ? streamRow(row) : null;
  },

  async delete(id: number): Promise<void> {
    await db('streams').where({ id }).delete();
  },
};

// ── Dead Hosts ──

export const deadHostService = {
  async getAll(): Promise<DeadHost[]> {
    const rows = await db('dead_hosts').orderBy('id');
    return Promise.all(rows.map(async (r) => deadRow(r, await getCert(r.certificate_id))));
  },

  async create(data: Partial<DeadHost>): Promise<DeadHost> {
    const [row] = await db('dead_hosts').insert({
      domain_names: JSON.stringify(data.domainNames || []),
      certificate_id: data.certificateId || null,
      ssl_forced: data.sslForced || false,
      http2_support: data.http2Support || false,
      hsts_enabled: data.hstsEnabled || false,
      advanced_config: data.advancedConfig || null,
      enabled: data.enabled !== false,
    }).returning('*');
    return deadRow(row, await getCert(row.certificate_id));
  },

  async delete(id: number): Promise<void> {
    await db('dead_hosts').where({ id }).delete();
  },
};

// ── Access Lists ──

export const accessListService = {
  async getAll(): Promise<AccessList[]> {
    const rows = await db('access_lists').orderBy('id');
    return Promise.all(rows.map(async (r) => {
      const clients = await db('access_list_clients').where({ access_list_id: r.id });
      const auth = await db('access_list_auth').where({ access_list_id: r.id });
      return {
        id: r.id as number,
        name: r.name as string,
        satisfyAny: r.satisfy_any as boolean,
        passAuth: r.pass_auth as boolean,
        clients: clients.map((c: Record<string, unknown>) => ({ id: c.id as number, address: c.address as string, directive: c.directive as 'allow' | 'deny' })),
        auth: auth.map((a: Record<string, unknown>) => ({ id: a.id as number, username: a.username as string })),
        createdAt: (r.created_at as Date).toISOString(),
        updatedAt: (r.updated_at as Date).toISOString(),
      };
    }));
  },

  async create(data: { name: string; satisfyAny?: boolean; passAuth?: boolean }): Promise<AccessList> {
    const [row] = await db('access_lists').insert({
      name: data.name,
      satisfy_any: data.satisfyAny || false,
      pass_auth: data.passAuth || false,
    }).returning('*');
    return { id: row.id, name: row.name, satisfyAny: row.satisfy_any, passAuth: row.pass_auth, clients: [], auth: [], createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
  },

  async addClient(accessListId: number, address: string, directive: 'allow' | 'deny'): Promise<void> {
    await db('access_list_clients').insert({ access_list_id: accessListId, address, directive });
  },

  async removeClient(id: number): Promise<void> {
    await db('access_list_clients').where({ id }).delete();
  },

  async addAuth(accessListId: number, username: string, passwordHash: string): Promise<void> {
    await db('access_list_auth').insert({ access_list_id: accessListId, username, password_hash: passwordHash });
  },

  async removeAuth(id: number): Promise<void> {
    await db('access_list_auth').where({ id }).delete();
  },

  async delete(id: number): Promise<void> {
    await db('access_lists').where({ id }).delete();
  },
};

// ── Custom Pages ──

function customPageRow(row: Record<string, unknown>): CustomPage {
  return {
    id: row.id as number,
    name: row.name as string,
    description: (row.description as string) || null,
    errorCodes: (row.error_codes as number[]) || [],
    htmlContent: row.html_content as string,
    theme: (row.theme as string) || 'custom',
    isBuiltin: row.is_builtin as boolean,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export const customPageService = {
  async getAll(): Promise<CustomPage[]> {
    const rows = await db('custom_pages').orderBy('is_builtin', 'desc').orderBy('name');
    return rows.map(customPageRow);
  },

  async getById(id: number): Promise<CustomPage | null> {
    const row = await db('custom_pages').where({ id }).first();
    return row ? customPageRow(row) : null;
  },

  async create(data: { name: string; description?: string; errorCodes: number[]; htmlContent: string; theme?: string }): Promise<CustomPage> {
    const [row] = await db('custom_pages').insert({
      name: data.name,
      description: data.description || null,
      error_codes: JSON.stringify(data.errorCodes),
      html_content: data.htmlContent,
      theme: data.theme || 'custom',
      is_builtin: false,
    }).returning('*');
    return customPageRow(row);
  },

  async update(id: number, data: { name?: string; description?: string; errorCodes?: number[]; htmlContent?: string }): Promise<CustomPage | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.description !== undefined) update.description = data.description;
    if (data.errorCodes !== undefined) update.error_codes = JSON.stringify(data.errorCodes);
    if (data.htmlContent !== undefined) update.html_content = data.htmlContent;
    const [row] = await db('custom_pages').where({ id }).update(update).returning('*');
    return row ? customPageRow(row) : null;
  },

  async delete(id: number): Promise<void> {
    const page = await db('custom_pages').where({ id }).first();
    if (page?.is_builtin) throw new Error('Cannot delete built-in page');
    await db('custom_pages').where({ id }).delete();
  },
};
