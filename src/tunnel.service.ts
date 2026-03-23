import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import log from 'spectra-log';
import { Command } from './global/types/Command.dto';
import { RouteRequest } from './global/types/RouteRequest.dto';
import { ServiceLifecycleService } from './service/service-lifecycle.service';
import { COMMAND } from './global/Command.enum';
import { PrismaService } from './share/prisma.service';
import { NotifyService } from './notify/notify.service';
import type { ConnectRequestPayload } from './notify/notify.service';
import { NotifyGateway } from './notify/notify.gateway';

@Injectable()
export class TunnelService implements OnModuleInit, OnModuleDestroy {
  private socket: Socket;

  constructor(
    private readonly serviceLifecycleService: ServiceLifecycleService,
    private readonly prismaService: PrismaService,
    private readonly notifyService: NotifyService,
    private readonly notifyGateway: NotifyGateway,
  ) { }

  async onModuleInit() {
    const hubUrl = process.env.HUB_URL ?? 'http://localhost:3000';

    const agentCodeRow = await this.prismaService.agentInfo.findUnique({ where: { key: 'agent-code' } });

    this.socket = io(`${hubUrl}/agent`, {
      reconnection: true,
      reconnectionDelay: 3000,
      auth: { agentCode: agentCodeRow?.value ?? null },
    });

    this.socket.on('connect', () => {
      log(`{{ green : bold : Socket Connection Established with Hub. }}\n {{ dim : bold : → Socket ID: ${this.socket.id} }}`);
    });

    this.socket.on('connected', async (payload: { agentCode: string }) => {
      await this.prismaService.agentInfo.upsert({
        where: { key: 'agent-code' },
        create: { key: 'agent-code', value: payload.agentCode },
        update: { value: payload.agentCode },
      });
      log(`Agent Code Received from Hub.\n → Agent Code: ${payload.agentCode}`);
    });

    this.socket.on('disconnect', () => {
      log('{{ bold : red : Socket Connection Lost with Hub. }}');
    });

    this.socket.on('command', async (payload: Command) => {
      log(`Command Received From Hub.\nCOMMAND: ${payload.command}`);
      let response = {};

      switch (payload.command) {
        case COMMAND.DEPLOY:
          response = await this.serviceLifecycleService.v1DeployService({
            apiKey: '',
            deployPreset: payload.deployPreset,
            serviceName: payload.serviceName,
            servicePort: payload.servicePort,
            sourceUrl: payload.sourceUrl,
            serviceVersion: payload.serviceVersion,
          });
          break;
        case COMMAND.STOP:
          break;
        case COMMAND.ABORT:
          break;
        case COMMAND.DELETE:
          break;
        case COMMAND.DISCONNECT:
          this.socket.disconnect();
          break;
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
