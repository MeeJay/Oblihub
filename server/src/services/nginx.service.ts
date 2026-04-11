import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { db } from '../db';
import { dockerService } from './docker.service';
import { proxyHostService, redirectionService, streamService, deadHostService, accessListService, customPageService } from './proxy.service';
import type { ProxyHost, RedirectionHost, DeadHost, AccessList } from '@oblihub/shared';
import { logger } from '../utils/logger';

const PROXY_DIR = path.join(config.stacksDir, '_proxy');
const CONF_DIR = path.join(PROXY_DIR, 'conf.d');
const STREAM_DIR = path.join(PROXY_DIR, 'stream.d');
const CERTS_DIR = path.join(PROXY_DIR, 'certs');
const ACME_DIR = path.join(PROXY_DIR, 'acme-challenge');
const HTPASSWD_DIR = path.join(PROXY_DIR, 'htpasswd');
const ERROR_PAGES_DIR = path.join(PROXY_DIR, 'error_pages');

function ensureDirs() {
  for (const dir of [PROXY_DIR, CONF_DIR, STREAM_DIR, CERTS_DIR, ACME_DIR, HTPASSWD_DIR, ERROR_PAGES_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
  // Ensure acme-challenge is world-readable for nginx
  try { fs.chmodSync(ACME_DIR, 0o755); } catch { /* ignore */ }
}

// ── Config snippets ──

function blockExploitsSnippet(): string {
  return `
    # Block common exploits
    location ~* "(\\.\\.)" { deny all; }
    location ~* "(~)$" { deny all; }
    location ~* "(\\.(?:bak|conf|dist|fla|in[ci]|log|psd|sh|sql|sw[op]|env))$" { deny all; }
    location ~* "/(wp-config\\.php|xmlrpc\\.php)" { deny all; }`;
}

function cachingSnippet(): string {
  return `
    # Cache static assets
    location ~* \\.(css|js|jpg|jpeg|png|gif|ico|svg|woff|woff2|ttf|eot|webp|avif)$ {
        proxy_cache_valid 200 1d;
        add_header X-Cache-Status $upstream_cache_status;
        expires 1d;
    }`;
}

function gzipSnippet(): string {
  return `
    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_min_length 1000;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;`;
}

function corsSnippet(): string {
  return `
    # CORS headers
    add_header Access-Control-Allow-Origin * always;
    add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, PATCH, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Authorization, Content-Type, Accept, Origin, X-Requested-With" always;
    add_header Access-Control-Max-Age 86400 always;
    if ($request_method = 'OPTIONS') {
        return 204;
    }`;
}

function rateLimitDirective(hostId: number, burst: number): string {
  return `    limit_req zone=rl_${hostId} burst=${burst} nodelay;`;
}

function customHeadersSnippet(headers: { name: string; value: string; action: 'add' | 'remove' }[]): string {
  return headers.map(h => {
    const name = sanitizeForNginx(h.name);
    const value = sanitizeForNginx(h.value);
    if (h.action === 'remove') return `    proxy_hide_header ${name};`;
    return `    add_header ${name} "${value}" always;`;
  }).join('\n');
}

function hstsSnippet(subdomains: boolean): string {
  const sub = subdomains ? '; includeSubDomains' : '';
  return `    add_header Strict-Transport-Security "max-age=63072000${sub}" always;`;
}

function sslBlock(certPath: string, keyPath: string, http2: boolean): string {
  const h2 = http2 ? '\n    http2 on;' : '';
  return `    listen 443 ssl;
    listen [::]:443 ssl;${h2}
    ssl_certificate ${certPath};
    ssl_certificate_key ${keyPath};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';
    ssl_prefer_server_ciphers off;`;
}

function accessListBlock(listId: number, list?: AccessList): string {
  if (!list) return '';
  const hasClients = list.clients.length > 0;
  const hasAuth = list.auth.length > 0;
  if (!hasClients && !hasAuth) return ''; // No rules = allow all

  let conf = `\n    # Access list: ${list.name}\n`;

  // IP rules first (deny before auth)
  if (hasClients) {
    for (const c of list.clients) {
      conf += `    ${c.directive === 'allow' ? 'allow' : 'deny'} ${c.address.replace(/[;\n\r{}#'"\\]/g, '')};\n`;
    }
    // Deny all others not explicitly allowed
    const hasAllow = list.clients.some(c => c.directive === 'allow');
    if (hasAllow) conf += `    deny all;\n`;
  }

  // Basic auth (only if there are auth entries)
  if (hasAuth) {
    if (hasClients && !list.satisfyAny) {
      conf += `    satisfy all;\n`; // Need both IP + auth
    } else if (hasClients && list.satisfyAny) {
      conf += `    satisfy any;\n`; // Either IP or auth
    }
    conf += `    auth_basic "Restricted";\n`;
    conf += `    auth_basic_user_file /etc/nginx/htpasswd/access_list_${listId};\n`;
  }

  return conf;
}

// ── Proxy Host config ──

function sanitizeForNginx(value: string): string {
  return value.replace(/[;\n\r{}#'"\\]/g, '');
}

function generateProxyHostConfig(host: ProxyHost, accessLists: AccessList[] = []): string {
  const domains = host.domainNames.map(d => sanitizeForNginx(d)).join(' ');
  const upstream = `${sanitizeForNginx(host.forwardScheme)}://${sanitizeForNginx(host.forwardHost)}:${host.forwardPort}`;
  const certDomain = host.certificate?.domainNames?.[0] || '';
  const certFile = certDomain ? path.join(CERTS_DIR, `${certDomain}.fullchain.crt`) : '';
  const keyFile = certDomain ? path.join(CERTS_DIR, `${certDomain}.key`) : '';
  const hasCert = host.certificate && host.certificate.status === 'valid' && host.certificateId
    && certFile && keyFile && fs.existsSync(certFile) && fs.existsSync(keyFile);

  let conf = `# Proxy Host ${host.id} - ${domains}\n`;

  // HTTP server block
  if (host.sslForced && hasCert) {
    conf += `server {
    listen 80;
    listen [::]:80;
    server_name ${domains};

    # ACME challenge
    location /.well-known/acme-challenge/ {
        alias /etc/nginx/acme-challenge/;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}\n\n`;
  }

  // Main server block
  conf += `server {\n`;

  if (hasCert) {
    const sslDomain = host.certificate?.domainNames?.[0] || '';
    conf += sslBlock(
      `/etc/nginx/certs/${sslDomain}.fullchain.crt`,
      `/etc/nginx/certs/${sslDomain}.key`,
      host.http2Support,
    ) + '\n';
  }

  if (!host.sslForced || !hasCert) {
    conf += `    listen 80;\n    listen [::]:80;\n`;
  }

  conf += `    server_name ${domains};\n\n`;

  // ACME challenge (always serve)
  conf += `    location /.well-known/acme-challenge/ {
        alias /etc/nginx/acme-challenge/;
    }\n\n`;

  if (host.hstsEnabled && hasCert) {
    conf += hstsSnippet(host.hstsSubdomains) + '\n\n';
  }

  if (host.blockExploits) {
    conf += blockExploitsSnippet() + '\n\n';
  }

  if (host.accessListId) {
    const accessList = accessLists.find(al => al.id === host.accessListId);
    conf += accessListBlock(host.accessListId, accessList) + '\n\n';
  }

  if (host.cachingEnabled) {
    conf += cachingSnippet() + '\n\n';
  }

  if (host.gzipEnabled) {
    conf += gzipSnippet() + '\n\n';
  }

  if (host.corsEnabled) {
    conf += corsSnippet() + '\n\n';
  }

  if (host.clientMaxBodySize) {
    conf += `    client_max_body_size ${sanitizeForNginx(host.clientMaxBodySize)};\n\n`;
  }

  if (host.rateLimitRps) {
    conf += rateLimitDirective(host.id, host.rateLimitBurst || 10) + '\n\n';
  }

  if (host.customResponseHeaders?.length) {
    conf += customHeadersSnippet(host.customResponseHeaders) + '\n\n';
  }

  // Error pages
  if (host.errorPageId) {
    // Per-code error pages with dynamic content
    const errorCodes = [400, 401, 403, 404, 500, 502, 503, 504];
    for (const code of errorCodes) {
      conf += `    error_page ${code} /oblihub_err_${host.errorPageId}_${code}.html;\n`;
    }
    for (const code of errorCodes) {
      conf += `    location = /oblihub_err_${host.errorPageId}_${code}.html {\n`;
      conf += `        internal;\n`;
      conf += `        alias /etc/nginx/error_pages/page_${host.errorPageId}_${code}.html;\n`;
      conf += `    }\n`;
    }
    conf += '\n';
  }

  // Resolver for dynamic upstream DNS (Docker internal DNS)
  conf += `    resolver 127.0.0.11 valid=10s ipv6=off;\n`;
  conf += `    set $upstream ${upstream};\n\n`;

  // Main location
  conf += `    location / {\n`;
  conf += `        proxy_pass $upstream;\n`;
  conf += `        proxy_set_header Host $host;\n`;
  conf += `        proxy_set_header X-Real-IP $remote_addr;\n`;
  conf += `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n`;
  conf += `        proxy_set_header X-Forwarded-Proto $scheme;\n`;
  conf += `        proxy_set_header X-Forwarded-Host $host;\n`;
  conf += `        proxy_set_header X-Forwarded-Port $server_port;\n`;
  conf += `        proxy_http_version 1.1;\n`;

  if (host.websocketSupport) {
    conf += `        proxy_set_header Upgrade $http_upgrade;\n`;
    conf += `        proxy_set_header Connection $http_connection;\n`;
  }

  if (host.proxyBuffering === false) {
    conf += `        proxy_buffering off;\n`;
  }

  const connectTimeout = host.proxyConnectTimeout || 60;
  const sendTimeout = host.proxySendTimeout || 60;
  const readTimeout = host.proxyReadTimeout || 60;
  conf += `        proxy_connect_timeout ${connectTimeout}s;\n`;
  conf += `        proxy_send_timeout ${sendTimeout}s;\n`;
  conf += `        proxy_read_timeout ${readTimeout}s;\n`;
  conf += `    }\n`;

  if (host.advancedConfig) {
    conf += `\n    # Advanced config\n    ${host.advancedConfig.replace(/\n/g, '\n    ')}\n`;
  }

  conf += `}\n`;

  return conf;
}

// ── Redirection Host config ──

function generateRedirectionConfig(host: RedirectionHost): string {
  const domains = host.domainNames.join(' ');
  const target = `${host.forwardScheme}://${host.forwardDomain}${host.forwardPath}`;
  const hasCert = host.certificate && host.certificate.status === 'valid' && host.certificateId;

  let conf = `# Redirection ${host.id} - ${domains}\nserver {\n`;

  if (hasCert) {
    const sslDomain = host.certificate?.domainNames?.[0] || '';
    conf += sslBlock(
      `/etc/nginx/certs/${sslDomain}.fullchain.crt`,
      `/etc/nginx/certs/${sslDomain}.key`,
      host.http2Support,
    ) + '\n';
  }
  conf += `    listen 80;\n    listen [::]:80;\n`;
  conf += `    server_name ${domains};\n\n`;

  const redirect = host.preservePath ? `${target}$request_uri` : target;
  conf += `    location / {\n        return 301 ${redirect};\n    }\n`;
  conf += `}\n`;

  return conf;
}

// ── Dead Host config ──

function generateDeadHostConfig(host: DeadHost): string {
  const domains = host.domainNames.join(' ');

  let conf = `# 404 Host ${host.id} - ${domains}\nserver {\n`;
  conf += `    listen 80;\n    listen [::]:80;\n`;
  conf += `    server_name ${domains};\n`;
  conf += `    return 404;\n`;
  conf += `}\n`;

  return conf;
}

// ── Main nginx.conf ──

function generateMainConfig(rateLimitedHosts: { id: number; rps: number }[] = []): string {
  const rateLimitZones = rateLimitedHosts.map(h => `    limit_req_zone $binary_remote_addr zone=rl_${h.id}:10m rate=${h.rps}r/s;`).join('\n');

  return `user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';

    access_log /var/log/nginx/access.log main;

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    client_max_body_size 100m;

${rateLimitZones ? `    # Rate limit zones\n${rateLimitZones}\n` : ''}    # WebSocket support
    map $http_upgrade $connection_upgrade {
        default upgrade;
        '' close;
    }
    map $http_upgrade $http_connection {
        default upgrade;
        '' "";
    }

    # Proxy cache
    proxy_cache_path /tmp/nginx-cache levels=1:2 keys_zone=proxy_cache:10m max_size=1g inactive=60m;

    # Default server - catch all with error page
    server {
        listen 80 default_server;
        listen [::]:80 default_server;
        listen 443 ssl default_server;
        listen [::]:443 ssl default_server;
        server_name _;

        # Self-signed fallback cert for default server (prevents SSL errors on unknown hosts)
        ssl_reject_handshake on;

        location /.well-known/acme-challenge/ {
            alias /etc/nginx/acme-challenge/;
        }

        location / {
            return 444;
        }
    }

    include /etc/nginx/conf.d/*.conf;
}

stream {
    include /etc/nginx/stream.d/*.conf;
}
`;
}

// ── Stream config ──

function generateStreamConfig(s: { id: number; incomingPort: number; forwardingHost: string; forwardingPort: number; tcpForwarding: boolean; udpForwarding: boolean }): string {
  let conf = `# Stream ${s.id}\n`;
  if (s.tcpForwarding) {
    conf += `server {\n    listen ${s.incomingPort};\n    proxy_pass ${s.forwardingHost}:${s.forwardingPort};\n}\n`;
  }
  if (s.udpForwarding) {
    conf += `server {\n    listen ${s.incomingPort} udp;\n    proxy_pass ${s.forwardingHost}:${s.forwardingPort};\n}\n`;
  }
  return conf;
}

// ── Public API ──

export const nginxService = {
  /** Write all configs and reload nginx */
  async regenerateAndReload(): Promise<void> {
    ensureDirs();

    // Get global default error page
    const { appConfigService } = await import('./appConfig.service');
    const defaultErrorPageIdStr = await appConfigService.get('default_error_page_id');
    const defaultErrorPageId = defaultErrorPageIdStr ? parseInt(defaultErrorPageIdStr) : null;

    // Get enabled proxy hosts for rate limit zones
    const enabledHosts = await proxyHostService.getEnabled();
    const rateLimitedHosts = enabledHosts.filter(h => h.rateLimitRps).map(h => ({ id: h.id, rps: h.rateLimitRps! }));

    // Write main config (with rate limit zones)
    fs.writeFileSync(path.join(PROXY_DIR, 'nginx.conf'), generateMainConfig(rateLimitedHosts));

    // Write custom error pages to disk (one file per error code with dynamic replacement)
    const ERROR_MESSAGES: Record<number, string> = {
      400: 'Bad Request', 401: 'Unauthorized', 403: 'Access Denied', 404: 'Page Not Found',
      500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
    };
    const customPages = await customPageService.getAll();
    for (const page of customPages) {
      // Generate a page per error code with dynamic code/message
      for (const code of page.errorCodes) {
        const message = ERROR_MESSAGES[code] || `Error ${code}`;
        const html = page.htmlContent
          .replace(/\{\{CODE\}\}/g, String(code))
          .replace(/\{\{MESSAGE\}\}/g, message);
        fs.writeFileSync(path.join(ERROR_PAGES_DIR, `page_${page.id}_${code}.html`), html);
      }
      // Also write a generic fallback
      const fallbackHtml = page.htmlContent
        .replace(/\{\{CODE\}\}/g, 'Error')
        .replace(/\{\{MESSAGE\}\}/g, 'Something went wrong');
      fs.writeFileSync(path.join(ERROR_PAGES_DIR, `page_${page.id}.html`), fallbackHtml);
    }

    // Clear old configs
    for (const f of fs.readdirSync(CONF_DIR)) fs.unlinkSync(path.join(CONF_DIR, f));
    for (const f of fs.readdirSync(STREAM_DIR)) fs.unlinkSync(path.join(STREAM_DIR, f));

    // Generate proxy host configs (named by primary domain)
    // Load access lists for config generation
    const allAccessLists = await accessListService.getAll();

    // Include disabled hosts with return 503 so they keep their cert and don't leak to other vhosts
    const allProxyHosts = await proxyHostService.getAll();
    for (const host of allProxyHosts) {
      if (!host.enabled) {
        // Disabled host: keep server_name + SSL but return 503
        const domains = host.domainNames.map(d => sanitizeForNginx(d)).join(' ');
        const certDomain = host.certificate?.domainNames?.[0] || '';
        const certFile = certDomain ? path.join(CERTS_DIR, `${certDomain}.fullchain.crt`) : '';
        const keyFile = certDomain ? path.join(CERTS_DIR, `${certDomain}.key`) : '';
        const hasCert = host.certificate?.status === 'valid' && certFile && keyFile && fs.existsSync(certFile) && fs.existsSync(keyFile);

        let conf = `# Disabled: ${domains}\nserver {\n    listen 80;\n    listen [::]:80;\n`;
        if (hasCert) {
          conf += `    listen 443 ssl;\n    listen [::]:443 ssl;\n    http2 on;\n`;
          conf += `    ssl_certificate /etc/nginx/certs/${certDomain}.fullchain.crt;\n`;
          conf += `    ssl_certificate_key /etc/nginx/certs/${certDomain}.key;\n`;
        }
        conf += `    server_name ${domains};\n    return 503;\n}\n`;
        fs.writeFileSync(path.join(CONF_DIR, `${host.domainNames[0] || `proxy_${host.id}`}.conf`), conf);
      } else {
        // Apply default error page
        if (!host.errorPageId && defaultErrorPageId) host.errorPageId = defaultErrorPageId;
        fs.writeFileSync(path.join(CONF_DIR, `${host.domainNames[0] || `proxy_${host.id}`}.conf`), generateProxyHostConfig(host, allAccessLists));
      }
    }

    // Generate redirection configs
    const redirections = await redirectionService.getAll();
    for (const host of redirections.filter(r => r.enabled)) {
      const filename = `redir_${host.domainNames[0] || host.id}.conf`;
      fs.writeFileSync(path.join(CONF_DIR, filename), generateRedirectionConfig(host));
    }

    // Generate dead host configs
    const deadHosts = await deadHostService.getAll();
    for (const host of deadHosts.filter(h => h.enabled)) {
      const filename = `dead_${host.domainNames[0] || host.id}.conf`;
      fs.writeFileSync(path.join(CONF_DIR, filename), generateDeadHostConfig(host));
    }

    // Generate stream configs
    const streams = await streamService.getAll();
    for (const s of streams.filter(s => s.enabled)) {
      const filename = `stream_${s.id}.conf`;
      fs.writeFileSync(path.join(STREAM_DIR, filename), generateStreamConfig(s));
    }

    // Generate htpasswd files for access lists (using stored hashes)
    const accessLists = await accessListService.getAll();
    for (const list of accessLists) {
      const authRows = await db('access_list_auth').where({ access_list_id: list.id });
      const htpasswdContent = authRows.map((a: { username: string; password_hash: string }) => `${a.username}:${a.password_hash}`).join('\n');
      fs.writeFileSync(path.join(HTPASSWD_DIR, `access_list_${list.id}`), htpasswdContent);
    }

    logger.info({ proxyHosts: allProxyHosts.length, redirections: redirections.length, streams: streams.length }, 'Nginx configs regenerated');

    // Reload nginx container (SIGHUP is safe - nginx keeps old config if new one is invalid)
    await this.reloadProxy();
  },

  /** Reload the proxy nginx container */
  async reloadProxy(): Promise<void> {
    try {
      const docker = (await import('dockerode')).default;
      const d = new docker({ socketPath: config.dockerSocket });
      const containers = await d.listContainers({ all: false });
      const proxy = containers.find(c => {
        const labels = c.Labels || {};
        return labels['oblihub.proxy'] === 'true';
      });

      if (!proxy) {
        logger.warn('No proxy container found (label oblihub.proxy=true). Configs written but not reloaded.');
        return;
      }

      const container = d.getContainer(proxy.Id);
      // Use docker exec to reload nginx (PID 1 may be sh, not nginx)
      const exec = await container.exec({
        Cmd: ['nginx', '-s', 'reload'],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({});
      // Collect output for logging
      let output = '';
      await new Promise<void>((resolve) => {
        stream.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        stream.on('end', resolve);
        stream.on('error', resolve);
      });
      if (output.trim()) logger.info({ output: output.trim() }, 'Nginx reload output');
      logger.info('Nginx proxy reloaded');
    } catch (err) {
      logger.error({ err }, 'Failed to reload nginx proxy');
    }
  },

  /** Test nginx config before applying */
  async testConfig(): Promise<{ valid: boolean; error?: string }> {
    try {
      const docker = (await import('dockerode')).default;
      const d = new docker({ socketPath: config.dockerSocket });
      const containers = await d.listContainers({ all: false });
      const proxy = containers.find(c => (c.Labels || {})['oblihub.proxy'] === 'true');
      if (!proxy) return { valid: true }; // Can't test without container

      const container = d.getContainer(proxy.Id);
      const exec = await container.exec({ Cmd: ['nginx', '-t'], AttachStdout: true, AttachStderr: true });
      const stream = await exec.start({});

      return new Promise((resolve) => {
        let output = '';
        stream.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        stream.on('end', async () => {
          const info = await exec.inspect();
          resolve({ valid: info.ExitCode === 0, error: info.ExitCode !== 0 ? output : undefined });
        });
      });
    } catch {
      return { valid: true };
    }
  },

  /** Get paths for certificate files by domain name */
  getCertPathsByDomain(domain: string) {
    // Sanitize domain to prevent path traversal
    const safeDomain = domain.replace(/[^a-zA-Z0-9._-]/g, '_');
    return {
      cert: path.join(CERTS_DIR, `${safeDomain}.crt`),
      key: path.join(CERTS_DIR, `${safeDomain}.key`),
      chain: path.join(CERTS_DIR, `${safeDomain}.chain.crt`),
      fullchain: path.join(CERTS_DIR, `${safeDomain}.fullchain.crt`),
    };
  },

  /** Write certificate files named by primary domain */
  writeCertFiles(domain: string, cert: string, key: string, chain?: string): void {
    ensureDirs();
    const paths = this.getCertPathsByDomain(domain);
    fs.writeFileSync(paths.cert, cert);
    fs.writeFileSync(paths.key, key, { mode: 0o600 });
    if (chain) fs.writeFileSync(paths.chain, chain);
    const fullchain = chain ? cert + '\n' + chain : cert;
    fs.writeFileSync(paths.fullchain, fullchain);
  },

  /** Get the ACME challenge directory path */
  getAcmeDir(): string {
    ensureDirs();
    return ACME_DIR;
  },

  /** Get the proxy config directory */
  getProxyDir(): string {
    return PROXY_DIR;
  },
};
