export type DockerStatusEvent = {
  status: string;
  containerName: string;
  timestamp: string;
  action: string;
  exitCode?: string;
};

export type StatusEmit = (event: DockerStatusEvent) => void | Promise<void>;
