import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import net from 'net';
import log from "spectra-log";


@Injectable()
export class ReverseTunnelService {
  hubUrl: string;
  constructor(
    private readonly configService: ConfigService,
  ) { 
    this.hubUrl = new URL(configService.getOrThrow<string>('HUB_TUNNEL_URL')).hostname;
  };

  open(payload: { servicePort: number, token: string, tunnelPort: number }) {
    const tunnelSocket = net.connect(payload.tunnelPort, this.hubUrl);
    tunnelSocket.write(payload.token + '\n');

    const localSocket = net.connect(payload.servicePort, 'host.docker.internal');

    tunnelSocket.pipe(localSocket);
    localSocket.pipe(tunnelSocket);

    tunnelSocket.once('close', () => localSocket.destroy());
    localSocket.once('close', () => tunnelSocket.destroy());
    tunnelSocket.on('error', (error) => log(error));
    localSocket.on('error', (error) => log(error));
  }
}