import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { InfoGateway } from './socket.gateway';
import { TunnelService } from './tunnel.service';
import { ServiceModule } from './service/service.module';
import { SharedModule } from './share/shared.module';
import { NotifyModule } from './notify/notify.module';

@Module({
  imports: [
    ConfigModule.forRoot({ ignoreEnvFile: false }),
    ScheduleModule.forRoot(),
    ServiceModule,
    SharedModule,
    NotifyModule,
  ],
  controllers: [AppController],
  providers: [AppService, InfoGateway, TunnelService],
})
export class AppModule {}
