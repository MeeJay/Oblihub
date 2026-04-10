export const SOCKET_EVENTS = {
  STACKS_UPDATED: 'stacks:updated',
  STACK_STATUS_CHANGED: 'stack:status_changed',
  CONTAINER_STATUS_CHANGED: 'container:status_changed',
  UPDATE_PROGRESS: 'update:progress',
  UPDATE_COMPLETE: 'update:complete',
  DISCOVERY_COMPLETE: 'discovery:complete',

  // Container logs
  CONTAINER_LOGS_SUBSCRIBE: 'container:logs:subscribe',
  CONTAINER_LOGS_UNSUBSCRIBE: 'container:logs:unsubscribe',
  CONTAINER_LOGS_DATA: 'container:logs:data',
  CONTAINER_LOGS_ERROR: 'container:logs:error',

  // Container exec (console)
  CONTAINER_EXEC_START: 'container:exec:start',
  CONTAINER_EXEC_INPUT: 'container:exec:input',
  CONTAINER_EXEC_OUTPUT: 'container:exec:output',
  CONTAINER_EXEC_RESIZE: 'container:exec:resize',
  CONTAINER_EXEC_STOP: 'container:exec:stop',
  CONTAINER_EXEC_ERROR: 'container:exec:error',

  // Container stats
  CONTAINER_STATS_UPDATE: 'container:stats:update',
} as const;
