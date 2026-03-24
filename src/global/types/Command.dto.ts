import { COMMAND } from "../Command.enum"
import { DEPLOY_OPTION } from "../DeployOptionEnum";

export class Command {
  command: COMMAND;
  targetService: string;
  deployPreset: DEPLOY_OPTION;

  serviceIndex: number;
  sourceUrl: string;
  serviceName: string;
  servicePort: number;
  serviceVersion: string;

  env: Record<string, string>;
}