import { Module } from '@nestjs/common';
import { DockerService } from './docker.service';
import { ConfigModule } from '@nestjs/config';
import { DeployService } from './deploy.service';
import { BuildWorkspaceService } from './build-workspace.service';

@Module({
  imports: [ConfigModule],
  providers: [DockerService, DeployService, BuildWorkspaceService],
  exports: [DockerService],
})
export class DockerModule { }
