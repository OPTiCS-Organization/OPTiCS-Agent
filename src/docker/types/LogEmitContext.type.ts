import { LogStream } from "./DockerLogEntry.type";

export type LogEmitContext = {
  serviceIndex: number;
  containerName: string;
  stream: LogStream;
}
