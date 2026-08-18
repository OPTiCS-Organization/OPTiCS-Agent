import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DeployService } from './deploy.service';
import { BuildWorkspaceService } from './build-workspace.service';
import { ContainerLifeCycleService } from './container-lifecycle.service';
import { ContainerInspectService } from './container-inspect.service';
import { DockerLogService } from './docker-log.service';
import { DockerEventService } from './docker-event.service';

@Module({
  imports: [ConfigModule],
  providers: [
    DeployService,
    BuildWorkspaceService,
    ContainerLifeCycleService,
    ContainerInspectService,
    DockerLogService,
    DockerEventService,
  ],
  exports: [
    DeployService,
    BuildWorkspaceService,
    ContainerLifeCycleService,
    ContainerInspectService,
    DockerLogService,
    DockerEventService,
  ],
})
export class DockerModule { }
