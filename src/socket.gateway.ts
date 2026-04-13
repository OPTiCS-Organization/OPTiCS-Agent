import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Injectable } from '@nestjs/common';
import log from 'spectra-log';
import { Socket } from 'socket.io-client';

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

@Injectable()
@WebSocketGateway({
  namespace: '/info',
  cors: { origin: true, credentials: true },
})
export class InfoGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor (
    private server: Socket,
  ) { };

  handleConnection(client: Socket) {
    log(`Client connected\n  Client ID → ${client.id}`)
  }

  handleDisconnect(client: Socket) {
    log(`Client disconnected\n  Client ID → ${client.id}`)
  }

  sendData(data: { cpu: CpuData; memory: MemoryData }) {
    this.server.emit('info', data);
  }
}