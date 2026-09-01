import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { CoreModule } from './core.module';
import { DockerModule } from './docker/docker.module';
import { NotifyModule } from './notify/notify.module';
import { ServiceModule } from './service/service.module';
import { PrismaModule } from './share/prisma.module';
import { TerminalModule } from './terminal/terminal.module';
import { TunnelModule } from './tunnel/tunnel.module';
import { UtilityModule } from './utility/utility.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: false }),
    ScheduleModule.forRoot(),
    CoreModule,
    DockerModule,
    NotifyModule,
    PrismaModule,
    ServiceModule,
    TerminalModule,
    TunnelModule,
    UtilityModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
