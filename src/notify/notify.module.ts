import { Module } from '@nestjs/common';
import { NotifyController } from './v1/notify.controller';
import { NotifyService } from './notify.service';
import { NotificationGateway } from 'src/socket.gateway';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from 'src/prisma.service';

@Module({
  imports: [ConfigModule],
  controllers: [NotifyController],
  providers: [NotifyService, NotificationGateway, PrismaService]
})
export class NotifyModule {}
