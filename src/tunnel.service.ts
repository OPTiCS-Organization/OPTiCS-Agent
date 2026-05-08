import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import log from 'spectra-log';
import { Command } from './global/types/Command.dto';
import { RouteRequest } from './global/types/RouteRequest.dto';
import { ServiceLifecycleService } from './service/service-lifecycle.service';
import { ServiceGateway } from './service/service.gateway';
import { COMMAND } from './global/Command.enum';
import { PrismaService } from './share/prisma.service';
import { NotifyService } from './notify/notify.service';
import type { ConnectRequestPayload } from './notify/notify.service';
import { NotifyGateway } from './notify/notify.gateway';
import { DockerService } from './share/docker.service';

@Injectable()
export class TunnelService implements OnModuleInit, OnModuleDestroy {
  private socket!: Socket;
  private agentUuid: string | undefined;

  constructor(
    private readonly serviceLifecycleService: ServiceLifecycleService,
    private readonly serviceGateway: ServiceGateway,
    private readonly prismaService: PrismaService,
    private readonly notifyService: NotifyService,
    private readonly notifyGateway: NotifyGateway,
    private readonly dockerService: DockerService,
  ) { }

  async onModuleInit() {
    const hubUrl = process.env.HUB_URL ?? 'http://localhost:3000';

    this.agentUuid = await this.prismaService.agentInfo.findUnique({ where: { key: 'agent-uuid' } }).then(result => result?.value)
    if (this.agentUuid) log(`[TunnelService] {{ green : bold : AGENT:UUID_FOUND }}\n  Agent UUID : ${this.agentUuid}`);
    else log(`[TunnelService] {{ yellow : bold : AGENT:UUID_MISSING }}`);

    this.socket = io(`${hubUrl}/agent`, {
      reconnection: true,
      reconnectionDelay: 3000,
      auth: { agentUuid: this.agentUuid ?? null },
    });

    (this.serviceLifecycleService.registerHubEmit as (fn: (event: string, payload: object) => void) => void)((event, payload) => {
      this.socket.emit(event, payload);
    });

    this.socket.on('connect', () => {
      log(`[TunnelService] {{ green : bold : SOCKET:CONNECTED }}\n  Hub URL   : ${hubUrl}\n  Socket ID : ${this.socket.id}`);
      this.socket.emit('register', { agentUuid: this.agentUuid ?? null });
    });

    this.socket.on('register', async (payload: { agentCode: string, agentUuid: string, agentIp: string }) => {
      log(`[TunnelService] {{ cyan : bold : REGISTER:RECEIVED }}\n  Agent Code : ${payload.agentCode}\n  Agent UUID : ${payload.agentUuid}\n  Agent IP   : ${payload.agentIp}`)
      if (this.agentUuid && this.agentUuid !== payload.agentUuid) {
        this.agentUuid = payload.agentUuid;
        log(`[TunnelService] {{ yellow : bold : AGENT:UUID_UPDATED }}\n  Agent UUID : ${this.agentUuid}`);
      }
      await this.prismaService.agentInfo.upsert({
        where: { key: 'agent-code' },
        create: { key: 'agent-code', value: payload.agentCode },
        update: { value: payload.agentCode },
      });
      await this.prismaService.agentInfo.upsert({
        where: { key: 'agent-uuid' },
        create: { key: 'agent-uuid', value: payload.agentUuid },
        update: { value: payload.agentUuid }
      })
      await this.prismaService.agentInfo.upsert({
        where: { key: 'agent-ip' },
        create: { key: 'agent-ip', value: payload.agentIp },
        update: { value: payload.agentIp }
      })
      log(`[TunnelService] {{ green : bold : REGISTER:SAVED }}\n  Agent Code : ${payload.agentCode}`);
    })

    this.socket.on('disconnect', () => {
      log(`[TunnelService] {{ red : bold : SOCKET:DISCONNECTED }}`);
    });

    this.socket.on('command', async (payload: Command) => {
      log(`[TunnelService] {{ cyan : bold : CMD:START }}\n  Command       : ${payload.command}\n  Service Index : ${payload.serviceIndex ?? '-'}\n  Service Name  : ${payload.serviceName ?? '-'}\n  Preset        : ${payload.deployPreset ?? '-'}`);
      let response = {};

      switch (payload.command) {
        case COMMAND.DEPLOY:
          this.serviceLifecycleService.initContainerStates(payload.serviceIndex, payload.serviceName.toLowerCase(), payload.deployPreset);
          response = await this.serviceLifecycleService.v1DeployService(
            {
              apiKey: '',
              serviceIndex: payload.serviceIndex,
              deployPreset: payload.deployPreset,
              serviceName: payload.serviceName,
              servicePort: payload.servicePort,
              serviceHostPort: payload.serviceHostPort,
              serviceContainerPort: payload.serviceContainerPort,
              sourceUrl: payload.sourceUrl,
              rootDirectory: payload.rootDirectory,
              serviceVersion: payload.serviceVersion,
              env: payload.env,
            },
            (event: string, emitPayload: unknown) => {
              this.socket.emit(event, emitPayload);
              const p = emitPayload as { serviceIndex: number; status?: string; log?: string; timestamp?: string; containers?: unknown };
              const idx: number = p.serviceIndex;
              if (event === 'service-status' && typeof p.status === 'string') {
                const status: string = p.status;
                log(`[TunnelService] {{ cyan : bold : EVENT:STATUS }}\n  Service Index : ${idx}\n  Status        : ${status}`);
                this.serviceGateway.pushStatus(idx, status);
                void this.serviceLifecycleService.updateServiceStatus(idx, status).catch((e: unknown) => log(e));
              } else if (event === 'service-log' && typeof p.log === 'string') {
                const timestamp = p.timestamp ?? new Date().toISOString();
                log(`[TunnelService] {{ blue : bold : EVENT:LOG }}\n  Service Index : ${idx}\n  Timestamp     : ${timestamp}\n  Log           : ${p.log}`);
                this.serviceGateway.pushLog(idx, p.log, timestamp);
              }
            },
          );
          break;
        case COMMAND.REDEPLOY:
          this.serviceLifecycleService.initContainerStates(payload.serviceIndex, payload.serviceName.toLowerCase(), payload.deployPreset);
          response = await this.serviceLifecycleService.v1RedeployService(
            {
              apiKey: '',
              serviceIndex: payload.serviceIndex,
              deployPreset: payload.deployPreset,
              serviceName: payload.serviceName,
              servicePort: payload.servicePort,
              serviceHostPort: payload.serviceHostPort,
              serviceContainerPort: payload.serviceContainerPort,
              sourceUrl: payload.sourceUrl,
              rootDirectory: payload.rootDirectory,
              serviceVersion: payload.serviceVersion,
              env: payload.env,
            },
            (event: string, emitPayload: unknown) => {
              this.socket.emit(event, emitPayload);
              const p = emitPayload as { serviceIndex: number; status?: string; log?: string; timestamp?: string; containers?: unknown };
              const idx: number = p.serviceIndex;
              if (event === 'service-status' && typeof p.status === 'string') {
                log(`[TunnelService] {{ cyan : bold : EVENT:STATUS }}\n  Service Index : ${idx}\n  Status        : ${p.status}`);
                this.serviceGateway.pushStatus(idx, p.status);
                void this.serviceLifecycleService.updateServiceStatus(idx, p.status).catch((e: unknown) => log(e));
              } else if (event === 'service-log' && typeof p.log === 'string') {
                const timestamp = p.timestamp ?? new Date().toISOString();
                log(`[TunnelService] {{ blue : bold : EVENT:LOG }}\n  Service Index : ${idx}\n  Timestamp     : ${timestamp}\n  Log           : ${p.log}`);
                this.serviceGateway.pushLog(idx, p.log, timestamp);
              }
            },
          );
          break;
        case COMMAND.START: {
          const startIdx = Number(payload.serviceIndex);
          await this.serviceLifecycleService.syncContainerStatus(startIdx, payload.serviceName, payload.deployPreset);
          await this.serviceLifecycleService.v1StartService(
            payload.serviceName,
            payload.deployPreset,
            (event: string, emitPayload: unknown) => {
              const p = emitPayload as { serviceName: string; status?: string; log?: string; timestamp?: string };
              if (event === 'service-status' && typeof p.status === 'string') {
                this.socket.emit(event, { serviceIndex: startIdx, status: p.status });
                log(`[TunnelService] {{ cyan : bold : EVENT:STATUS }}\n  Service Index : ${startIdx}\n  Status        : ${p.status}`);
                this.serviceGateway.pushStatus(startIdx, p.status);
                void this.serviceLifecycleService.updateServiceStatus(startIdx, p.status);
              } else if (event === 'service-log' && typeof p.log === 'string') {
                const timestamp = p.timestamp ?? new Date().toISOString();
                this.socket.emit(event, { serviceIndex: startIdx, log: p.log, timestamp });
                log(`[TunnelService] {{ blue : bold : EVENT:LOG }}\n  Service Index : ${startIdx}\n  Timestamp     : ${timestamp}\n  Log           : ${p.log}`);
                this.serviceGateway.pushLog(startIdx, p.log, timestamp);
              }
            },
          );
          await this.serviceLifecycleService.syncContainerStatus(startIdx, payload.serviceName, payload.deployPreset, 'starting');
          break;
        }
        case COMMAND.STOP: {
          const stopIdx = Number(payload.serviceIndex);
          await this.serviceLifecycleService.syncContainerStatus(stopIdx, payload.serviceName, payload.deployPreset);
          await this.serviceLifecycleService.v1StopService(
            payload.serviceName,
            payload.deployPreset,
            (event: string, emitPayload: unknown) => {
              const p = emitPayload as { serviceName: string; status?: string; log?: string; timestamp?: string };
              if (event === 'service-status' && typeof p.status === 'string') {
                this.socket.emit(event, { serviceIndex: stopIdx, status: p.status });
                log(`[TunnelService] {{ cyan : bold : EVENT:STATUS }}\n  Service Index : ${stopIdx}\n  Status        : ${p.status}`);
                this.serviceGateway.pushStatus(stopIdx, p.status);
                void this.serviceLifecycleService.updateServiceStatus(stopIdx, p.status);
              } else if (event === 'service-log' && typeof p.log === 'string') {
                const timestamp = p.timestamp ?? new Date().toISOString();
                this.socket.emit(event, { serviceIndex: stopIdx, log: p.log, timestamp });
                log(`[TunnelService] {{ blue : bold : EVENT:LOG }}\n  Service Index : ${stopIdx}\n  Timestamp     : ${timestamp}\n  Log           : ${p.log}`);
                this.serviceGateway.pushLog(stopIdx, p.log, timestamp);
              }
            },
          );
          await this.serviceLifecycleService.syncContainerStatus(stopIdx, payload.serviceName, payload.deployPreset);
          break;
        }
        case COMMAND.CONTAINER_START: {
          const svcIdx = Number(payload.serviceIndex);
          const containerName = String(payload.containerName ?? '');
          if (!containerName) break;
          await this.serviceLifecycleService.syncContainerStatus(svcIdx, payload.serviceName, payload.deployPreset);
          await this.dockerService.startContainer(
            containerName,
            payload.deployPreset,
            (event: string, emitPayload: unknown) => {
              const p = emitPayload as { serviceName: string; status?: string; log?: string; timestamp?: string };
              if (event === 'service-status' && typeof p.status === 'string') {
                this.socket.emit(event, { serviceIndex: svcIdx, status: p.status });
                log(`[TunnelService] {{ cyan : bold : EVENT:STATUS }}\n  Service Index : ${svcIdx}\n  Status        : ${p.status}`);
                this.serviceGateway.pushStatus(svcIdx, p.status);
                void this.serviceLifecycleService.updateServiceStatus(svcIdx, p.status);
              } else if (event === 'service-log' && typeof p.log === 'string') {
                const timestamp = p.timestamp ?? new Date().toISOString();
                this.socket.emit(event, { serviceIndex: svcIdx, log: p.log, timestamp });
                log(`[TunnelService] {{ blue : bold : EVENT:LOG }}\n  Service Index : ${svcIdx}\n  Timestamp     : ${timestamp}\n  Log           : ${p.log}`);
                this.serviceGateway.pushLog(svcIdx, p.log, timestamp);
              }
            },
          );
          await this.serviceLifecycleService.syncContainerStatus(svcIdx, payload.serviceName, payload.deployPreset, 'starting');
          break;
        }
        case COMMAND.CONTAINER_STOP: {
          const svcIdx = Number(payload.serviceIndex);
          const containerName = String(payload.containerName ?? '');
          if (!containerName) break;
          await this.serviceLifecycleService.syncContainerStatus(svcIdx, payload.serviceName, payload.deployPreset);
          await this.dockerService.stopContainer(
            containerName,
            payload.deployPreset,
            (event: string, emitPayload: unknown) => {
              const p = emitPayload as { serviceName: string; status?: string; log?: string; timestamp?: string };
              if (event === 'service-status' && typeof p.status === 'string') {
                this.socket.emit(event, { serviceIndex: svcIdx, status: p.status });
                log(`[TunnelService] {{ cyan : bold : EVENT:STATUS }}\n  Service Index : ${svcIdx}\n  Status        : ${p.status}`);
                this.serviceGateway.pushStatus(svcIdx, p.status);
                void this.serviceLifecycleService.updateServiceStatus(svcIdx, p.status);
              } else if (event === 'service-log' && typeof p.log === 'string') {
                const timestamp = p.timestamp ?? new Date().toISOString();
                this.socket.emit(event, { serviceIndex: svcIdx, log: p.log, timestamp });
                log(`[TunnelService] {{ blue : bold : EVENT:LOG }}\n  Service Index : ${svcIdx}\n  Timestamp     : ${timestamp}\n  Log           : ${p.log}`);
                this.serviceGateway.pushLog(svcIdx, p.log, timestamp);
              }
            },
          );
          await this.serviceLifecycleService.syncContainerStatus(svcIdx, payload.serviceName, payload.deployPreset);
          break;
        }
        case COMMAND.CONTAINER_RESTART: {
          const svcIdx = Number(payload.serviceIndex);
          const containerName = String(payload.containerName ?? '');
          if (!containerName) break;
          await this.serviceLifecycleService.syncContainerStatus(svcIdx, payload.serviceName, payload.deployPreset);
          await this.dockerService.restartContainer(
            containerName,
            payload.deployPreset,
            (event: string, emitPayload: unknown) => {
              const p = emitPayload as { serviceName: string; status?: string; log?: string; timestamp?: string };
              if (event === 'service-status' && typeof p.status === 'string') {
                this.socket.emit(event, { serviceIndex: svcIdx, status: p.status });
                log(`[TunnelService] {{ cyan : bold : EVENT:STATUS }}\n  Service Index : ${svcIdx}\n  Status        : ${p.status}`);
                this.serviceGateway.pushStatus(svcIdx, p.status);
                void this.serviceLifecycleService.updateServiceStatus(svcIdx, p.status);
              } else if (event === 'service-log' && typeof p.log === 'string') {
                const timestamp = p.timestamp ?? new Date().toISOString();
                this.socket.emit(event, { serviceIndex: svcIdx, log: p.log, timestamp });
                log(`[TunnelService] {{ blue : bold : EVENT:LOG }}\n  Service Index : ${svcIdx}\n  Timestamp     : ${timestamp}\n  Log           : ${p.log}`);
                this.serviceGateway.pushLog(svcIdx, p.log, timestamp);
              }
            },
          );
          await this.serviceLifecycleService.syncContainerStatus(svcIdx, payload.serviceName, payload.deployPreset, 'starting');
          break;
        }
        case COMMAND.ABORT:
          log(`[TunnelService] {{ gray : bold : CMD:IGNORED }}\n  Command       : ${payload.command}\n  Service Index : ${payload.serviceIndex ?? '-'}\n  Service Name  : ${payload.serviceName ?? '-'}\n  Preset        : ${payload.deployPreset ?? '-'}`);
          break;
        case COMMAND.DELETE: {
          const deleteIdx = Number(payload.serviceIndex);
          await this.serviceLifecycleService.syncContainerStatus(deleteIdx, payload.serviceName, payload.deployPreset);
          await this.serviceLifecycleService.v1DeleteService(
            payload.serviceName,
            deleteIdx,
            payload.deployPreset,
            (event: string, emitPayload: unknown) => {
              const p = emitPayload as { serviceName: string; status?: string; log?: string; timestamp?: string };
              if (event === 'service-status' && typeof p.status === 'string') {
                this.socket.emit(event, { serviceIndex: deleteIdx, status: p.status });
                log(`[TunnelService] {{ cyan : bold : EVENT:STATUS }}\n  Service Index : ${deleteIdx}\n  Status        : ${p.status}`);
                this.serviceGateway.pushStatus(deleteIdx, p.status);
              } else if (event === 'service-log' && typeof p.log === 'string') {
                const timestamp = p.timestamp ?? new Date().toISOString();
                this.socket.emit(event, { serviceIndex: deleteIdx, log: p.log, timestamp });
                log(`[TunnelService] {{ blue : bold : EVENT:LOG }}\n  Service Index : ${deleteIdx}\n  Timestamp     : ${timestamp}\n  Log           : ${p.log}`);
                this.serviceGateway.pushLog(deleteIdx, p.log, timestamp);
              }
            },
          );
          this.serviceLifecycleService.clearContainerStates(deleteIdx);
          break;
        }
        case COMMAND.DISCONNECT:
          log(`[TunnelService] {{ red : bold : SOCKET:DISCONNECT_REQUESTED }}`);
          this.socket.disconnect();
          break;
        case COMMAND.STREAM_LOG: {
          const streamIdx: number = Number(payload.serviceIndex);
          const streamName: string = String(payload.serviceName);
          const snapshot = this.serviceLifecycleService.getContainerSnapshot(streamIdx);
          if (snapshot) {
            this.socket.emit('container-status', snapshot);
          }
          await this.serviceLifecycleService.streamServiceLog(
            streamIdx,
            streamName,
            payload.deployPreset,
            (line: string) => {
              const timestamp = new Date().toISOString();
              this.socket.emit('service-log', { serviceIndex: streamIdx, log: line, timestamp });
              log(`[TunnelService] {{ blue : bold : EVENT:LOG }}\n  Service Index : ${streamIdx}\n  Timestamp     : ${timestamp}\n  Log           : ${line}`);
            },
          );
          break;
        }
        case COMMAND.SYNC_CONTAINER_STATUS: {
          const syncIdx = Number(payload.serviceIndex);
          const snapshot = await this.serviceLifecycleService.syncContainerStatus(
            syncIdx,
            String(payload.serviceName),
            payload.deployPreset,
          );
          this.socket.emit('container-status', snapshot);
          break;
        }
        case COMMAND.STOP_LOG: {
          const stopName: string = String(payload.serviceName);
          this.serviceLifecycleService.stopServiceLog(stopName);
          break;
        }
      }

      log(`[TunnelService] {{ green : bold : CMD:DONE }}\n  Command       : ${payload.command}\n  Service Index : ${payload.serviceIndex ?? '-'}\n  Service Name  : ${payload.serviceName ?? '-'}\n  Preset        : ${payload.deployPreset ?? '-'}`);
      this.socket.emit('response', response);
    });

    this.socket.on('connect-request', async (payload: ConnectRequestPayload) => {
      await this.notifyService.savePendingRequest(payload);
      this.notifyGateway.pushConnectRequest(payload);
      log(`[TunnelService] {{ cyan : bold : CONNECT_REQUEST:RECEIVED }}\n  Workspace       : ${payload.workspaceName}\n  Workspace Index : ${payload.workspaceIndex}`);
    });

    this.socket.on('reverse-proxy', async (payload: RouteRequest) => {
      log(`[TunnelService] {{ magenta : bold : REVERSE_PROXY:REQUEST }}\n  Target Service : ${payload.targetServiceName}\n  Path           : ${payload.path}`);
      const response = await this.serviceLifecycleService.fetchJSON(payload);
      this.socket.emit('response', response);
    });
  }

  onModuleDestroy() {
    this.socket?.disconnect();
  }
}
