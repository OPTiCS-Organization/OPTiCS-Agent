import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';

@Injectable()
@WebSocketGateway({ namespace: '/service', cors: { origin: true, credentials: true } })
export class ServiceGateway {
  @WebSocketServer()
  server: Server;

  pushStatus(serviceIndex: number, status: string) {
    this.server.emit('service-status', { serviceIndex, status });
  }

  pushLog(serviceIndex: number, line: string, timestamp: string) {
    this.server.emit('service-log', { serviceIndex, log: line, timestamp });
  }
}
