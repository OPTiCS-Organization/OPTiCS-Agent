import { Module } from '@nestjs/common';
import { DockerService } from './docker.service';
import { ConfigModule } from '@nestjs/config';
import { DeployService } from './deploy.service';
import { BuildWorkspaceService } from './build-workspace.service';
import { ContainerLifeCycleService } from './container-lifecycle.service';

@Module({
  imports: [ConfigModule],
  providers: [DockerService, DeployService, BuildWorkspaceService, ContainerLifeCycleService],
  exports: [DockerService, DeployService, BuildWorkspaceService, ContainerLifeCycleService],
})
export class DockerModule { }
