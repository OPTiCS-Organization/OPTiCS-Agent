import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaService } from './prisma.service';
import { InfoGateway } from './socket.gateway';
import { ServiceModule } from './service/service.module';

@Module({
  imports: [
    ConfigModule.forRoot({ ignoreEnvFile: true }),
    ScheduleModule.forRoot(),
    ServiceModule,
  ],
  controllers: [AppController],
  providers: [AppService, PrismaService, InfoGateway],
})
export class AppModule {}
