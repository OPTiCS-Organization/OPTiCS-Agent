import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { DeployOption } from '../enums/PresetMode.enum';

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
  @IsEnum(DeployOption)
  deployPreset: DeployOption;

  @IsOptional()
  env?: Record<string, string>;
}