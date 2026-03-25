import { Injectable, OnModuleInit } from '@nestjs/common';
import { DeployCommand } from './dtos/DeployCommand.dto';
import { DockerService } from 'src/share/docker.service';
import { RouteRequest } from 'src/global/types/RouteRequest.dto';
import { PrismaService } from 'src/share/prisma.service';
import { DEPLOY_OPTION } from 'src/global/DeployOptionEnum';
import log from 'spectra-log';

type HubEmit = (event: 'service-status' | 'service-log', payload: object) => void;

@Injectable()
export class ServiceLifecycleService implements OnModuleInit {
  private hubEmit: HubEmit | null = null;

  constructor (
    private readonly dockerService: DockerService,
    private readonly prismaService: PrismaService,
  ) { };

  registerHubEmit(fn: HubEmit) {
    this.hubEmit = fn;
  }

  onModuleInit() {
    this.dockerService.registerStatusEmit(async (raw: string) => {
      // raw 형식: "status:containerName"
      const colonIdx = raw.indexOf(':');
      const status = raw.slice(0, colonIdx);
      const containerName = raw.slice(colonIdx + 1);

      // Compose 컨테이너명({project}-{svc}-{n}) → 프로젝트명(serviceName)으로 역매핑
      const services = await this.prismaService.services.findMany();
      const service = services.find(s =>
        containerName === s.serviceName.toLowerCase() ||
        containerName.startsWith(`${s.serviceName.toLowerCase()}-`)
      );
      if (!service) return;

      log(`[ServiceLifecycleService] container stopped | name=${containerName} | status=${status} | idx=${service.idx}`);

      const statusMap: Record<string, 'Running' | 'Stopped' | 'Restart' | 'Deleted' | 'Removed'> = {
        running: 'Running', stopped: 'Stopped', failed: 'Stopped', restarting: 'Restart', removed: 'Removed',
      };
      const mappedStatus = statusMap[status] ?? 'Stopped';
      await this.prismaService.services.update({
        where: { idx: service.idx },
        data: { serviceStatus: mappedStatus, serviceLastOnline: new Date() },
      });

      if (mappedStatus !== 'Restart') {
        this.hubEmit?.('service-status', { serviceIndex: service.idx, status: mappedStatus.toLowerCase() });
      }
    });
  }

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

  async getServiceList() {
    return this.prismaService.services.findMany({
      orderBy: { serviceLastOnline: 'desc' },
    });
  }

  async updateServiceStatus(serviceIndex: number, status: string): Promise<void> {
    const statusMap: Record<string, 'Running' | 'Stopped' | 'Restart' | 'Deleted' | 'Removed'> = {
      running: 'Running',
      stopped: 'Stopped',
      failed: 'Stopped',
      building: 'Running',
      removed: 'Removed',
    };
    const mapped = statusMap[status] ?? 'Stopped';
    await this.prismaService.services.updateMany({
      where: { idx: serviceIndex },
      data: { serviceStatus: mapped, serviceLastOnline: new Date() },
    });
  }

  async streamServiceLog(serviceIndex: number, serviceName: string, deployPreset: DEPLOY_OPTION, onLog: (line: string) => void): Promise<void> {
    log(`[ServiceLifecycleService] streamServiceLog | serviceIndex=${serviceIndex} | name=${serviceName}`);
    await this.dockerService.streamContainerLog(serviceName.toLowerCase(), deployPreset, onLog);
  }

  stopServiceLog(serviceName: string): void {
    this.dockerService.stopContainerLog(serviceName.toLowerCase());
  }

  async v1DeleteService(
    serviceName: string,
    serviceIndex: number,
    deployPreset: DEPLOY_OPTION,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    await this.dockerService.deleteService(serviceName, deployPreset, emit);
    await this.prismaService.services.delete({ where: { idx: serviceIndex } });
  }

  async v1RedeployService(
    request: DeployCommand,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    await this.dockerService.redeployService(request, emit);
    return request;
  }

  async v1DeployService(
    request: DeployCommand,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    await this.dockerService.deployNewService(request, emit);
    return request;
  }

  async v1StartService(
    serviceName: string,
    deployPreset: DEPLOY_OPTION,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    await this.dockerService.restartService(serviceName, deployPreset, emit);
  }

  async v1StopService(
    serviceName: string,
    deployPreset: DEPLOY_OPTION,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    await this.dockerService.stopService(serviceName, deployPreset, emit);
  }
}