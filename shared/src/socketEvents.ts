export const SOCKET_EVENTS = {
  STACKS_UPDATED: 'stacks:updated',
  STACK_STATUS_CHANGED: 'stack:status_changed',
  CONTAINER_STATUS_CHANGED: 'container:status_changed',
  UPDATE_PROGRESS: 'update:progress',
  UPDATE_COMPLETE: 'update:complete',
  DISCOVERY_COMPLETE: 'discovery:complete',
} as const;
