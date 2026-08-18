export type ContainerStatus = 'building' | 'starting' | 'running' | 'stopped' | 'failed' | 'removed';

export type ContainerState = {
  name: string;
  status: ContainerStatus;
  service?: string;
  exitCode?: number | null;
  health?: string | null;
};
