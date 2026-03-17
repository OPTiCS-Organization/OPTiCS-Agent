import { Injectable } from '@nestjs/common';
import { DeployCommand } from './dtos/DeployCommand.dto';
import { DockerService } from 'src/docker.service';

@Injectable()
export class ServiceLifecycleService {
  constructor (
    private readonly dockerService: DockerService,
  ) { };

  async v1DeployService(request: DeployCommand) {
    await this.dockerService.deployNewService(request);    
    return request;
  }
}