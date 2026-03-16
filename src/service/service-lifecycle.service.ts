import { Injectable } from '@nestjs/common';
import { DeployCommand } from './dtos/DeployCommand.dto';

@Injectable()
export class ServiceLifecycleService {
  async deployService(request: DeployCommand) {
    
    return request;
  }
}
