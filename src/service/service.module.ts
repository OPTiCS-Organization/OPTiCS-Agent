import { Module } from '@nestjs/common';
import { ServiceLifecycleService } from './service-lifecycle.service';
import { ConfigModule } from '@nestjs/config';
import { SharedModule } from 'src/share/shared.module';
import { ServiceController } from './v1/service.controller';

@Module({
  imports: [ConfigModule, SharedModule],
  providers: [ServiceLifecycleService],
  controllers: [ServiceController],
  exports: [ServiceLifecycleService],
})

export class ServiceModule { }