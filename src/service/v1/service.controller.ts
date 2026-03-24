import { Body, Controller, Get, Post } from '@nestjs/common';
import { DeployCommand } from '../dtos/DeployCommand.dto';
import { ServiceLifecycleService } from '../service-lifecycle.service';

@Controller({ path: 'service', version: '1' })
export class ServiceController {
  constructor(
    private readonly serviceLifecycleService: ServiceLifecycleService,
  ) { }

  @Get()
  async v1GetServiceList() {
    return this.serviceLifecycleService.getServiceList();
  }

  @Post('deploy')
  async v1DeployService(@Body() request: DeployCommand) {
    await this.serviceLifecycleService.v1DeployService(request, () => {});
    return;
  }
}
