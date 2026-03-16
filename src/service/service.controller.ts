import { Body, Controller, Post } from '@nestjs/common';
import { DeployCommand } from './dtos/DeployCommand.dto';
import { ServiceLifecycleService } from './service-lifecycle.service';

@Controller('service')
export class ServiceController {
  constructor(
    private readonly serviceLifecycleService: ServiceLifecycleService,
  ) { }

  @Post('deploy')
  async deployService(@Body() request: DeployCommand) {
    return await this.serviceLifecycleService.deployService(request);
  }
}
