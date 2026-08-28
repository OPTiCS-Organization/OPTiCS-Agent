export interface Agent {
  code: string;
  uuid: string;
  parentWorkspace: number;
  protocolVersion: number;
  signingSecret: string | null;
  ip: string;
}
