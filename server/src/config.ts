function isTruthy(val: string | undefined): boolean {
  if (!val) return false;
  return ['true', '1', 'yes'].includes(val.toLowerCase().trim());
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgres://oblihub:changeme@localhost:5432/oblihub',
  sessionSecret: process.env.SESSION_SECRET || 'change-this',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV || 'development',
  defaultAdminUsername: process.env.DEFAULT_ADMIN_USERNAME || 'admin',
  defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD || 'admin123',
  dockerSocket: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  discoveryIntervalMs: parseInt(process.env.DISCOVERY_INTERVAL || '30000', 10),
  defaultCheckIntervalSeconds: parseInt(process.env.DEFAULT_CHECK_INTERVAL || '60', 10),
  appName: process.env.APP_NAME || 'Oblihub',
  allowConsole: isTruthy(process.env.ALLOW_CONSOLE),
  allowStack: isTruthy(process.env.ALLOW_STACK),
  allowNginx: isTruthy(process.env.ALLOW_NGINX),
  stacksDir: process.env.STACKS_DIR || '/data/stacks',
  // Docker Hub credentials for authenticated registry access (raises the pull/manifest rate
  // limit from 100/6h anonymous to 200/6h free, or unlimited on Pro/Team). Use an access token
  // (https://hub.docker.com/settings/security) — NOT your account password.
  dockerHubUsername: process.env.DOCKERHUB_USERNAME || '',
  dockerHubToken: process.env.DOCKERHUB_TOKEN || '',
};
