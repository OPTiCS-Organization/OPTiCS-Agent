export type LogStream = 'deploy' | 'lifecycle' | 'runtime';

export type DockerLogEntry = {
  line: string;
  timestamp?: string;
  source?: 'agent' | 'runtime';
  stream?: LogStream;
  containerName?: string;
  composeService?: string;
  stderr?: boolean;
};
