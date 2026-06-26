import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';

type ServiceLogMeta = {
  source?: 'hub' | 'agent' | 'runtime';
  stream?: 'deploy' | 'lifecycle' | 'runtime';
  containerName?: string;
  composeService?: string;
  stderr?: boolean;
};

@Injectable()
@WebSocketGateway({ namespace: '/service', cors: { origin: true, credentials: true } })
export class ServiceGateway {
  @WebSocketServer()
  server!: Server;

  /**
   * 컨테이너 상태 푸시
   */
  pushStatus(serviceIndex: number, status: string) {
    this.server.emit('service-status', { serviceIndex, status });
  }

  /**
   * 컨테이너 런타임 로그 푸시
   */
  pushLog(serviceIndex: number, line: string, timestamp: string, meta: ServiceLogMeta = {}) {
    this.server.emit('service-log', { serviceIndex, log: line, timestamp, ...meta });
  }
}
