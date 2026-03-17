import { Module } from '@nestjs/common';
import { ServiceLifecycleService } from './service-lifecycle.service';
import { ServiceController } from './service.controller';
import { DockerService } from 'src/docker.service';
import { ConfigModule } from '@nestjs/config';
import { GitService } from 'src/git.service';

@Module({
  imports: [ConfigModule],
  providers: [ServiceLifecycleService, DockerService, GitService],
  controllers: [ServiceController],
})

export class ServiceModule { }