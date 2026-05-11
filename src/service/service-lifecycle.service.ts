import { Injectable, OnModuleInit } from '@nestjs/common';
import { DeployCommand } from './dtos/DeployCommand.dto';
import { DockerLogEntry, DockerLogProgress, DockerService, DockerStatusEvent } from 'src/share/docker.service';
import { RouteRequest } from 'src/global/types/RouteRequest.dto';
import { PrismaService } from 'src/share/prisma.service';
import { DEPLOY_OPTION } from 'src/global/DeployOptionEnum';
import log from 'spectra-log';

type HubEmit = (event: 'service-status' | 'service-log' | 'service-log-markers' | 'container-status', payload: object) => void;

export interface ContainerState {
  name: string;
  status: ContainerStatus;
  service?: string;
  exitCode?: number | null;
  health?: string | null;
}

export type ContainerStatus = 'building' | 'starting' | 'running' | 'stopped' | 'failed' | 'removed';

export interface ContainerSnapshot {
  serviceIndex: number;
  containers: ContainerState[];
  counts: {
    running: number;
    total: number;
  };
}

export interface ServiceLogSessionMarker {
  serviceIndex: number;
  serviceName: string;
  containerName: string;
  event: string;
  timestamp: string;
}

@Injectable()
export class ServiceLifecycleService implements OnModuleInit {
  private hubEmit: HubEmit | null = null;
  private containerSnapshots = new Map<number, ContainerSnapshot>();
  private trackedServices = new Map<number, { serviceName: string; deployPreset: DEPLOY_OPTION }>();

  constructor (
    private readonly dockerService: DockerService,
    private readonly prismaService: PrismaService,
  ) { };

  registerHubEmit(fn: HubEmit) {
    this.hubEmit = fn;
  }

  onModuleInit() {
    this.dockerService.registerStatusEmit((event: DockerStatusEvent) => {
      const containerName = event.containerName;
      let serviceIdx: number | undefined;
      for (const [idx, service] of this.trackedServices.entries()) {
        if (this.containerBelongsToService(containerName, service.serviceName)) {
          serviceIdx = idx;
          break;
        }
      }
      if (serviceIdx === undefined) return;

      const service = this.trackedServices.get(serviceIdx)!;
      log(`[ServiceLifecycleService] container event | name=${containerName} | idx=${serviceIdx}`);
      void this.syncContainerStatus(serviceIdx, service.serviceName, service.deployPreset);
    });
  }

  async createServiceSessionMarker(serviceIndex: number, serviceName: string, event: 'service-deploy' | 'service-redeploy' | 'service-start') {
    const timestamp = new Date();
    const duplicate = await this.prismaService.serviceLogSessionMarker.findFirst({
      where: {
        serviceIndex,
        containerName: serviceName,
        event,
        timestamp: {
          gte: new Date(timestamp.getTime() - 2000),
          lte: new Date(timestamp.getTime() + 2000),
        },
      },
    });
    if (duplicate) return;

    const marker = await this.prismaService.serviceLogSessionMarker.create({
      data: {
        serviceIndex,
        serviceName,
        containerName: serviceName,
        event,
        timestamp,
      },
    });
    this.hubEmit?.('service-log-markers', {
      serviceIndex,
      markers: [{
        serviceIndex: marker.serviceIndex,
        serviceName: marker.serviceName,
        containerName: marker.containerName,
        event: marker.event,
        timestamp: marker.timestamp.toISOString(),
      }],
    });
  }

  private containerBelongsToService(containerName: string, serviceName: string) {
    const normalized = serviceName.toLowerCase();
    return containerName === normalized || containerName.startsWith(`${normalized}-`);
  }

  private aggregateStatus(containers: ContainerState[], fallback: ContainerStatus = 'stopped') {
    if (containers.length === 0) return fallback;
    const statuses = containers.map(container => container.status);
    if (statuses.some(status => status === 'failed')) return 'failed';
    if (statuses.some(status => status === 'building')) return 'building';
    if (statuses.some(status => status === 'starting')) return 'starting';
    if (statuses.every(status => status === 'running')) return 'running';
    if (statuses.every(status => status === 'stopped' || status === 'removed')) return 'stopped';
    return 'starting';
  }

  private snapshotFromContainers(serviceIndex: number, containers: ContainerState[]): ContainerSnapshot {
    return {
      serviceIndex,
      containers,
      counts: {
        running: containers.filter(container => container.status === 'running').length,
        total: containers.length,
      },
    };
  }

  private emitSnapshot(snapshot: ContainerSnapshot) {
    this.containerSnapshots.set(snapshot.serviceIndex, snapshot);
    this.hubEmit?.('container-status', snapshot);
  }

  emitExpectedContainers(serviceIndex: number, serviceName: string, deployPreset: DEPLOY_OPTION, services: string[]) {
    this.trackedServices.set(serviceIndex, { serviceName: serviceName.toLowerCase(), deployPreset });
    const containers = services.length > 0
      ? services.map(service => ({ name: service, service, status: 'building' as ContainerStatus }))
      : [{ name: serviceName.toLowerCase(), status: 'building' as ContainerStatus }];
    this.emitSnapshot(this.snapshotFromContainers(serviceIndex, containers));
  }

  async syncContainerStatus(serviceIndex: number, serviceName: string, deployPreset: DEPLOY_OPTION, fallback: ContainerStatus = 'stopped') {
    this.trackedServices.set(serviceIndex, { serviceName: serviceName.toLowerCase(), deployPreset });
    const containers = await this.dockerService.getContainerSnapshot(serviceName.toLowerCase(), deployPreset);
    const snapshot = this.snapshotFromContainers(serviceIndex, containers);
    this.emitSnapshot(snapshot);
    if (containers.length > 0 || fallback === 'removed') {
      this.hubEmit?.('service-status', { serviceIndex, status: this.aggregateStatus(containers, fallback) });
    }
    return snapshot;
  }

  getContainerSnapshot(serviceIndex: number): ContainerSnapshot | null {
    return this.containerSnapshots.get(serviceIndex) ?? null;
  }

  initContainerStates(serviceIndex: number, serviceName: string, deployPreset: DEPLOY_OPTION) {
    this.trackedServices.set(serviceIndex, { serviceName: serviceName.toLowerCase(), deployPreset });
    const snapshot = this.snapshotFromContainers(serviceIndex, [{ name: serviceName.toLowerCase(), status: 'building' }]);
    this.emitSnapshot(snapshot);
  }

  clearContainerStates(serviceIndex: number) {
    const snapshot = this.snapshotFromContainers(serviceIndex, []);
    this.containerSnapshots.set(serviceIndex, snapshot);
    this.hubEmit?.('container-status', snapshot);
    this.hubEmit?.('service-status', { serviceIndex, status: 'removed' });
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
      starting: 'Restart',
      removed: 'Removed',
    };
    const mapped = statusMap[status] ?? 'Stopped';
    await this.prismaService.services.updateMany({
      where: { idx: serviceIndex },
      data: { serviceStatus: mapped, serviceLastOnline: new Date() },
    });
  }

  async streamServiceLog(
    serviceIndex: number,
    serviceName: string,
    deployPreset: DEPLOY_OPTION,
    onLog: (entry: DockerLogEntry) => void,
    onProgress?: (progress: DockerLogProgress) => void,
  ): Promise<void> {
    log(`[ServiceLifecycleService] streamServiceLog | serviceIndex=${serviceIndex} | name=${serviceName}`);
    await this.dockerService.streamContainerLog(serviceName.toLowerCase(), deployPreset, onLog, onProgress);
  }

  loadOlderServiceLogs(serviceName: string, deployPreset: DEPLOY_OPTION, before: string, limit?: number): DockerLogEntry[] {
    return this.dockerService.loadOlderContainerLogs(serviceName.toLowerCase(), deployPreset, before, limit);
  }

  async loadRecentSessionMarkers(serviceIndex: number, limit = 1000): Promise<ServiceLogSessionMarker[]> {
    const markers = await this.prismaService.serviceLogSessionMarker.findMany({
      where: { serviceIndex },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    return markers.reverse().map(marker => ({
      serviceIndex: marker.serviceIndex,
      serviceName: marker.serviceName,
      containerName: marker.containerName,
      event: marker.event,
      timestamp: marker.timestamp.toISOString(),
    }));
  }

  async loadOlderSessionMarkers(serviceIndex: number, before: string, limit = 1000): Promise<ServiceLogSessionMarker[]> {
    const markers = await this.prismaService.serviceLogSessionMarker.findMany({
      where: {
        serviceIndex,
        timestamp: { lt: new Date(before) },
      },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    return markers.reverse().map(marker => ({
      serviceIndex: marker.serviceIndex,
      serviceName: marker.serviceName,
      containerName: marker.containerName,
      event: marker.event,
      timestamp: marker.timestamp.toISOString(),
    }));
  }

  stopServiceLog(serviceName: string): void {
    this.dockerService.stopContainerLog(serviceName.toLowerCase());
  }

  async v1DeleteService(
    serviceName: string,
    serviceIndex: number,
    deployPreset: DEPLOY_OPTION,
    deleteScope: 'containers' | 'service',
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    await this.dockerService.deleteService(serviceName, deployPreset, deleteScope, emit);
    await this.prismaService.serviceLogSessionMarker.deleteMany({ where: { serviceIndex } });

    if (deleteScope === 'service') {
      await this.prismaService.services.deleteMany({ where: { idx: serviceIndex } });
      return;
    }

    await this.prismaService.services.updateMany({
      where: { idx: serviceIndex },
      data: { serviceStatus: 'Removed', serviceLastOnline: new Date() },
    });
  }

  async v1RedeployService(
    request: DeployCommand,
    emit: HubEmit,
  ) {
    const success = await this.dockerService.redeployService(request, emit, (services) => {
      this.emitExpectedContainers(request.serviceIndex, request.serviceName, request.deployPreset, services);
    });
    if (success) {
      await this.syncContainerStatus(request.serviceIndex, request.serviceName, request.deployPreset);
    }
    return request;
  }

  async v1DeployService(
    request: DeployCommand,
    emit: HubEmit,
  ) {
    const success = await this.dockerService.deployNewService(request, emit, (services) => {
      this.emitExpectedContainers(request.serviceIndex, request.serviceName, request.deployPreset, services);
    });
    if (success) {
      await this.syncContainerStatus(request.serviceIndex, request.serviceName, request.deployPreset);
    }
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
