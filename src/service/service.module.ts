import { Module } from '@nestjs/common';
import { ServiceLifecycleService } from './service-lifecycle.service';
import { ServiceGateway } from './service.gateway';
import { ConfigModule } from '@nestjs/config';
import { SharedModule } from 'src/share/shared.module';
import { ServiceController } from './v1/service.controller';
import { DockerModule } from 'src/docker/docker.module';
import { ContainerLifeCycleService } from 'src/docker/container-lifecycle.service';
import { DeployService } from 'src/docker/deploy.service';

@Module({
  imports: [ConfigModule, DockerModule, SharedModule],
  providers: [ServiceLifecycleService, ServiceGateway, ContainerLifeCycleService, DeployService],
  controllers: [ServiceController],
  exports: [ServiceLifecycleService, ServiceGateway],
})

export class ServiceModule { }
