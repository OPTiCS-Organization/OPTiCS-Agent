import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { Client, ClientChannel, ConnectConfig } from 'ssh2';

type TerminalCallbacks = {
  onReady: () => void;
  onData: (data: string) => void;
  onClose: (reason?: string) => void;
};

type TerminalSession = {
  client: Client;
  stream?: ClientChannel;
  callbacks: TerminalCallbacks;
};

@Injectable()
export class SshTerminalService implements OnModuleDestroy {
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(private readonly configService: ConfigService) {}

  open(
    sessionId: string,
    size: { cols: number; rows: number },
    callbacks: TerminalCallbacks,
  ) {
    if (this.sessions.has(sessionId)) {
      callbacks.onClose('Terminal session already exists.');
      return;
    }

    let connectConfig: ConnectConfig;
    try {
      connectConfig = this.createConnectConfig();
    } catch (error) {
      callbacks.onClose(error instanceof Error ? error.message : 'Invalid SSH configuration.');
      return;
    }

    const client = new Client();
    this.sessions.set(sessionId, { client, callbacks });

    client.once('ready', () => {
      client.shell({
        term: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
      }, (error, stream) => {
        if (error) {
          this.finish(sessionId, error.message);
          return;
        }

        const session = this.sessions.get(sessionId);
        if (!session) {
          stream.close();
          return;
        }

        session.stream = stream;
        stream.on('data', (data: Buffer) => callbacks.onData(data.toString()));
        stream.stderr.on('data', (data: Buffer) => callbacks.onData(data.toString()));
        stream.once('close', () => this.finish(sessionId));
        callbacks.onReady();
      });
    });
    client.once('error', (error) => this.finish(sessionId, error.message));
    client.once('close', () => this.finish(sessionId));
    client.connect(connectConfig);
  }

  write(sessionId: string, data: string) {
    this.sessions.get(sessionId)?.stream?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number) {
    this.sessions.get(sessionId)?.stream?.setWindow(rows, cols, 0, 0);
  }

  close(sessionId: string) {
    this.finish(sessionId);
  }

  onModuleDestroy() {
    for (const sessionId of [...this.sessions.keys()]) this.finish(sessionId);
  }

  private createConnectConfig(): ConnectConfig {
    const username = this.configService.get<string>('HOST_SSH_USERNAME');
    if (!username) throw new Error('HOST_SSH_USERNAME is not configured.');

    const privateKeyPath = this.configService.get<string>('HOST_SSH_PRIVATE_KEY_PATH');
    const password = this.configService.get<string>('HOST_SSH_PASSWORD');
    if (!privateKeyPath && !password) {
      throw new Error('HOST_SSH_PRIVATE_KEY_PATH or HOST_SSH_PASSWORD is required.');
    }

    const expectedHostHash = this.configService.get<string>('HOST_SSH_HOST_HASH');
    return {
      host: this.configService.get<string>('HOST_SSH_HOST') ?? 'host.docker.internal',
      port: Number(this.configService.get<string>('HOST_SSH_PORT') ?? 22),
      username,
      privateKey: privateKeyPath ? readFileSync(privateKeyPath) : undefined,
      passphrase: this.configService.get<string>('HOST_SSH_PRIVATE_KEY_PASSPHRASE'),
      password,
      readyTimeout: 10_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 2,
      hostHash: expectedHostHash ? 'sha256' : undefined,
      hostVerifier: expectedHostHash ? (hash) => hash === expectedHostHash : undefined,
      algorithms: expectedHostHash ? { serverHostKey: ['ssh-ed25519'] } : undefined,
    };
  }

  private finish(sessionId: string, reason?: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.stream?.close();
    session.client.end();
    session.callbacks.onClose(reason);
  }
}
