// ── User types ──
export type UserRole = 'admin' | 'user';

export type AppTheme = 'obli-operator' | 'obli-daylight' | 'modern' | 'neon';

export interface UserPreferences {
  preferredTheme?: AppTheme;
}

export interface User {
  id: number;
  username: string;
  displayName: string | null;
  role: UserRole;
  isActive: boolean;
  email: string | null;
  preferredLanguage: string;
  foreignSource: string | null;
  foreignId: number | null;
  avatar: string | null;
  preferences: UserPreferences;
  createdAt: string;
  updatedAt: string;
}

// ── Docker engines (multi-host) ──
export type DockerEngineType = 'local' | 'ssh' | 'https-apikey' | 'tls';

export interface DockerEngine {
  id: number;
  name: string;
  type: DockerEngineType;
  host: string | null;
  port: number | null;
  // Auth fields — secret values are NEVER returned by the API; only the presence flag is.
  sshUser: string | null;
  hasSshPrivateKey: boolean;
  sshKnownHost: string | null;
  hasApiKey: boolean;
  apiKeyHeader: string | null;
  tlsCa: string | null;
  tlsCert: string | null;
  hasTlsKey: boolean;
  isDefault: boolean;
  enabled: boolean;
  // Tailscale identity (optional). When set, proxy hosts targeting containers on this engine
  // resolve their upstream via this hostname instead of the public `host` field.
  tailscaleHostname: string | null;
  // CIDR list this engine's Tailscale node advertises (typically Docker bridge subnets).
  // When non-empty, the proxy can hit container bridge IPs directly — no published port needed.
  tailscaleAdvertisedRoutes: string | null;
  lastPingAt: string | null;
  lastPingStatus: 'ok' | 'error' | null;
  lastPingMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Tailscale ──
export interface TailscalePeer {
  id: string;            // stable Tailscale node ID
  hostname: string;      // short name (e.g. "unraid")
  dnsName: string;       // MagicDNS name (e.g. "unraid.tail-abcd12.ts.net.")
  ipv4: string | null;   // 100.x.y.z address
  online: boolean;
  os: string | null;
  advertisedRoutes: string[];
  primaryRoutes: string[]; // routes this peer is actively serving as subnet router
}

export interface TailscaleStatus {
  enabled: boolean;        // is the local tailscaled reachable
  selfHostname: string | null;
  selfDnsName: string | null;
  selfIpv4: string | null;
  tailnet: string | null;  // e.g. "tail-abcd12.ts.net"
  peers: TailscalePeer[];
  message?: string;        // populated when enabled=false to explain why
}

// ── Stack types ──
export type ContainerStatus = 'up_to_date' | 'update_available' | 'updating' | 'error' | 'unknown' | 'checking' | 'excluded' | 'stopped';

export type SleepMode = 'stop' | 'pause';
export type SleepState = 'awake' | 'sleeping' | 'waking' | 'wake_failed';

export interface Stack {
  id: number;
  name: string;
  composeProject: string | null;
  engineId: number | null;
  checkInterval: number;
  autoUpdate: boolean;
  enabled: boolean;
  url: string | null;
  notifyUpdateAvailable: boolean | null;
  notifyUpdateApplied: boolean | null;
  notifyDelay: number | null;
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
  containers: Container[];
  createdAt: string;
  updatedAt: string;
}

export interface ContainerPort {
  hostPort: number | null;
  containerPort: number;
  protocol: string;
  hostIp?: string | null;
}

export interface Container {
  id: number;
  stackId: number | null;
  engineId: number | null;
  dockerId: string;
  containerName: string;
  image: string;
  imageTag: string;
  currentDigest: string | null;
  latestDigest: string | null;
  status: ContainerStatus;
  errorMessage: string | null;
  excluded: boolean;
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
  ports: ContainerPort[];
  // Sleep mode (per-container opt-in)
  sleepEnabled: boolean;
  sleepAfterSeconds: number;
  sleepMode: SleepMode;
  sleepState: SleepState;
  lastActiveAt: string | null;
  wakeStartedAt: string | null;
  wakeHealthPath: string | null;
  // Rolling history of the last 10 successful wake durations in milliseconds. The waking page
  // uses the average to render its progress bar; if a new wake exceeds the average it falls
  // back to "still working…" messaging instead of overshooting 100%.
  wakeDurationsMs: number[];
  createdAt: string;
  updatedAt: string;
}

export type UpdateStatus = 'pending' | 'pulling' | 'recreating' | 'success' | 'failed' | 'rolled_back';

export interface UpdateHistoryEntry {
  id: number;
  stackId: number | null;
  containerId: number | null;
  containerName: string;
  image: string;
  oldDigest: string | null;
  newDigest: string | null;
  status: UpdateStatus;
  errorMessage: string | null;
  triggeredBy: 'auto' | 'manual';
  startedAt: string;
  completedAt: string | null;
}

// ── Notification types ──
export type NotificationPluginType = 'telegram' | 'discord' | 'slack' | 'teams' | 'smtp' | 'webhook' | 'gotify' | 'ntfy' | 'pushover' | 'freemobile';

export interface NotificationChannel {
  id: number;
  name: string;
  type: NotificationPluginType;
  config: Record<string, unknown>;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type NotificationScope = 'global' | 'stack';
export type OverrideMode = 'merge' | 'replace' | 'exclude';

export interface NotificationBinding {
  id: number;
  channelId: number;
  scope: NotificationScope;
  scopeId: number | null;
  overrideMode: OverrideMode;
}

// ── Managed stack types ──
export type ManagedStackStatus = 'draft' | 'deploying' | 'deployed' | 'stopped' | 'error';

/** Where the source files for this stack come from.
 *   compose-only: legacy — just the docker-compose.yml + .env pasted/typed in the editor.
 *   zip:          tarball uploaded by the user; build can run from local Dockerfile contexts.
 *   git:          cloned from a remote repo; refreshable via `git pull` from the UI.
 */
export type ManagedStackSourceType = 'compose-only' | 'zip' | 'git';

/**
 * Per-stack credentials for a container registry. The API never returns the password / token in
 * cleartext — only the `hasPassword` flag so the UI can render "(set)" / "(empty)" without
 * shipping the secret to the browser. To set/rotate, send a non-empty `password` on update.
 */
export interface RegistryCredential {
  registry: string;          // e.g. "gitea.example.com" or "ghcr.io"
  username: string;
  hasPassword: boolean;
}

export interface ManagedStack {
  id: number;
  name: string;
  composeContent: string;
  envContent: string | null;
  status: ManagedStackStatus;
  composeProject: string;
  engineId: number | null;
  errorMessage: string | null;
  // Source pipeline — populated for stacks built from uploaded files or a git repo. Defaults
  // to 'compose-only' for stacks created via the legacy paste-compose-and-deploy flow.
  sourceType: ManagedStackSourceType;
  gitUrl: string | null;
  gitBranch: string | null;
  gitRef: string | null;
  lastSourceSyncAt: string | null;
  // Git deploy-token auth (Gitea / GitHub / GitLab). Injected at clone/pull time via URL
  // rewrite `https://<user>:<token>@host/...`. Only `hasGitToken` is returned by the API
  // (mirrors the SSH key + registry cred pattern) — the actual token is AES-GCM at rest.
  gitUsername: string | null;
  hasGitToken: boolean;
  // Path to the compose file INSIDE the repo/upload — e.g. `stack/docker-compose.yml`. When
  // set, both the source sync and the compose invocation use it, with the compose parent dir
  // becoming the working dir so relative build.context paths (`./api`) resolve correctly.
  composePath: string | null;
  // When true, deploy/redeploy run `docker compose up -d --build` so Dockerfiles in the source
  // are rebuilt. Off by default — pure-image stacks keep their fast pull-only redeploy.
  buildEnabled: boolean;
  // Poll the git remote every N seconds; if the branch HEAD moved, trigger pull + rebuild.
  // 0 = disabled (operator triggers manually). Uses the same worker pattern as registry checks.
  pollGitIntervalS: number;
  lastGitPollAt: string | null;
  // Per-stack registry auth. Used at deploy time to populate a temp DOCKER_CONFIG so the
  // `docker compose pull` running in this stack's directory can authenticate against private
  // registries (Gitea, GHCR, GitLab, Quay, Harbor, …) without touching the host-level
  // ~/.docker/config.json. Passwords are stored AES-256-GCM encrypted server-side.
  registryCredentials: RegistryCredential[];
  createdAt: string;
  updatedAt: string;
}

/** Rollback timeline — one entry per successful deploy for a managed stack. */
export interface ManagedStackDeployHistoryEntry {
  id: number;
  managedStackId: number;
  sourceType: ManagedStackSourceType;
  gitUrl: string | null;
  gitBranch: string | null;
  gitRef: string | null;
  composePath: string | null;
  buildEnabled: boolean;
  success: boolean;
  notes: string | null;
  deployedAt: string;
  deployedByUserId: number | null;
}

// ── Docker resource types ──
export interface DockerImage {
  id: string;
  repoTags: string[];
  repoDigests: string[];
  size: number;
  created: number;
  containers: number;
}

export interface DockerNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  attachable: boolean;
  ipam: { subnet?: string; gateway?: string }[];
  containers: { id: string; name: string; ipv4: string; ipv6: string }[];
  labels: Record<string, string>;
  composeProject: string | null;
  created: string;
}

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
  labels: Record<string, string>;
  composeProject: string | null;
  created: string;
  usageSize: number | null;
}

// ── Proxy types ──
export type CertificateProvider = 'letsencrypt' | 'custom' | 'selfsigned';
export type CertificateStatus = 'pending' | 'valid' | 'expired' | 'error';

export interface CertificateLogEntry {
  at: string;          // ISO timestamp
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface Certificate {
  id: number;
  domainNames: string[];
  provider: CertificateProvider;
  expiresAt: string | null;
  status: CertificateStatus;
  errorMessage: string | null;
  acmeEmail: string | null;
  // Live log appended during each LE request — lets the UI show the full play-by-play of
  // account creation / challenge / finalize so the operator can self-diagnose failures
  // (DNS not propagated, port 80 unreachable, rate limit, …).
  requestLog: CertificateLogEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface ProxyHost {
  id: number;
  domainNames: string[];
  forwardScheme: 'http' | 'https';
  forwardHost: string;
  forwardPort: number;
  certificateId: number | null;
  sslForced: boolean;
  http2Support: boolean;
  hstsEnabled: boolean;
  hstsSubdomains: boolean;
  blockExploits: boolean;
  cachingEnabled: boolean;
  websocketSupport: boolean;
  accessListId: number | null;
  advancedConfig: string | null;
  enabled: boolean;
  stackId: number | null;
  clientMaxBodySize: string | null;
  proxyConnectTimeout: number | null;
  proxySendTimeout: number | null;
  proxyReadTimeout: number | null;
  proxyBuffering: boolean | null;
  rateLimitRps: number | null;
  rateLimitBurst: number | null;
  gzipEnabled: boolean;
  corsEnabled: boolean;
  customResponseHeaders: { name: string; value: string; action: 'add' | 'remove' }[] | null;
  errorPageId: number | null;
  // List of all access lists attached to this host. The proxy enforces the UNION of their
  // allow rules and auth entries — i.e. a visitor is granted if their IP matches ANY list, or
  // if their basic-auth credentials live in ANY list's htpasswd.
  // `accessListId` (singular) is kept for backward compat with older API consumers; it shadows
  // the first id of `accessListIds`. New code should prefer the array.
  accessListIds: number[];
  wakeContainerId: number | null;
  // Additional containers to wake in parallel when this proxy_host receives a request while
  // the primary target is asleep. Useful for multi-container apps (front + back) where the
  // proxy fronts only the UI but the UI's backend services must also be running.
  wakeExtraContainerIds: number[];
  wakingPageId: number | null;
  autoMonitor: boolean;
  // Docker network the target service should be attached to for the reverse-proxy to reach it.
  // Null = Oblihub's own built-in `proxy` network (backward-compat default). Set to e.g.
  // `nginx-proxy-manager_default` or `traefik_default` to have Oblihub's auto-override wire
  // the container onto an EXTERNAL reverse proxy's network instead.
  dockerNetwork: string | null;
  certificate?: Certificate | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomPage {
  id: number;
  name: string;
  description: string | null;
  errorCodes: number[];
  htmlContent: string;
  theme: string;
  isBuiltin: boolean;
  isWakingPage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RedirectionHost {
  id: number;
  domainNames: string[];
  forwardScheme: 'http' | 'https';
  forwardDomain: string;
  forwardPath: string;
  preservePath: boolean;
  certificateId: number | null;
  sslForced: boolean;
  http2Support: boolean;
  hstsEnabled: boolean;
  blockExploits: boolean;
  advancedConfig: string | null;
  enabled: boolean;
  certificate?: Certificate | null;
  createdAt: string;
  updatedAt: string;
}

export interface StreamHost {
  id: number;
  incomingPort: number;
  forwardingHost: string;
  forwardingPort: number;
  tcpForwarding: boolean;
  udpForwarding: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeadHost {
  id: number;
  domainNames: string[];
  certificateId: number | null;
  sslForced: boolean;
  http2Support: boolean;
  hstsEnabled: boolean;
  advancedConfig: string | null;
  enabled: boolean;
  certificate?: Certificate | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccessList {
  id: number;
  name: string;
  satisfyAny: boolean;
  passAuth: boolean;
  clients: AccessListClient[];
  auth: AccessListAuth[];
  createdAt: string;
  updatedAt: string;
}

export interface AccessListClient {
  id: number;
  address: string;
  directive: 'allow' | 'deny';
}

export interface AccessListAuth {
  id: number;
  username: string;
}

// ── Container stats types ──
export interface ContainerStats {
  dockerId: string;
  containerName: string;
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRx: number;
  networkTx: number;
  timestamp: string;
}

export interface ResourceAlert {
  id: number;
  name: string;
  metric: 'cpu' | 'memory';
  threshold: number;
  operator: 'gt' | 'lt';
  stackId: number | null;
  enabled: boolean;
  cooldownMinutes: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Uptime monitoring types ──
export interface UptimeMonitor {
  id: number;
  name: string;
  url: string;
  type: 'http' | 'tcp' | 'keyword';
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: number;
  keyword: string | null;
  proxyHostId: number | null;
  enabled: boolean;
  currentStatus: 'up' | 'down' | 'pending';
  consecutiveFailures: number;
  uptimePercent?: number;
  avgResponseTime?: number;
  createdAt: string;
  updatedAt: string;
}

export interface UptimeHeartbeat {
  id: number;
  monitorId: number;
  status: 'up' | 'down';
  responseTimeMs: number | null;
  statusCode: number | null;
  message: string | null;
  timestamp: string;
}

export interface StatusPage {
  id: number;
  name: string;
  slug: string;
  isPublic: boolean;
  customCss: string | null;
  monitorIds: number[];
  createdAt: string;
  updatedAt: string;
}

// ── App template types ──
export interface AppTemplate {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  category: string;
  composeTemplate: string;
  envSchema: EnvSchemaField[];
  defaultProxyPort: number | null;
  documentationUrl: string | null;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EnvSchemaField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'select';
  required: boolean;
  default: string;
  description: string;
  options?: string[];
}

// ── Team types ──
export interface Team {
  id: number;
  name: string;
  description: string | null;
  allResources: boolean;
  maxStacks: number | null;
  maxContainers: number | null;
  maxCertificates: number | null;
  maxProxyHosts: number | null;
  members: TeamMember[];
  resources: TeamResource[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamMember {
  id: number;
  userId: number;
  username: string;
  displayName: string | null;
}

export interface TeamResource {
  id: number;
  resourceType: 'stack' | 'container';
  resourceId: number;
  resourceName: string;
  excluded: boolean;
}

// ── API response wrapper ──
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
