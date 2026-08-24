import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { db } from '../db';
import { dockerService } from './docker.service';
import { proxyHostService, redirectionService, streamService, deadHostService, accessListService, customPageService } from './proxy.service';
import type { ProxyHost, RedirectionHost, DeadHost, AccessList } from '@oblihub/shared';
import { logger } from '../utils/logger';

const PROXY_DIR = path.join(config.stacksDir, '_proxy');

// Default waking page — used when a proxy host has no waking_page_id and no custom default exists.
// Tokens: {{APP_NAME}}, {{PROXY_HOST_ID}}
const DEFAULT_WAKING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Waking up {{APP_NAME}}…</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0b0d1a; color: #e8ecf5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  .card { max-width: 480px; padding: 32px; text-align: center; }
  .spinner { width: 48px; height: 48px; margin: 0 auto 24px; border: 3px solid rgba(45,78,201,0.2); border-top-color: #2d4ec9; border-radius: 50%; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size: 20px; margin: 0 0 8px; font-weight: 600; }
  p { margin: 0; color: #8c93b6; font-size: 14px; line-height: 1.5; }
  .progress { margin: 18px auto 6px; width: 100%; height: 6px; background: rgba(45,78,201,0.15); border-radius: 3px; overflow: hidden; display: none; }
  .progress.visible { display: block; }
  .progress > .bar { height: 100%; width: 0; background: linear-gradient(90deg, #2d4ec9, #5a78e8); border-radius: 3px; transition: width 0.3s ease-out; }
  .progress.indeterminate > .bar { width: 100% !important; animation: shimmer 1.6s ease-in-out infinite; }
  @keyframes shimmer { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }
  .elapsed { margin-top: 8px; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 12px; color: #5a78e8; }
  .hint { margin-top: 10px; font-size: 12px; color: #ffb454; display: none; }
  .hint.visible { display: block; }
  .error { color: #e03a3a; margin-top: 16px; display: none; }
  .error.visible { display: block; }
</style>
</head>
<body>
<div class="card">
  <div class="spinner"></div>
  <h1>Waking up {{APP_NAME}}…</h1>
  <p>The application was idle and shut down to save resources. It's starting back up.</p>
  <div class="progress" id="progress"><div class="bar" id="bar"></div></div>
  <div class="elapsed"><span id="elapsed">0</span>s<span id="estimated"></span></div>
  <div class="hint" id="hint">It's taking longer than usual — please wait a bit more…</div>
  <div class="error" id="error">Wake failed — <a href="javascript:location.reload()" style="color:#5a78e8">retry</a></div>
</div>
<script>
(function(){
  var host = {{PROXY_HOST_ID}};
  var start = Date.now();
  var el = document.getElementById('elapsed');
  var est = document.getElementById('estimated');
  var bar = document.getElementById('bar');
  var progress = document.getElementById('progress');
  var hint = document.getElementById('hint');
  var err = document.getElementById('error');
  // null = unknown (first wake, no history). number = ms estimate from rolling avg.
  var estimatedMs = null;

  function tick(){
    var elapsedMs = Date.now() - start;
    el.textContent = Math.floor(elapsedMs / 1000);
    if (estimatedMs && estimatedMs > 0) {
      progress.classList.add('visible');
      progress.classList.remove('indeterminate');
      var pct = Math.min(100, (elapsedMs / estimatedMs) * 100);
      bar.style.width = pct + '%';
      // Once we overshoot the estimate, pin the bar at 100% and reveal the "longer than usual" hint.
      if (elapsedMs > estimatedMs) {
        hint.classList.add('visible');
      }
    } else if (estimatedMs === 0) {
      // No history yet — show an indeterminate shimmer so the page doesn't feel dead.
      progress.classList.add('visible');
      progress.classList.add('indeterminate');
    }
  }
  setInterval(tick, 250);

  function poll(){
    fetch('/__oblihub_internal/wake/status?host=' + host, { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d || !d.data) { setTimeout(poll, 1500); return; }
        // Refresh estimate on every poll — first-time visitors get it after the first response,
        // and a wake that produces a fresh sample mid-poll will refine it for subsequent ticks.
        if (typeof d.data.estimatedMs === 'number') {
          estimatedMs = d.data.estimatedMs;
          if (estimatedMs > 0) {
            est.textContent = ' / ~' + Math.round(estimatedMs / 1000) + 's expected';
          }
        } else if (d.data.estimatedMs === null) {
          estimatedMs = 0;
        }
        if (d.data.ready) {
          location.reload();
        } else if (d.data.state === 'wake_failed') {
          err.classList.add('visible');
        } else {
          setTimeout(poll, 1500);
        }
      })
      .catch(function(){ setTimeout(poll, 2000); });
  }
  // Kick off the wake then start polling
  fetch('/__oblihub_internal/wake?host=' + host, { method: 'POST', cache: 'no-store' })
    .finally(function(){ poll(); });
})();
</script>
</body>
</html>
`;

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
        proxy_pass $upstream;
        proxy_cache proxy_cache;
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

/**
 * Combined access list block for a proxy host. Takes every access list attached to the host
 * (via the junction table) and emits a single nginx block that's the UNION of their rules:
 *
 *   - Allow IPs: every `allow X` from any list is emitted. Duplicates deduped. If at least one
 *     `allow` exists across all lists, we append `deny all` to lock out everyone else (standard
 *     nginx allowlist pattern).
 *   - Deny IPs: emitted before allows (nginx evaluates in order, first-match-wins).
 *   - Basic auth: if any list has auth users, we point at a per-host combined htpasswd file
 *     (`htpasswd/proxy_host_<id>`) written by the regenerate flow. `auth_basic_user_file`
 *     supports only one path, so we cannot reference multiple list-level files.
 *   - satisfy: if ANY attached list has satisfyAny=true, the whole host inherits `satisfy any`
 *     (most permissive interpretation, matches the "stack multiple lists for flexibility" mental
 *     model). Otherwise `satisfy all`.
 */
function combinedAccessListBlock(hostId: number, lists: AccessList[]): string {
  if (lists.length === 0) return '';
  const allClients = lists.flatMap(l => l.clients.map(c => ({ ...c, listName: l.name })));
  const allAuth = lists.flatMap(l => l.auth);
  if (allClients.length === 0 && allAuth.length === 0) return '';

  let conf = `\n    # Access lists (union): ${lists.map(l => l.name).join(', ')}\n`;

  if (allClients.length > 0) {
    // Deny rules first so they're evaluated before any explicit allow further down.
    const seenAllow = new Set<string>();
    const seenDeny = new Set<string>();
    for (const c of allClients) {
      const addr = c.address.replace(/[;\n\r{}#'"\\]/g, '');
      if (c.directive === 'deny') {
        if (seenDeny.has(addr)) continue;
        seenDeny.add(addr);
        conf += `    deny ${addr};   # from "${c.listName}"\n`;
      }
    }
    for (const c of allClients) {
      const addr = c.address.replace(/[;\n\r{}#'"\\]/g, '');
      if (c.directive === 'allow') {
        if (seenAllow.has(addr)) continue;
        seenAllow.add(addr);
        conf += `    allow ${addr};   # from "${c.listName}"\n`;
      }
    }
    if (seenAllow.size > 0) conf += `    deny all;\n`;
  }

  if (allAuth.length > 0) {
    const anySatisfyAny = lists.some(l => l.satisfyAny);
    if (allClients.length > 0) {
      conf += `    satisfy ${anySatisfyAny ? 'any' : 'all'};\n`;
    }
    conf += `    auth_basic "Restricted";\n`;
    conf += `    auth_basic_user_file /etc/nginx/htpasswd/proxy_host_${hostId};\n`;
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

    # ACME challenge — must bypass server-level access list (IP allow/deny + auth_basic)
    # so Let's Encrypt's HTTP-01 validator can always reach the token regardless of what
    # the operator has gated the host with.
    location /.well-known/acme-challenge/ {
        alias /etc/nginx/acme-challenge/;
        allow all;
        auth_basic off;
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

  // ACME challenge (always serve) — `allow all` + `auth_basic off` are critical: without them
  // any attached access list (IP allowlist or basic auth) on the host would 403 the Let's
  // Encrypt validator and break renewals silently for the lifetime of the cert.
  conf += `    location /.well-known/acme-challenge/ {
        alias /etc/nginx/acme-challenge/;
        allow all;
        auth_basic off;
    }\n\n`;

  if (host.hstsEnabled && hasCert) {
    conf += hstsSnippet(host.hstsSubdomains) + '\n\n';
  }

  if (host.blockExploits) {
    conf += blockExploitsSnippet() + '\n\n';
  }

  // Collect every attached access list — prefer the new array, fall back to the legacy single id.
  const attachedIds = host.accessListIds && host.accessListIds.length > 0
    ? host.accessListIds
    : (host.accessListId ? [host.accessListId] : []);
  if (attachedIds.length > 0) {
    const attached = attachedIds
      .map(id => accessLists.find(al => al.id === id))
      .filter((al): al is AccessList => !!al);
    conf += combinedAccessListBlock(host.id, attached) + '\n\n';
  }

  // Azure AD forward-auth via oauth2-proxy sidecar. Emitted only when the proxy_host
  // references a provider — nginx delegates each request's auth check to the sidecar via
  // auth_request, and the /oauth2/ subpath is proxied through to the sidecar for the sign-in
  // + callback flow. Stacks on top of Access Lists (satisfy defaults handled by nginx).
  if (host.azureAuthProviderId) {
    const sidecar = `oblihub-azauth-${host.azureAuthProviderId}`;
    // CRITICAL: use `set $var` + `proxy_pass $var` (not the literal URL) so nginx resolves
    // the sidecar hostname AT RUNTIME via docker DNS, not once at boot. Without this, a sidecar
    // that got recreated (IP changed) leaves nginx tapping the stale cached IP forever — every
    // auth_request fails silently, error_page 500 kicks in, and the operator sees an Oblihub
    // error page that just LOOKS like the app is up. Been there.
    conf += `    # Azure AD forward-auth via oauth2-proxy sidecar (provider ${host.azureAuthProviderId})\n`;
    // NO resolver directive here — nginx.service already emits one at server level for the
    // main upstream. Duplicating it here makes nginx refuse `-s reload` with "directive is
    // duplicate", nginx keeps running the OLD config, and the operator sees mysterious 200s
    // from the upstream because the auth_request block never became active. The server-level
    // resolver is inherited into this scope, `$oblihub_fa_upstream` is resolved at runtime
    // with the same TTL/family settings.
    conf += `    set $oblihub_fa_upstream http://${sidecar}:4180;\n`;
    conf += `    auth_request /_oblihub_fa/auth;\n`;
    conf += `    auth_request_set $auth_user $upstream_http_x_auth_request_user;\n`;
    conf += `    auth_request_set $auth_email $upstream_http_x_auth_request_email;\n`;
    conf += `    auth_request_set $auth_groups $upstream_http_x_auth_request_groups;\n`;
    conf += `    proxy_set_header X-Auth-User $auth_user;\n`;
    conf += `    proxy_set_header X-Auth-Email $auth_email;\n`;
    conf += `    proxy_set_header X-Auth-Groups $auth_groups;\n`;
    conf += `    error_page 401 = @_oblihub_fa_signin;\n\n`;
    conf += `    location @_oblihub_fa_signin {\n`;
    conf += `        return 302 /oauth2/start?rd=$scheme://$http_host$request_uri;\n`;
    conf += `    }\n\n`;
    conf += `    location = /_oblihub_fa/auth {\n`;
    conf += `        internal;\n`;
    conf += `        proxy_pass $oblihub_fa_upstream/oauth2/auth;\n`;
    conf += `        proxy_pass_request_body off;\n`;
    conf += `        proxy_set_header Content-Length "";\n`;
    conf += `        proxy_set_header X-Original-URI $request_uri;\n`;
    conf += `        proxy_set_header X-Forwarded-Host $http_host;\n`;
    conf += `        proxy_set_header X-Forwarded-Proto $scheme;\n`;
    conf += `        proxy_set_header X-Forwarded-For $remote_addr;\n`;
    conf += `    }\n\n`;
    conf += `    location /oauth2/ {\n`;
    conf += `        proxy_pass $oblihub_fa_upstream;\n`;
    conf += `        proxy_set_header Host $http_host;\n`;
    conf += `        proxy_set_header X-Forwarded-Host $http_host;\n`;
    conf += `        proxy_set_header X-Forwarded-Proto $scheme;\n`;
    conf += `        proxy_set_header X-Forwarded-For $remote_addr;\n`;
    conf += `        proxy_set_header X-Real-IP $remote_addr;\n`;
    conf += `    }\n\n`;
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

  // Error pages — per-code custom pages with dynamic content.
  // When wakeContainerId is set, 502/503/504 are reserved for the waking page (declared
  // immediately below) and we skip them here so there's no overlap between the two
  // `error_page` directives for those codes.
  if (host.errorPageId) {
    const errorCodes = host.wakeContainerId
      ? [400, 401, 403, 404, 500]
      : [400, 401, 403, 404, 500, 502, 503, 504];
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

  // Sleep mode wake — intercept 502/503/504 (upstream down) with the waking page,
  // and proxy the polling endpoints to the Oblihub server via a private location.
  if (host.wakeContainerId) {
    conf += `    # Sleep/wake — container ${host.wakeContainerId}\n`;
    // error_page → URI (not a named location). nginx triggers an internal subrequest to that
    // URI, which is matched by the `location =` block below. We can't use a named location
    // here because nginx forbids `alias` inside them.
    conf += `    error_page 502 503 504 /__oblihub_waking_${host.id}.html;\n`;
    conf += `    location = /__oblihub_waking_${host.id}.html {\n`;
    conf += `        internal;\n`;
    conf += `        alias /etc/nginx/error_pages/waking_${host.id}.html;\n`;
    conf += `    }\n`;
    conf += `    location /__oblihub_internal/ {\n`;
    // Compose service name = "server" (overridable via OBLIHUB_SERVER_HOST env on the proxy generator side).
    conf += `        proxy_pass http://${process.env.OBLIHUB_SERVER_HOST || 'server'}:3001/__oblihub_internal/;\n`;
    conf += `        proxy_set_header X-Oblihub-Internal "${process.env.OBLIHUB_INTERNAL_TOKEN || 'oblihub-internal'}";\n`;
    conf += `        proxy_set_header Host $host;\n`;
    conf += `        proxy_http_version 1.1;\n`;
    conf += `    }\n`;
    // Activity log — one line per request, parsed by ActivityTracker. $proxy_host_id is set
    // via the http-level `map $host …` in nginx.conf, keyed on this host's domain names.
    conf += `    access_log /etc/nginx/sleep_activity.log sleep_activity;\n`;
    conf += '\n';
  }

  // Resolver for dynamic upstream DNS:
  //  - 127.0.0.11 is Docker's embedded resolver (resolves Docker service names)
  //  - 100.100.100.100 is Tailscale's MagicDNS (resolves *.ts.net Tailnet names).
  //    Only useful when the proxy container shares the tailscale netns
  //    (PROXY_NETWORK_MODE=service:tailscale). When that's not the case the line
  //    is harmless — nginx just tries both for any upstream lookup.
  conf += `    resolver 127.0.0.11${process.env.PROXY_TAILSCALE_DNS === 'true' ? ' 100.100.100.100' : ''} valid=10s ipv6=off;\n`;
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

  // When a wake target is set, intercept 5xx responses from the upstream too — not just
  // connection failures. nginx defaults to off, which means a 502/503/504 returned BY the
  // upstream (e.g. when there's a reverse proxy in front of the sleeping container that
  // reports the backend as down) gets passed through to the client transparently. With
  // proxy_intercept_errors on, those responses flow into our error_page → waking page.
  if (host.wakeContainerId) {
    conf += `        proxy_intercept_errors on;\n`;
  }

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

  // ACME challenge — MUST come before the redirect. Otherwise `location /` catches
  // /.well-known/acme-challenge/ first and emits a 301, breaking cert issuance/renewal for
  // any domain that has a Redirection entry alongside a proxy_host requesting LE.
  conf += `    location /.well-known/acme-challenge/ {\n        alias /etc/nginx/acme-challenge/;\n        allow all;\n        auth_basic off;\n    }\n\n`;

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
  // Same rationale as Redirection: serve ACME even on a dead host so its domain can still
  // be certified (useful when a domain is temporarily parked but must keep a valid cert).
  conf += `    location /.well-known/acme-challenge/ {\n        alias /etc/nginx/acme-challenge/;\n        allow all;\n        auth_basic off;\n    }\n`;
  conf += `    location / { return 404; }\n`;
  conf += `}\n`;

  return conf;
}

// ── Main nginx.conf ──

function generateMainConfig(
  rateLimitedHosts: { id: number; rps: number }[] = [],
  wakeHostMap: { hostId: number; domains: string[] }[] = [],
): string {
  const rateLimitZones = rateLimitedHosts.map(h => `    limit_req_zone $binary_remote_addr zone=rl_${h.id}:10m rate=${h.rps}r/s;`).join('\n');

  // Static map from request Host header → proxy_host_id. Built from all wake-enabled hosts so
  // that the `sleep_activity` log_format can reference $proxy_host_id at the http context (where
  // log_format is declared) without depending on a server-level `set` directive. nginx's
  // log_format is parsed BEFORE any server block runs, which is why a `set $proxy_host_id …`
  // inside a server block doesn't satisfy the parser — the variable must be declared at http
  // level too. Using `map` here covers both needs in one place.
  const wakeMapEntries = wakeHostMap.flatMap(h =>
    h.domains.map(d => `        "${sanitizeForNginx(d)}" "${h.hostId}";`)
  ).join('\n');
  const wakeMapBlock = wakeMapEntries
    ? `    map $host $proxy_host_id {\n        default "0";\n${wakeMapEntries}\n    }`
    : `    map $host $proxy_host_id { default "0"; }`;

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

    # Sleep activity log — pipe-separated, parsed by Oblihub's ActivityTracker.
    # $proxy_host_id is mapped from the request Host header for wake-enabled hosts; defaults
    # to "0" for everything else.
${wakeMapBlock}
    log_format sleep_activity '$proxy_host_id|$msec|$status|$http_user_agent|$request_uri';

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
            allow all;
            auth_basic off;
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
    // Wake-enabled hosts feed the http-level $proxy_host_id map used by sleep_activity log_format.
    const wakeHostMap = enabledHosts
      .filter(h => h.wakeContainerId)
      .map(h => ({ hostId: h.id, domains: h.domainNames || [] }));

    // Write main config (with rate limit zones + wake host map)
    fs.writeFileSync(path.join(PROXY_DIR, 'nginx.conf'), generateMainConfig(rateLimitedHosts, wakeHostMap));

    // Write custom error pages to disk (one file per error code with dynamic replacement).
    // Always write files for ALL 8 codes referenced in generateProxyHostConfig — codes that
    // aren't in the page's declared errorCodes still get a rendered file (with the correct
    // code label) so nginx's error_page directive never points to a missing file.
    const ERROR_MESSAGES: Record<number, string> = {
      400: 'Bad Request', 401: 'Unauthorized', 403: 'Access Denied', 404: 'Page Not Found',
      500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
    };
    const ALL_ERROR_CODES = [400, 401, 403, 404, 500, 502, 503, 504];
    const customPages = await customPageService.getAll();
    for (const page of customPages) {
      for (const code of ALL_ERROR_CODES) {
        const message = ERROR_MESSAGES[code] || `Error ${code}`;
        const html = page.htmlContent
          .replace(/\{\{CODE\}\}/g, String(code))
          .replace(/\{\{MESSAGE\}\}/g, message);
        fs.writeFileSync(path.join(ERROR_PAGES_DIR, `page_${page.id}_${code}.html`), html);
      }
      // Generic fallback (no specific code)
      const fallbackHtml = page.htmlContent
        .replace(/\{\{CODE\}\}/g, 'Error')
        .replace(/\{\{MESSAGE\}\}/g, 'Something went wrong');
      fs.writeFileSync(path.join(ERROR_PAGES_DIR, `page_${page.id}.html`), fallbackHtml);
    }

    // Clear old waking HTML files (regenerated below per-host)
    for (const f of fs.readdirSync(ERROR_PAGES_DIR).filter(f => f.startsWith('waking_'))) {
      fs.unlinkSync(path.join(ERROR_PAGES_DIR, f));
    }

    // Clear old configs
    for (const f of fs.readdirSync(CONF_DIR)) fs.unlinkSync(path.join(CONF_DIR, f));
    for (const f of fs.readdirSync(STREAM_DIR)) fs.unlinkSync(path.join(STREAM_DIR, f));

    // Generate proxy host configs (named by primary domain)
    // Load access lists for config generation
    const allAccessLists = await accessListService.getAll();

    // Waking page templates available to proxy hosts
    const wakingPages = customPages.filter(p => p.isWakingPage);
    const defaultWakingHtml = wakingPages[0]?.htmlContent || DEFAULT_WAKING_HTML;

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
        // Render waking page for this host if sleep mode is enabled
        if (host.wakeContainerId) {
          const tplPage = host.wakingPageId ? wakingPages.find(p => p.id === host.wakingPageId) : null;
          const tpl = tplPage?.htmlContent || defaultWakingHtml;
          const rendered = tpl
            .replace(/\{\{PROXY_HOST_ID\}\}/g, String(host.id))
            .replace(/\{\{APP_NAME\}\}/g, sanitizeForNginx(host.domainNames[0] || `app-${host.id}`));
          fs.writeFileSync(path.join(ERROR_PAGES_DIR, `waking_${host.id}.html`), rendered);
        }
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

    // Per-proxy_host combined htpasswd: nginx's `auth_basic_user_file` only accepts one path,
    // so when a host stacks multiple access lists with auth users we have to write a single
    // file that's the union. Dedupe by username (last-wins — same as nginx's first-match).
    for (const host of allProxyHosts) {
      const attachedIds = host.accessListIds && host.accessListIds.length > 0
        ? host.accessListIds
        : (host.accessListId ? [host.accessListId] : []);
      const path_ = path.join(HTPASSWD_DIR, `proxy_host_${host.id}`);
      if (attachedIds.length === 0) {
        try { fs.unlinkSync(path_); } catch { /* not there, fine */ }
        continue;
      }
      const byUser = new Map<string, string>();
      for (const id of attachedIds) {
        const rows = await db('access_list_auth').where({ access_list_id: id });
        for (const r of rows) byUser.set(r.username as string, r.password_hash as string);
      }
      const merged = [...byUser.entries()].map(([u, h]) => `${u}:${h}`).join('\n');
      fs.writeFileSync(path_, merged);
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
