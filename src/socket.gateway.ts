import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import log from 'spectra-log';
import { NotificationEnum } from './notify/enums/NotificationTypes.enum';
import { NotifyService } from './notify/notify.service';

interface CpuData {
  timestamp: number;
  peak: number;
  average: number;
  min: number;
}

interface MemoryData {
  timestamp: number;
  peak: number;
  average: number;
  min: number;
  totalMemory: number;
}

function corsOrigins(): string[] {
  return (process.env.CORS_ORIGIN ?? '').split(',').map(o => o.trim()).filter(Boolean);
}

@Injectable()
@WebSocketGateway({
  namespace: '/info',
  cors: { origin: corsOrigins(), credentials: true },
})
export class InfoGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    log(`Client disconnected: ${client.id}`);
  }

  sendData(data: { cpu: CpuData; memory: MemoryData }) {
    this.server.emit('info', data);
  }
}

@Injectable()
@WebSocketGateway({
  namespace: '/notification',
  cors: { origin: corsOrigins(), credentials: true },
})
export class NotificationGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor (
    @Inject(forwardRef(() => NotifyService))
    private readonly notifyService: NotifyService,
  ) { };

  @WebSocketServer()
  server: Server;

  @SubscribeMessage('connect-response')
  async response(client: Socket, payload: { respond: boolean }) {
    await this.notifyService.responseConnectRequest(payload.respond);
  }

  handleConnection(client: Socket) {
    log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    log(`Client disconnected: ${client.id}`);
  }

  sendNotification(workspaceOwner: string, workspaceName: string, requestTimestamp: Date, type: NotificationEnum) {
    this.server.emit('notification', { workspaceOwner, workspaceName, requestTimestamp, type });
  }
}
