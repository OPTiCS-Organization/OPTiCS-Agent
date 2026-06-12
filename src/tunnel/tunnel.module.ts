import { Module } from '@nestjs/common';
import { ReverseTunnelService } from './reverse-tunnel.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  providers: [ReverseTunnelService],
  exports: [ReverseTunnelService],
})
export class TunnelModule {}
