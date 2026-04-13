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

@Injectable()
export class TunnelService implements OnModuleInit, OnModuleDestroy {
  constructor(
    private socket: Socket,
    private readonly serviceLifecycleService: ServiceLifecycleService,
    private readonly serviceGateway: ServiceGateway,
    private readonly prismaService: PrismaService,
    private readonly notifyService: NotifyService,
    private readonly notifyGateway: NotifyGateway,
  ) { }

  async onModuleInit() {
    const hubUrl = process.env.HUB_URL ?? 'http://localhost:3000';

    const agentUuid = await this.prismaService.agentInfo.findUnique({ where: { key: 'agent-uuid' } })
    if (agentUuid) log(`UUID Found: ${agentUuid.value}`);
    else log('No UUID Found');

    this.socket = io(`${hubUrl}/agent`, {
      reconnection: true,
      reconnectionDelay: 3000,
      auth: { agentUuid: agentUuid?.key ?? null },
    });

    (this.serviceLifecycleService.registerHubEmit as (fn: (event: string, payload: object) => void) => void)((event, payload) => {
      this.socket.emit(event, payload);
    });

    this.socket.on('connect', () => {
      log(`{{ green : bold : Socket Connection Established with Hub. }}\n {{ dim : bold : → Socket ID: ${this.socket.id} }}`);
      this.socket.emit('register', { agentUuid: agentUuid?.value ?? null });
    });

    this.socket.on('register', async (payload: { agentCode: string, agentUuid: string, agentIp: string }) => {
      log(`[{{ bold : cyan : Tunnel Service}}] Received register event.`)
      if (agentUuid && agentUuid.value !== payload.agentUuid) {
        agentUuid.value = payload.agentUuid;
        log(`UUID Updated: ${agentUuid.value}`);
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
      log(`Agent Code Received from Hub.\n → Agent Code: ${payload.agentCode}`);
    })

    this.socket.on('disconnect', () => {
      log('{{ bold : red : Socket Connection Lost with Hub. }}');
    });

    this.socket.on('command', async (payload: Command) => {
      log(`[TunnelService] Command Received From Hub.\n → COMMAND: ${payload.command}`);
      let response = {};

      switch (payload.command) {
        case COMMAND.DEPLOY:
          log(`[TunnelService] DEPLOY | serviceIndex=${payload.serviceIndex} | name=${payload.serviceName} | preset=${payload.deployPreset}`);
          response = await this.serviceLifecycleService.v1DeployService(
            {
              apiKey: '',
              serviceIndex: payload.serviceIndex,
              deployPreset: payload.deployPreset,
              serviceName: payload.serviceName,
              servicePort: payload.servicePort,
              sourceUrl: payload.sourceUrl,
              serviceVersion: payload.serviceVersion,
              env: payload.env,
            },
            (event: string, emitPayload: unknown) => {
              this.socket.emit(event, emitPayload);
              const p = emitPayload as { serviceIndex: number; status?: string; log?: string; timestamp?: string };
              const idx: number = p.serviceIndex;
              if (event === 'service-status' && typeof p.status === 'string') {
                const status: string = p.status;
                log(`[TunnelService] emit service-status | serviceIndex=${idx} | status=${status}`);
                this.serviceGateway.pushStatus(idx, status);
                void this.serviceLifecycleService.updateServiceStatus(idx, status).catch((e: unknown) => log(e));
              } else if (event === 'service-log' && typeof p.log === 'string') {
                log(`[TunnelService] emit service-log  | serviceIndex=${idx} | ${p.log}`);
                this.serviceGateway.pushLog(idx, p.log, p.timestamp ?? new Date().toISOString());
              }
            },
          );
          break;
        case COMMAND.REDEPLOY:
          log(`[TunnelService] REDEPLOY | serviceIndex=${payload.serviceIndex} | name=${payload.serviceName}`);
          response = await this.serviceLifecycleService.v1RedeployService(
            {
              apiKey: '',
              serviceIndex: payload.serviceIndex,
              deployPreset: payload.deployPreset,
              serviceName: payload.serviceName,
              servicePort: payload.servicePort,
              sourceUrl: payload.sourceUrl,
              serviceVersion: payload.serviceVersion,
              env: payload.env,
            },
            (event: string, emitPayload: unknown) => {
              this.socket.emit(event, emitPayload);
              const p = emitPayload as { serviceIndex: number; status?: string; log?: string; timestamp?: string };
              const idx: number = p.serviceIndex;
              if (event === 'service-status' && typeof p.status === 'string') {
                this.serviceGateway.pushStatus(idx, p.status);
                void this.serviceLifecycleService.updateServiceStatus(idx, p.status).catch((e: unknown) => log(e));
              } else if (event === 'service-log' && typeof p.log === 'string') {
                this.serviceGateway.pushLog(idx, p.log, p.timestamp ?? new Date().toISOString());
              }
            },
          );
          break;
        case COMMAND.START: {
          const startIdx = Number(payload.serviceIndex);
          log(`[TunnelService] START | serviceIndex=${startIdx} | name=${payload.serviceName}`);
          await this.serviceLifecycleService.v1StartService(
            payload.serviceName,
            payload.deployPreset,
            (event: string, emitPayload: unknown) => {
              const p = emitPayload as { serviceName: string; status?: string; log?: string; timestamp?: string };
              if (event === 'service-status' && typeof p.status === 'string') {
                this.socket.emit(event, { serviceIndex: startIdx, status: p.status });
                this.serviceGateway.pushStatus(startIdx, p.status);
                void this.serviceLifecycleService.updateServiceStatus(startIdx, p.status);
              } else if (event === 'service-log' && typeof p.log === 'string') {
                this.socket.emit(event, { serviceIndex: startIdx, log: p.log, timestamp: p.timestamp ?? new Date().toISOString() });
                this.serviceGateway.pushLog(startIdx, p.log, p.timestamp ?? new Date().toISOString());
              }
            },
          );
          break;
        }
        case COMMAND.STOP: {
          const stopIdx = Number(payload.serviceIndex);
          log(`[TunnelService] STOP | serviceIndex=${stopIdx} | name=${payload.serviceName}`);
          await this.serviceLifecycleService.v1StopService(
            payload.serviceName,
            payload.deployPreset,
            (event: string, emitPayload: unknown) => {
              const p = emitPayload as { serviceName: string; status?: string; log?: string; timestamp?: string };
              if (event === 'service-status' && typeof p.status === 'string') {
                this.socket.emit(event, { serviceIndex: stopIdx, status: p.status });
                this.serviceGateway.pushStatus(stopIdx, p.status);
                void this.serviceLifecycleService.updateServiceStatus(stopIdx, p.status);
              } else if (event === 'service-log' && typeof p.log === 'string') {
                this.socket.emit(event, { serviceIndex: stopIdx, log: p.log, timestamp: p.timestamp ?? new Date().toISOString() });
                this.serviceGateway.pushLog(stopIdx, p.log, p.timestamp ?? new Date().toISOString());
              }
            },
          );
          break;
        }
        case COMMAND.ABORT:
          break;
        case COMMAND.DELETE: {
          const deleteIdx = Number(payload.serviceIndex);
          log(`[TunnelService] DELETE | serviceIndex=${deleteIdx} | name=${payload.serviceName}`);
          await this.serviceLifecycleService.v1DeleteService(
            payload.serviceName,
            deleteIdx,
            payload.deployPreset,
            (event: string, emitPayload: unknown) => {
              const p = emitPayload as { serviceName: string; status?: string; log?: string; timestamp?: string };
              if (event === 'service-status' && typeof p.status === 'string') {
                this.socket.emit(event, { serviceIndex: deleteIdx, status: p.status });
                this.serviceGateway.pushStatus(deleteIdx, p.status);
              } else if (event === 'service-log' && typeof p.log === 'string') {
                this.socket.emit(event, { serviceIndex: deleteIdx, log: p.log, timestamp: p.timestamp ?? new Date().toISOString() });
                this.serviceGateway.pushLog(deleteIdx, p.log, p.timestamp ?? new Date().toISOString());
              }
            },
          );
          break;
        }
        case COMMAND.DISCONNECT:
          this.socket.disconnect();
          break;
        case COMMAND.STREAM_LOG: {
          const streamIdx: number = Number(payload.serviceIndex);
          const streamName: string = String(payload.serviceName);
          log(`[TunnelService] STREAM_LOG | serviceIndex=${streamIdx} | name=${streamName}`);
          await this.serviceLifecycleService.streamServiceLog(
            streamIdx,
            streamName,
            payload.deployPreset,
            (line: string) => this.socket.emit('service-log', { serviceIndex: streamIdx, log: line, timestamp: new Date().toISOString() }),
          );
          break;
        }
        case COMMAND.STOP_LOG: {
          const stopName: string = String(payload.serviceName);
          log(`[TunnelService] STOP_LOG | name=${stopName}`);
          this.serviceLifecycleService.stopServiceLog(stopName);
          break;
        }
      }

      this.socket.emit('response', response);
    });

    this.socket.on('connect-request', async (payload: ConnectRequestPayload) => {
      await this.notifyService.savePendingRequest(payload);
      this.notifyGateway.pushConnectRequest(payload);
      log(`Connect Request Received from Hub.\n → Workspace: ${payload.workspaceName}`);
    });

    this.socket.on('reverse-proxy', async (payload: RouteRequest) => {
      const response = await this.serviceLifecycleService.fetchJSON(payload);
      this.socket.emit('response', response);
    });
  }

  onModuleDestroy() {
    this.socket?.disconnect();
  }
}
