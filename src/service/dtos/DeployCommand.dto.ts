import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

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
  deployPreset: string;
}