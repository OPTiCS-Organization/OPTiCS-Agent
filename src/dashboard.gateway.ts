import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketServer,
} from '@nestjs/websockets';
import { Injectable } from '@nestjs/common';
import log from 'spectra-log';
import { Server, Socket } from 'socket.io';

interface CpuMetric {
  timestamp: number;
  peak: number;
  average: number;
  min: number;
}

interface MemoryMetric {
  timestamp: number;
  peak: number;
  average: number;
  min: number;
  totalMemory: number;
}

@Injectable()
@WebSocketGateway({
  namespace: '/info',
  cors: { origin: true, credentials: true },
})
export class DashboardGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Server;

  handleConnection(client: Socket) {
    log(`Agent Dashboard Connected.\n  {{ bold : dim : Dashboard ID: ${client.id} }}`)
  }

  handleDisconnect(client: Socket) {
    log(`Agent Dashboard Disconnected.\n  {{ bold : dim : Dashboard ID: ${client.id} }}`)
  }

  sendMetric(metric: { cpu: CpuMetric; memory: MemoryMetric }) {
    this.server.emit('info', metric);
  }
}