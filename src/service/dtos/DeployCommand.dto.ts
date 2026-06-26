import { IsArray, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { DEPLOY_OPTION } from 'src/global/DeployOptionEnum';

export class ServicePortMapping {
  @IsNumber()
  hostPort: number;

  @IsNumber()
  containerPort: number;
}

export class SourceRepository {
  @IsString()
  url: string;

  @IsOptional()
  @IsString()
  rootDirectory?: string | null;
}

export class DeployCommand {
  @IsNumber()
  @IsNotEmpty()
  serviceIndex: number;

  @IsNotEmpty()
  sourceUrl: string | string[] | SourceRepository[];

  @IsOptional()
  @IsString()
  rootDirectory?: string | null;

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

  @IsOptional()
  @IsNumber()
  serviceHostPort?: number;

  @IsOptional()
  @IsNumber()
  serviceContainerPort?: number;

  @IsOptional()
  @IsArray()
  servicePortMappings?: ServicePortMapping[];

  @IsNotEmpty()
  @IsEnum(DEPLOY_OPTION)
  deployPreset: DEPLOY_OPTION;

  @IsOptional()
  env?: Record<string, string>;
}
