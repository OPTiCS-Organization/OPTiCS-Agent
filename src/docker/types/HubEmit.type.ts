import { LogStream } from "./DockerLogEntry.type";
import { ServiceStatus } from "./ServiceStatus.type";

export type ServiceLogPayload = {
  serviceIndex: number;
  log: string;
  timestamp: string;
  source: 'agent';
  stream: LogStream;
  containerName: string;
  stderr?: boolean;
};

export type ServiceStatusPayload = {
  serviceIndex: number;
  status: ServiceStatus;
};

export type HubEmit = {
  (event: 'service-log', payload: ServiceLogPayload): void;
  (event: 'service-status', payload: ServiceStatusPayload): void;
  (event: 'service-log-markers', payload: object): void;
  (event: 'container-status', payload: object): void;
};
