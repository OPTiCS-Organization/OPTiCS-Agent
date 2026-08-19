export type DockerLogProgress = {
  loaded: number;
  total: number;
  percent: number;
  phase: 'loading' | 'streaming' | 'complete';
};
