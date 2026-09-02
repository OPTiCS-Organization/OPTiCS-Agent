import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Docker from "dockerode";
import log from "spectra-log";
import { DockerStatusEvent, StatusEmit } from "./types/DockerStatusEvent.type";

@Injectable()
export class DockerEventService implements OnModuleInit {
  private docker: Docker;
  private statusEmit: StatusEmit | null = null;

  constructor(
    private readonly configService: ConfigService,
  ) {
    this.docker = new Docker({
      socketPath: '/var/run/docker.sock'
    });
  }

  // 도커 이벤트를 받아 갈 콜백을 등록한다.
  // 상위 계층이 소켓을 몰라도 상태 변화를 Hub로 보낼 수 있게 하는 연결점이다.
  registerStatusEmit(fn: StatusEmit) {
    this.statusEmit = fn;
  }

  // 에이전트가 뜰 때 도커 이벤트 소켓을 구독한다.
  // 사용자가 CLI로 직접 컨테이너를 만져도 대시보드 상태가 따라가게 하는 장치다.
  onModuleInit() {
    this.docker.getEvents({}, (err, stream) => {
      if (err || !stream) {
        log(`[DockerEventService] Failed to subscribe to Docker events: ${String(err)}`, 500, 'ERROR');
        return;
      }
      stream.on('data', (chunk: Buffer) => {
        try {
          const event = JSON.parse(chunk.toString()) as {
            Type: string;
            Action: string;
            time?: number;
            timeNano?: number;
            Actor: { Attributes: Record<string, string> };
          };
          if (event.Type !== 'container') return;
          if (!this.statusEmit) return;

          const parsed = this.toStatusEvent(event);
          if (parsed) void this.statusEmit(parsed);
        } catch {
          // JSON 파싱 실패 무시
        }
      });
    });
  }

  // 도커 이벤트 한 건을 OPTiCS의 상태 이벤트로 환산한다.
  // 관심 없는 action이면 null을 돌려 호출부가 그냥 건너뛰게 한다.
  private toStatusEvent(event: {
    Action: string;
    time?: number;
    timeNano?: number;
    Actor: { Attributes: Record<string, string> };
  }): DockerStatusEvent | null {
    const containerName = event.Actor.Attributes['name'] ?? '';
    const action = event.Action;
    const timestamp = event.timeNano
      ? new Date(Math.floor(event.timeNano / 1_000_000)).toISOString()
      : new Date(event.time ? event.time * 1000 : Date.now()).toISOString();

    switch (action) {
      case 'die':
      case 'stop':
      case 'kill': {
        const exitCode = event.Actor.Attributes['exitCode'] ?? '0';
        const status = exitCode !== '0' ? 'failed' : 'stopped';
        log(`[DockerEventService] Stopping Container '${containerName}'...\nExit Code: ${exitCode}\nExit State: ${status}`);
        return { status, containerName, timestamp, action, exitCode };
      }
      case 'create':
        return { status: 'starting', containerName, timestamp, action };
      case 'start':
        log(`[DockerEventService] Starting Container '${containerName}'...`);
        return { status: 'running', containerName, timestamp, action };
      case 'restart':
        log(`[DockerEventService] Restarting Container '${containerName}'...`);
        return { status: 'restarting', containerName, timestamp, action };
      case 'destroy':
        log(`[DockerEventService] Removing Container '${containerName}'...`);
        return { status: 'removed', containerName, timestamp, action };
      default:
        return null;
    }
  }
}
