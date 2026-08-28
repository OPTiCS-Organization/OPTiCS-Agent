import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DashboardGateway } from './dashboard.gateway';
import { TunnelService } from './tunnel/tunnel.service';
import { ServiceModule } from './service/service.module';
import { NotifyModule } from './notify/notify.module';
import { TunnelModule } from './tunnel/tunnel.module';
import { UtilityModule } from './utility/utility.module';
import { SshTerminalService } from './terminal/ssh-terminal.service';
import { DockerModule } from './docker/docker.module';
import { ContainerLifeCycleService } from './docker/container-lifecycle.service';
import { PrismaModule } from './share/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ ignoreEnvFile: false }),
    ScheduleModule.forRoot(),
    ServiceModule,
    NotifyModule,
    TunnelModule,
    UtilityModule,
    DockerModule,
    PrismaModule,
  ],
  controllers: [AppController],
  providers: [AppService, DashboardGateway, TunnelService, SshTerminalService],
})
export class AppModule {}
