import { Module } from '@nestjs/common';
import { CoreModule } from 'src/core.module';
import { DockerModule } from 'src/docker/docker.module';
import { NotifyModule } from 'src/notify/notify.module';
import { ServiceModule } from 'src/service/service.module';
import { PrismaModule } from 'src/share/prisma.module';
import { TerminalModule } from 'src/terminal/terminal.module';
import { UtilityModule } from 'src/utility/utility.module';
import { ReverseTunnelService } from './reverse-tunnel.service';
import { TunnelService } from './tunnel.service';

@Module({
  imports: [
    CoreModule,
    DockerModule,
    NotifyModule,
    ServiceModule,
    PrismaModule,
    TerminalModule,
    UtilityModule,
  ],
  providers: [TunnelService, ReverseTunnelService],
  exports: [TunnelService, ReverseTunnelService],
})
export class TunnelModule {}
