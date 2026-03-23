import { Module } from '@nestjs/common';
import { ServiceLifecycleService } from './service-lifecycle.service';
import { ServiceController } from './service.controller';
import { ConfigModule } from '@nestjs/config';
import { SharedModule } from 'src/share/shared.module';

@Module({
  imports: [ConfigModule, SharedModule],
  providers: [ServiceLifecycleService],
  controllers: [ServiceController],
  exports: [ServiceLifecycleService],
})

export class ServiceModule { }