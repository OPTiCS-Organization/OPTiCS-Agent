import { COMMAND } from "../Command.enum"
import { DEPLOY_OPTION } from "../DeployOptionEnum";

export type ServicePortMapping = {
  hostPort: number;
  containerPort: number;
};
export type SourceRepository = {
  url: string;
  rootDirectory?: string | null;
};

export class Command {
  command: COMMAND;
  targetService: string;
  deployPreset: DEPLOY_OPTION;

  serviceIndex: number;
  sourceUrl: string | string[] | SourceRepository[];
  rootDirectory?: string | null;
  serviceName: string;
  servicePort: number;
  serviceHostPort?: number;
  serviceContainerPort?: number;
  servicePortMappings?: ServicePortMapping[];
  containerName?: string;
  before?: string;
  limit?: number;
  deleteScope?: 'containers' | 'service';
  serviceVersion: string;

  env: Record<string, string>;
}
