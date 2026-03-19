import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaService } from './prisma.service';
import { InfoGateway } from './socket.gateway';
import { ServiceModule } from './service/service.module';
import { NotifyModule } from './notify/notify.module';

@Module({
  imports: [
    ConfigModule.forRoot({ ignoreEnvFile: false }),
    ScheduleModule.forRoot(),
    ServiceModule,
    NotifyModule,
  ],
  controllers: [AppController],
  providers: [AppService, PrismaService, InfoGateway],
})
export class AppModule {}
