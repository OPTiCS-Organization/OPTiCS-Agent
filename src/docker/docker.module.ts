import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DeployService } from './deploy.service';
import { BuildWorkspaceService } from './build-workspace.service';
import { ContainerLifeCycleService } from './container-lifecycle.service';
import { ContainerInspectService } from './container-inspect.service';
import { DockerLogService } from './docker-log.service';
import { DockerEventService } from './docker-event.service';
import { ComposeProjectService } from './compose-project.service';
import { ImageBuildService } from './image-build.service';
import { DockerCli } from './docker-cli.service';
import { SelfInspectService } from './self-inspect.service';

@Module({
  imports: [ConfigModule],
  providers: [
    DockerCli,
    SelfInspectService,
    DeployService,
    BuildWorkspaceService,
    ContainerLifeCycleService,
    ContainerInspectService,
    DockerLogService,
    DockerEventService,
    ComposeProjectService,
    ImageBuildService,
  ],
  exports: [
    DockerCli,
    SelfInspectService,
    DeployService,
    BuildWorkspaceService,
    ContainerLifeCycleService,
    ContainerInspectService,
    DockerLogService,
    DockerEventService,
    ComposeProjectService,
    ImageBuildService,
  ],
})
export class DockerModule { }
