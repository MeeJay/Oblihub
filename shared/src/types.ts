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
export type ContainerStatus = 'up_to_date' | 'update_available' | 'updating' | 'error' | 'unknown' | 'checking' | 'excluded';

export interface Stack {
  id: number;
  name: string;
  composeProject: string | null;
  checkInterval: number;
  autoUpdate: boolean;
  enabled: boolean;
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

// ── API response wrapper ──
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
