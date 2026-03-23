import { Injectable } from '@nestjs/common';
import { DeployCommand } from './dtos/DeployCommand.dto';
import { DockerService } from 'src/share/docker.service';
import { RouteRequest } from 'src/global/types/RouteRequest.dto';
import { PrismaService } from 'src/share/prisma.service';

@Injectable()
export class ServiceLifecycleService {
  constructor (
    private readonly dockerService: DockerService,
    private readonly prismaService: PrismaService,
  ) { };

  async fetchJSON(request: RouteRequest) {
    const service = await this.prismaService.services.findFirst({
      where: {
        serviceName: request.targetServiceName
      }
    })

    // Todo: Add Case
    if (!service) return -1;

    const response = fetch(`http://localhost:${service.servicePort}/${request.path}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });

    return response;
  }

  async v1DeployService(request: DeployCommand) {
    await this.dockerService.deployNewService(request);    
    return request;
  }
}