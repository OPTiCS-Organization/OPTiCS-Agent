export const ServiceStatus = {
  STOPPED: 'stopped',
  BUILDING: 'building',
  STARTING: 'starting',
  RUNNING: 'running',
  RESTARTING: 'restarting',
  FAILED: 'failed',
  DELETED: 'deleted',
} as const;

export type ServiceStatus = typeof ServiceStatus[keyof typeof ServiceStatus];
