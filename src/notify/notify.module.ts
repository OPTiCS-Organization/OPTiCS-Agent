import { Module } from '@nestjs/common';
import { NotifyController } from './notify.controller';
import { NotifyService } from './notify.service';
import { NotifyGateway } from './notify.gateway';
import { SharedModule } from '../share/shared.module';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [SharedModule],
  controllers: [NotifyController],
  providers: [NotifyService, NotifyGateway, ConfigService],
  exports: [NotifyService],
})
export class NotifyModule {}
