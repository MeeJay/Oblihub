// ── User types ──
export type UserRole = 'admin' | 'user';

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
  createdAt: string;
  updatedAt: string;
}

// ── Stack types ──
export type ContainerStatus = 'up_to_date' | 'update_available' | 'updating' | 'error' | 'unknown' | 'checking' | 'excluded' | 'stopped';

export interface Stack {
  id: number;
  name: string;
  composeProject: string | null;
  checkInterval: number;
  autoUpdate: boolean;
  enabled: boolean;
  url: string | null;
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
  containers: Container[];
  createdAt: string;
  updatedAt: string;
}

export interface Container {
  id: number;
  stackId: number | null;
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

export interface ManagedStack {
  id: number;
  name: string;
  composeContent: string;
  envContent: string | null;
  status: ManagedStackStatus;
  composeProject: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
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

export interface Certificate {
  id: number;
  domainNames: string[];
  provider: CertificateProvider;
  expiresAt: string | null;
  status: CertificateStatus;
  errorMessage: string | null;
  acmeEmail: string | null;
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
  certificate?: Certificate | null;
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

// ── API response wrapper ──
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
