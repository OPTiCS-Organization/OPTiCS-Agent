import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DashboardGateway } from './dashboard.gateway';
import { TunnelService } from './tunnel.service';
import { ServiceModule } from './service/service.module';
import { SharedModule } from './share/shared.module';
import { NotifyModule } from './notify/notify.module';
import { TunnelModule } from './tunnel/tunnel.module';
import { UtilityModule } from './utility/utility.module';
import { SshTerminalService } from './terminal/ssh-terminal.service';
import { DockerModule } from './docker/docker.module';
import { ContainerLifeCycleService } from './docker/container-lifecycle.service';

@Module({
  imports: [
    ConfigModule.forRoot({ ignoreEnvFile: false }),
    ScheduleModule.forRoot(),
    ServiceModule,
    SharedModule,
    NotifyModule,
    TunnelModule,
    UtilityModule,
    DockerModule,
  ],
  controllers: [AppController],
  providers: [AppService, DashboardGateway, TunnelService, SshTerminalService],
})
export class AppModule {}
