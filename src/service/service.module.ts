import { Module } from '@nestjs/common';
import { ServiceLifecycleService } from './service-lifecycle.service';
import { ServiceGateway } from './service.gateway';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from 'src/share/prisma.module';
import { ServiceController } from './v1/service.controller';
import { DockerModule } from 'src/docker/docker.module';

@Module({
  imports: [ConfigModule, DockerModule, PrismaModule],
  providers: [ServiceLifecycleService, ServiceGateway],
  controllers: [ServiceController],
  exports: [ServiceLifecycleService, ServiceGateway],
})

export class ServiceModule { }
