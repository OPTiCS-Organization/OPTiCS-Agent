import { Module } from '@nestjs/common';
import { NotifyController } from './notify.controller';
import { NotifyService } from './notify.service';
import { NotifyGateway } from './notify.gateway';
import { PrismaModule } from '../share/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [NotifyController],
  providers: [NotifyService, NotifyGateway],
  exports: [NotifyService, NotifyGateway],
})
export class NotifyModule {}
