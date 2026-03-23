import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { DEPLOY_OPTION } from 'src/global/DeployOptionEnum';

export class DeployCommand {
  @IsString()
  @IsNotEmpty()
  sourceUrl: string;

  @IsOptional()
  @IsString()
  apiKey: string;

  @IsNotEmpty()
  @IsString()
  serviceName: string;

  @IsNotEmpty()
  @IsString()
  serviceVersion: string;

  @IsNotEmpty()
  @IsNumber()
  servicePort: number;

  @IsNotEmpty()
  @IsEnum(DEPLOY_OPTION)
  deployPreset: DEPLOY_OPTION;

  @IsOptional()
  env?: Record<string, string>;
}