import { Module } from '@nestjs/common';
import { ServiceLifecycleService } from './service-lifecycle.service';
import { ServiceController } from './service.controller';

@Module({
  providers: [ServiceLifecycleService],
  controllers: [ServiceController],
})
export class ServiceModule {}