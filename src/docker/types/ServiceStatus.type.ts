export const ServiceStatus = {
  STOPPED: 'stopped',
  BUILDING: 'building',
  STARTING: 'starting',
  RUNNING: 'running',
  RESTARTING: 'restarting',
  FAILED: 'failed',
  // Hub의 normalizeComponentStatus가 허용하는 값은 'removed'다.
  // 'deleted'를 보내면 Hub에서 'stopped'로 폴백되어 삭제가 중지로 표시된다.
  REMOVED: 'removed',
} as const;

export type ServiceStatus = typeof ServiceStatus[keyof typeof ServiceStatus];
