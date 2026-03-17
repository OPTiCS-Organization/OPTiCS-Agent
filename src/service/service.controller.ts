import { Body, Controller, Post } from '@nestjs/common';
import { DeployCommand } from './dtos/DeployCommand.dto';
import { ServiceLifecycleService } from './service-lifecycle.service';

@Controller('service')
export class ServiceController {
  constructor(
    private readonly serviceLifecycleService: ServiceLifecycleService,
  ) { }

  @Post('v1/deploy')
  async v1DeployService(@Body() request: DeployCommand) {
    await this.serviceLifecycleService.v1DeployService(request);
    return;
  }
}
