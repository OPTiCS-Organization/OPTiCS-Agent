import { WebSocketGateway, WebSocketServer, OnGatewayConnection } from '@nestjs/websockets';
import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';
import { ConnectRequestPayload } from './notify.service';

@Injectable()
@WebSocketGateway({ namespace: '/notification', cors: { origin: true, credentials: true } })
export class NotifyGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  handleConnection() {}

  pushConnectRequest(payload: ConnectRequestPayload) {
    this.server.emit('notification', payload);
  }
}
