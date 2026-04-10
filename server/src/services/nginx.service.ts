import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { dockerService } from './docker.service';
import { proxyHostService, redirectionService, streamService, deadHostService, accessListService } from './proxy.service';
import type { ProxyHost, RedirectionHost, DeadHost, AccessList } from '@oblihub/shared';
import { logger } from '../utils/logger';

const PROXY_DIR = path.join(config.stacksDir, '_proxy');
const CONF_DIR = path.join(PROXY_DIR, 'conf.d');
const STREAM_DIR = path.join(PROXY_DIR, 'stream.d');
const CERTS_DIR = path.join(PROXY_DIR, 'certs');
const ACME_DIR = path.join(PROXY_DIR, 'acme-challenge');
const HTPASSWD_DIR = path.join(PROXY_DIR, 'htpasswd');

function ensureDirs() {
  for (const dir of [PROXY_DIR, CONF_DIR, STREAM_DIR, CERTS_DIR, ACME_DIR, HTPASSWD_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
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

function hstsSnippet(subdomains: boolean): string {
  const sub = subdomains ? '; includeSubDomains' : '';
  return `    add_header Strict-Transport-Security "max-age=63072000${sub}" always;`;
}

function sslBlock(certPath: string, keyPath: string, http2: boolean): string {
  const h2 = http2 ? ' http2' : '';
  return `    listen 443 ssl${h2};
    listen [::]:443 ssl${h2};
    ssl_certificate ${certPath};
    ssl_certificate_key ${keyPath};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';
    ssl_prefer_server_ciphers off;`;
}

function accessListBlock(listId: number, _list?: AccessList): string {
  // Generate htpasswd and IP rules
  return `
    # Access list ${listId}
    auth_basic "Restricted";
    auth_basic_user_file /etc/nginx/htpasswd/access_list_${listId};`;
}

// ── Proxy Host config ──

function generateProxyHostConfig(host: ProxyHost): string {
  const domains = host.domainNames.join(' ');
  const upstream = `${host.forwardScheme}://${host.forwardHost}:${host.forwardPort}`;
  const hasCert = host.certificate && host.certificate.status === 'valid' && host.certificateId;

  let conf = `# Proxy Host ${host.id} - ${domains}\n`;

  // HTTP server block
  if (host.sslForced && hasCert) {
    conf += `server {
    listen 80;
    listen [::]:80;
    server_name ${domains};

    # ACME challenge
    location /.well-known/acme-challenge/ {
        root /etc/nginx/acme-challenge;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}\n\n`;
  }

  // Main server block
  conf += `server {\n`;

  if (hasCert) {
    conf += sslBlock(
      `/etc/nginx/certs/host_${host.id}.crt`,
      `/etc/nginx/certs/host_${host.id}.key`,
      host.http2Support,
    ) + '\n';
  }

  if (!host.sslForced || !hasCert) {
    conf += `    listen 80;\n    listen [::]:80;\n`;
  }

  conf += `    server_name ${domains};\n\n`;

  // ACME challenge (always serve)
  conf += `    location /.well-known/acme-challenge/ {
        root /etc/nginx/acme-challenge;
    }\n\n`;

  if (host.hstsEnabled && hasCert) {
    conf += hstsSnippet(host.hstsSubdomains) + '\n\n';
  }

  if (host.blockExploits) {
    conf += blockExploitsSnippet() + '\n\n';
  }

  if (host.accessListId) {
    conf += accessListBlock(host.accessListId) + '\n\n';
  }

  if (host.cachingEnabled) {
    conf += cachingSnippet() + '\n\n';
  }

  // Main location
  conf += `    location / {\n`;
  conf += `        proxy_pass ${upstream};\n`;
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

  conf += `        proxy_connect_timeout 60s;\n`;
  conf += `        proxy_send_timeout 60s;\n`;
  conf += `        proxy_read_timeout 60s;\n`;
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
    conf += sslBlock(
      `/etc/nginx/certs/redir_${host.id}.crt`,
      `/etc/nginx/certs/redir_${host.id}.key`,
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

function generateMainConfig(): string {
  return `user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

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

    # WebSocket support
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

    # Default server - catch all
    server {
        listen 80 default_server;
        listen [::]:80 default_server;
        server_name _;

        location /.well-known/acme-challenge/ {
            root /etc/nginx/acme-challenge;
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

    // Write main config
    fs.writeFileSync(path.join(PROXY_DIR, 'nginx.conf'), generateMainConfig());

    // Clear old configs
    for (const f of fs.readdirSync(CONF_DIR)) fs.unlinkSync(path.join(CONF_DIR, f));
    for (const f of fs.readdirSync(STREAM_DIR)) fs.unlinkSync(path.join(STREAM_DIR, f));

    // Generate proxy host configs
    const proxyHosts = await proxyHostService.getEnabled();
    for (const host of proxyHosts) {
      const filename = `proxy_host_${host.id}.conf`;
      fs.writeFileSync(path.join(CONF_DIR, filename), generateProxyHostConfig(host));
    }

    // Generate redirection configs
    const redirections = await redirectionService.getAll();
    for (const host of redirections.filter(r => r.enabled)) {
      const filename = `redir_${host.id}.conf`;
      fs.writeFileSync(path.join(CONF_DIR, filename), generateRedirectionConfig(host));
    }

    // Generate dead host configs
    const deadHosts = await deadHostService.getAll();
    for (const host of deadHosts.filter(h => h.enabled)) {
      const filename = `dead_${host.id}.conf`;
      fs.writeFileSync(path.join(CONF_DIR, filename), generateDeadHostConfig(host));
    }

    // Generate stream configs
    const streams = await streamService.getAll();
    for (const s of streams.filter(s => s.enabled)) {
      const filename = `stream_${s.id}.conf`;
      fs.writeFileSync(path.join(STREAM_DIR, filename), generateStreamConfig(s));
    }

    // Generate htpasswd files for access lists
    const accessLists = await accessListService.getAll();
    for (const list of accessLists) {
      const htpasswdContent = list.auth.map(a => `${a.username}:{PLAIN}password`).join('\n'); // TODO: proper hash
      fs.writeFileSync(path.join(HTPASSWD_DIR, `access_list_${list.id}`), htpasswdContent);
    }

    logger.info({ proxyHosts: proxyHosts.length, redirections: redirections.length, streams: streams.length }, 'Nginx configs regenerated');

    // Reload nginx container
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
      const exec = await container.exec({ Cmd: ['nginx', '-s', 'reload'], AttachStdout: true, AttachStderr: true });
      await exec.start({});
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

  /** Get paths for certificate files */
  getCertPaths(hostType: string, hostId: number) {
    return {
      cert: path.join(CERTS_DIR, `${hostType}_${hostId}.crt`),
      key: path.join(CERTS_DIR, `${hostType}_${hostId}.key`),
      chain: path.join(CERTS_DIR, `${hostType}_${hostId}.chain.crt`),
    };
  },

  /** Write certificate files */
  writeCertFiles(hostType: string, hostId: number, cert: string, key: string, chain?: string): void {
    ensureDirs();
    const paths = this.getCertPaths(hostType, hostId);
    fs.writeFileSync(paths.cert, cert);
    fs.writeFileSync(paths.key, key);
    if (chain) fs.writeFileSync(paths.chain, chain);
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
