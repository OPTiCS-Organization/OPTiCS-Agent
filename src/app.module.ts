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

@Module({
  imports: [
    ConfigModule.forRoot({ ignoreEnvFile: false }),
    ScheduleModule.forRoot(),
    ServiceModule,
    SharedModule,
    NotifyModule,
    TunnelModule,
    UtilityModule,
  ],
  controllers: [AppController],
  providers: [AppService, DashboardGateway, TunnelService],
})
export class AppModule {}
