import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import log from 'spectra-log';
import { Command } from '../global/types/Command.dto';
import { RouteRequest } from '../global/types/RouteRequest.dto';
import { PROTOCOL_VERSION } from '../global/protocol';
import { AGENT_VERSION } from '../global/agent-version';
import { AppService } from '../app.service';
import { ServiceLifecycleService } from '../service/service-lifecycle.service';
import { ServiceGateway } from '../service/service.gateway';
import { COMMAND } from '../global/Command.enum';
import { PrismaService } from '../share/prisma.service';
import { NotifyService } from '../notify/notify.service';
import type { ConnectRequestPayload } from '../notify/notify.service';
import { NotifyGateway } from '../notify/notify.gateway';
import { ConfigService } from '@nestjs/config';
import { ReverseTunnelService } from './reverse-tunnel.service';
import { SystemMetricsUtility } from '../utility/systemMetric.util';
import { createSocketEmitter, type HubEmitter } from '../utility/createSocketEmitter.util';
import { createSocketListener, type HubListener } from '../utility/createSocketListener.util';
import { SshTerminalService } from '../terminal/ssh-terminal.service';
import { ContainerLifeCycleService } from '../docker/container-lifecycle.service';
import { RegisterPayload } from '../interfaces/register-payload.interface';

type ServiceLogPayload = {
  serviceIndex?: number;
  serviceName?: string;
  log?: string;
  timestamp?: string;
  source?: 'hub' | 'agent' | 'runtime';
  stream?: 'deploy' | 'lifecycle' | 'runtime';
  containerName?: string;
  composeService?: string;
  stderr?: boolean;
};

/**
 * 리팩터링 필요...
 */

@Injectable()
export class TunnelService implements OnModuleInit, OnModuleDestroy {
  private socket!: Socket;
  private agentUuid: string | null = null;
  private hubUrl: string;

  /**
   * Hub가 발급한 HMAC 서명 비밀. 등록 전이거나 아직 발급받지 못했으면 null이다.
   *
   * 로컬 DB가 진실이지만 emit마다 조회하면 매 로그 한 줄에 쿼리가 하나씩 붙으므로
   * 메모리에 들고 있다가 register 응답에서 재발급될 때만 갱신한다.
   */
  private signingSecret: string | null = null;

  /**
   * Hub로 나가는 유일한 발신 통로. 페이로드에 서명을 자동으로 붙인다.
   *
   * `this.socket.emit`을 직접 쓰면 서명이 빠진 이벤트가 생기고, 그런 통로가 하나라도
   * 있으면 Hub가 미서명 이벤트를 계속 허용해야 해서 서명 도입이 무의미해진다.
   */
  private emitToHub!: HubEmitter;

  /**
   * Hub에서 들어오는 이벤트를 받는 유일한 통로. 서명을 검증한 뒤에만 핸들러를 부른다.
   *
   * `this.socket.on`을 직접 쓰면 그 이벤트만 검증을 건너뛴다. Agent에게 `command`는
   * 원격 코드 실행이므로, 검증을 우회하는 리스너 하나가 곧 원격 실행 구멍이 된다.
   */
  private onFromHub!: HubListener;

  constructor(
    private readonly serviceLifecycleService: ServiceLifecycleService,
    private readonly serviceGateway: ServiceGateway,
    private readonly prismaService: PrismaService,
    private readonly notifyService: NotifyService,
    private readonly notifyGateway: NotifyGateway,
    private readonly reverseTunnelService: ReverseTunnelService,
    private readonly systemMetricsUtility: SystemMetricsUtility,
    private readonly sshTerminalService: SshTerminalService,
    private readonly containerLifeCycleService: ContainerLifeCycleService,
    private readonly configService: ConfigService,
    private readonly appService: AppService,
  ) {
    this.hubUrl = `${configService.getOrThrow<string>('HUB_API_URL')}`;
  }

  private getServiceCommandPayload(payload: Command) {
    const serviceIndex = Number(payload.serviceIndex);
    const serviceName = typeof payload.serviceName === 'string' ? payload.serviceName : '';
    const deployPreset = payload.deployPreset;
    if (!Number.isInteger(serviceIndex) || serviceIndex < 1 || !serviceName || !deployPreset) {
      log(`[TunnelService] {{ red : bold : CMD:INVALID }}\n  Command       : ${payload.command}\n  Service Index : ${payload.serviceIndex ?? '-'}\n  Service Name  : ${payload.serviceName ?? '-'}\n  Preset        : ${payload.deployPreset ?? '-'}`);
      return null;
    }
    return { serviceIndex, serviceName, deployPreset };
  }

  private logMeta(payload: ServiceLogPayload) {
    return {
      source: payload.source,
      stream: payload.stream,
      containerName: payload.containerName,
      composeService: payload.composeService,
      stderr: payload.stderr,
    };
  }

  /*
   * 서비스에서 출력되는 로그를 Hub로 전송
   */
  private emitServiceLog(serviceIndex: number, payload: ServiceLogPayload, forwardToHub = true) {
    if (typeof payload.log !== 'string') return;

    const timestamp = payload.timestamp ?? new Date().toISOString();
    const meta = this.logMeta(payload);
    if (forwardToHub) {
      this.emitToHub('service-log', { serviceIndex, log: payload.log, timestamp, ...meta });
    }
    log(`[TunnelService] {{ blue : bold : EVENT:LOG }}\n  Service Index : ${serviceIndex}\n  Timestamp     : ${timestamp}\n  Source        : ${payload.source ?? '-'}\n  Stream        : ${payload.stream ?? '-'}\n  Container     : ${payload.containerName ?? payload.composeService ?? '-'}\n  Log           : ${payload.log}`);
    this.serviceGateway.pushLog(serviceIndex, payload.log, timestamp, meta);
  }

  async onModuleInit() {
    /* 이미 서버에서 받아온 UUID가 있는지 조회 */
    this.agentUuid = await this.prismaService.agentInfo.findUnique({ where: { key: 'agent-uuid' } }).then(result => result?.value ?? null)
    log(`[Tunnel Service] {{ yellow : bold : UUID${this.agentUuid ? `_FOUND}}:{{ dim : italic : ${this.agentUuid} }}` : "_NOT_FOUND}}"}`);

    /* 이전 등록에서 받아둔 서명 비밀이 있는지 조회 */
    this.signingSecret = await this.prismaService.agentInfo.findUnique({ where: { key: 'agent-signing-secret' } }).then(result => result?.value ?? null)
    log(`[Tunnel Service] {{ yellow : bold : SIGNING_SECRET_${this.signingSecret ? 'FOUND' : 'NOT_FOUND'} }}`);

    log(`[Tunnel Service] Connecting to Hub: ${this.hubUrl}`)
    this.socket = io(`${this.hubUrl}/agent`, {
      reconnection: true,
      reconnectionDelay: 3000,
      auth: { agentUuid: this.agentUuid },
    });

    /**
     * 비밀을 값이 아니라 콜백으로 넘긴다.
     *
     * 여기는 register 응답을 받기 전이라 최초 실행에서는 비밀이 null이다.
     * 값을 굳혀 넘기면 발급 이후에도 계속 null인 채로 서명 없이 나간다.
     */
    this.emitToHub = createSocketEmitter(this.socket, () => this.signingSecret);
    this.onFromHub = createSocketListener(this.socket, () => this.signingSecret);

    /**
     * 서비스 라이프사이클 코드가 소켓 객체를 직접 몰라도 Hub에 emit할 수 있게 연결
     */
    (this.serviceLifecycleService.registerHubEmit as (fn: (event: string, payload: object) => void) => void)((event, payload) => {
      this.emitToHub(event, payload);
    });

    /**
     * 허브와 소켓이 연결되면 연결 이벤트 발생, UUID를 같이 전송함.
     * 프로토콜 버전에 대한 문서는 OPTiCS-Hub/docs/protocol_v1.md 계약을 참조하십시오.
    */
    this.onFromHub('connect', () => {
      log(`[Tunnel Service] Connection established with Hub.`);
      log(`[Tunnel Service] Sending registration information. (Protocol v${PROTOCOL_VERSION})`);
      /* _sig는 emitToHub가 붙인다. 최초 등록처럼 비밀이 없으면 서명 없이 나간다. */
      this.emitToHub('register', { agentUuid: this.agentUuid ?? null, agentVersion: AGENT_VERSION, protocolVersion: PROTOCOL_VERSION });
    });
    /*
      허브에서 전송받은 UUID가 NULL이면 새 UUID, Code를 발급해서 register 이벤트를 발생시킴.
      전송받은 UUID가 없으면? => 아마 아무 이벤트를 발생시키지 않는 듯
    */
    this.onFromHub('register', async (payload: RegisterPayload) => {
      log(`[Tunnel Service] {{ yellow : bold : REGISTER:RESPONSE_RECEIVED }}\n  state: ${payload.code}`);
      if (payload.code === 'ok') {
        log(`[Tunnel Service] {{ cyan : bold : REGISTER:AUTHORIZED }}\n  code: ${payload.data.code}\n  uuid: ${payload.data.uuid}\n  ipv4 address: ${payload.data.ip}`);
        if (this.agentUuid !== payload.data.uuid) {
          this.agentUuid = payload.data.uuid;
          await this.prismaService.agentInfo.upsert({
            where: { key: 'agent-uuid' },
            create: { key: 'agent-uuid', value: payload.data.uuid },
            update: { value: payload.data.uuid }
          });
          log(`[Tunnel Service] {{ yellow : bold : REGISTER:UUID_UPDATED }}\n  updated uuid: ${this.agentUuid}`);
        }

        /**
         * 비밀은 신규 발급 시에만 응답에 실린다. 기존 Agent의 재등록 응답은
         * signingSecret이 null이므로, 그때 덮어쓰면 들고 있던 비밀을 지우게 된다.
         */
        if (payload.data.signingSecret) {
          this.signingSecret = payload.data.signingSecret;
          await this.prismaService.agentInfo.upsert({
            where: { key: 'agent-signing-secret' },
            create: { key: 'agent-signing-secret', value: payload.data.signingSecret },
            update: { value: payload.data.signingSecret }
          });
          /* 비밀 자체는 로그에 남기지 않는다. 로그를 읽을 수 있는 사람이 곧 서명할 수 있는 사람이 된다. */
          log(`[Tunnel Service] {{ yellow : bold : REGISTER:SIGNING_SECRET_SAVED }}`)
        }

        await this.prismaService.agentInfo.upsert({
          where: { key: 'agent-code' },
          create: { key: 'agent-code', value: payload.data.code },
          update: { value: payload.data.code },
        });
        log(`[Tunnel Service] {{ yellow : bold : REGISTER:CODE_UPDATED }}\n  updated code: ${payload.data.code}`);

        await this.prismaService.agentInfo.upsert({
          where: { key: 'agent-ip' },
          create: { key: 'agent-ip', value: payload.data.ip },
          update: { value: payload.data.ip }
        });
        log(`[Tunnel Service] {{ yellow : bold : REGISTER:IP_UPDATED }}\n  updated ip: ${payload.data.ip}`);

        log(`[Tunnel Service] {{ green : bold : REGISTER:SYNCED }}\n  Successfully saved connection informations.`);

        log(`[Tunnel Service] {{ cyan : bold : PRECONN:INITIALIZING }}`)
        this.reverseTunnelService.initPreconnectPool(this.agentUuid, () => this.signingSecret);
      }

      /**
       * 아래 실패들은 재시도로 풀리지 않는다. 사람이 개입해야 해소되는 상태이므로 3초 간격 재연결을 멈춘다.
       */
      if (payload.code === 'deprecated_protocol_version') {
        this.socket.io.reconnection(false);
        log(`[Tunnel Service] {{ red : bold : REGISTER:PROTOCOL_TOO_OLD }}\n  This agent is older than the OPTiCS Hub supports.\n    Hub protocol version: v${payload.data.minimum}(MIN) v${payload.data.maximum}(MAX)\n    Current protocol version: v${PROTOCOL_VERSION}\n  Update this agent. No further reconnection attempts will be made.`, 400, 'FATAL');
      }

      if (payload.code === 'unknown_protocol_version') {
        this.socket.io.reconnection(false);
        log(`[Tunnel Service] {{ red : bold : REGISTER:PROTOCOL_TOO_NEW }}\n  This agent is newer than the OPTiCS Hub supports.\n    Hub protocol version: v${payload.data.minimum}(MIN) v${payload.data.maximum}(MAX)\n    Current protocol version: v${PROTOCOL_VERSION}\n  The Hub must be updated. No further reconnection attempts will be made.`, 400, 'FATAL');
      }

      /**
       * 저장된 비밀이 Hub의 것과 다르다. 같은 비밀로 다시 붙어봐야 결과가 같으므로 멈춘다.
       * 비밀을 여기서 지우고 새 Agent로 등록하는 선택지도 있지만, 그러면 사칭 시도 한 번으로
       * 정상 Agent가 자기 신원을 버리게 만들 수 있어 사람의 판단에 맡긴다.
       */
      if (payload.code === 'invalid_signature') {
        this.socket.io.reconnection(false);
        log(`[Tunnel Service] {{ red : bold : REGISTER:INVALID_SIGNATURE }}\n  The Hub rejected this agent's signature.\n    reason: ${payload.data.reason}\n  The stored signing secret does not match the Hub's. Re-register this agent.\n  No further reconnection attempts will be made.`, 401, 'FATAL');
      }

      if (payload.code === 'registration_failed') {
        log(`[Tunnel Service] {{ red : bold : REGISTER:FAILED }}\n  reason: ${payload.data.reason}`, 500, 'ERROR');
      }
    })

    this.onFromHub('disconnect', () => {
      log(`[Tunnel Service] Connection to Hub were lost.\n  Reconnect: ${this.socket.io.reconnection() ? "Reconnecting..." : "Interrupted"}`);
    });

    this.onFromHub('system-metrics-request', (payload: { requestId: string }) => {
      this.emitToHub('system-metrics', {
        requestId: payload.requestId,
        metrics: this.systemMetricsUtility.getCurrentMetrics(),
      });
    });

    this.onFromHub('terminal-open', (payload: { sessionId: string; cols: number; rows: number }) => {
      this.sshTerminalService.open(
        payload.sessionId,
        { cols: payload.cols, rows: payload.rows },
        {
          onReady: () => this.emitToHub('terminal-ready', { sessionId: payload.sessionId }),
          onData: (data) => this.emitToHub('terminal-output', { sessionId: payload.sessionId, data }),
          onClose: (reason) => this.emitToHub('terminal-closed', { sessionId: payload.sessionId, reason }),
        },
      );
    });

    this.onFromHub('terminal-input', (payload: { sessionId: string; data: string }) => {
      if (typeof payload.data !== 'string' || Buffer.byteLength(payload.data) > 64 * 1024) return;
      this.sshTerminalService.write(payload.sessionId, payload.data);
    });

    this.onFromHub('terminal-resize', (payload: { sessionId: string; cols: number; rows: number }) => {
      this.sshTerminalService.resize(payload.sessionId, payload.cols, payload.rows);
    });

    this.onFromHub('terminal-close', (payload: { sessionId: string }) => {
      this.sshTerminalService.close(payload.sessionId);
    });

    this.onFromHub('command', async (payload: Command) => {
      log(`[TunnelService] {{ cyan : bold : CMD:START }}\n  Command       : ${payload.command}\n  Service Index : ${payload.serviceIndex ?? '-'}\n  Service Name  : ${payload.serviceName ?? '-'}\n  Preset        : ${payload.deployPreset ?? '-'}`);
      let response = {};

      switch (payload.command) {
        case COMMAND.DEPLOY:
          await this.serviceLifecycleService.createServiceSessionMarker(payload.serviceIndex, payload.serviceName, 'service-deploy');
          this.serviceLifecycleService.initContainerStates(payload.serviceIndex, payload.serviceName.toLowerCase(), payload.deployPreset);
          response = await this.serviceLifecycleService.v1DeployService(
            {
              apiKey: '',
              serviceIndex: payload.serviceIndex,
              deployPreset: payload.deployPreset,
              serviceName: payload.serviceName,
              servicePort: payload.servicePort,
              serviceHostPort: payload.serviceHostPort,
              serviceContainerPort: payload.serviceContainerPort,
              servicePortMappings: payload.servicePortMappings,
              sourceUrl: payload.sourceUrl,
              rootDirectory: payload.rootDirectory,
              serviceVersion: payload.serviceVersion,
              env: payload.env,
            },
            (event: string, emitPayload: unknown) => {
              this.emitToHub(event, emitPayload);
              const p = emitPayload as ServiceLogPayload & { serviceIndex: number; status?: string; containers?: unknown };
              const idx: number = p.serviceIndex;
              if (event === 'service-status' && typeof p.status === 'string') {
                const status: string = p.status;
                log(`[TunnelService] {{ cyan : bold : EVENT:STATUS }}\n  Service Index : ${idx}\n  Status        : ${status}`);
                this.serviceGateway.pushStatus(idx, status);
                void this.serviceLifecycleService.updateServiceStatus(idx, status).catch((e: unknown) => log(e));
              } else if (event === 'service-log') {
                this.emitServiceLog(idx, p, false);
              }
            },
          );
          break;
        case COMMAND.REDEPLOY:
          await this.serviceLifecycleService.createServiceSessionMarker(payload.serviceIndex, payload.serviceName, 'service-redeploy');
          this.serviceLifecycleService.initContainerStates(payload.serviceIndex, payload.serviceName.toLowerCase(), payload.deployPreset);
          response = await this.serviceLifecycleService.v1RedeployService(
            {
              apiKey: '',
              serviceIndex: payload.serviceIndex,
              deployPreset: payload.deployPreset,
              serviceName: payload.serviceName,
              servicePort: payload.servicePort,
              serviceHostPort: payload.serviceHostPort,
              serviceContainerPort: payload.serviceContainerPort,
              servicePortMappings: payload.servicePortMappings,
              sourceUrl: payload.sourceUrl,
              rootDirectory: payload.rootDirectory,
              serviceVersion: payload.serviceVersion,
              env: payload.env,
            },
            (event: string, emitPayload: unknown) => {
              this.emitToHub(event, emitPayload);
              const p = emitPayload as ServiceLogPayload & { serviceIndex: number; status?: string; containers?: unknown };
              const idx: number = p.serviceIndex;
              if (event === 'service-status' && typeof p.status === 'string') {
                log(`[TunnelService] {{ cyan : bold : EVENT:STATUS }}\n  Service Index : ${idx}\n  Status        : ${p.status}`);
                this.serviceGateway.pushStatus(idx, p.status);
                void this.serviceLifecycleService.updateServiceStatus(idx, p.status).catch((e: unknown) => log(e));
              } else if (event === 'service-log') {
                this.emitServiceLog(idx, p, false);
              }
            },
          );
          break;
        case COMMAND.START: {
          const commandPayload = this.getServiceCommandPayload(payload);
          if (!commandPayload) break;
          const { serviceIndex: startIdx, serviceName, deployPreset } = commandPayload;
          await this.serviceLifecycleService.createServiceSessionMarker(startIdx, serviceName, 'service-start');
          await this.serviceLifecycleService.syncContainerStatus(startIdx, serviceName, deployPreset);
          await this.serviceLifecycleService.v1StartService(
            startIdx,
            serviceName,
            deployPreset,
            (event: string, emitPayload: unknown) => {
              const p = emitPayload as ServiceLogPayload & { status?: string };
              if (event === 'service-status' && typeof p.status === 'string') {
                this.emitToHub(event, { serviceIndex: startIdx, status: p.status });
                log(`[TunnelService] {{ cyan : bold : EVENT:STATUS }}\n  Service Index : ${startIdx}\n  Status        : ${p.status}`);
                this.serviceGateway.pushStatus(startIdx, p.status);
                void this.serviceLifecycleService.updateServiceStatus(startIdx, p.status);
              } else if (event === 'service-log') {
                this.emitServiceLog(startIdx, p);
              }
            },
          );
          await this.serviceLifecycleService.syncContainerStatus(startIdx, serviceName, deployPreset, 'starting');
          break;
        }
        case COMMAND.STOP: {
          const commandPayload = this.getServiceCommandPayload(payload);
          if (!commandPayload) break;
          const { serviceIndex: stopIdx, serviceName, deployPreset } = commandPayload;
          await this.serviceLifecycleService.syncContainerStatus(stopIdx, serviceName, deployPreset);
          await this.serviceLifecycleService.v1StopService(
            stopIdx,
            serviceName,
            deployPreset,
            (event: string, emitPayload: unknown) => {
              const p = emitPayload as ServiceLogPayload & { status?: string };
              if (event === 'service-status' && typeof p.status === 'string') {
                this.emitToHub(event, { serviceIndex: stopIdx, status: p.status });
                log(`[TunnelService] {{ cyan : bold : EVENT:STATUS }}\n  Service Index : ${stopIdx}\n  Status        : ${p.status}`);
                this.serviceGateway.pushStatus(stopIdx, p.status);
                void this.serviceLifecycleService.updateServiceStatus(stopIdx, p.status);
              } else if (event === 'service-log') {
                this.emitServiceLog(stopIdx, p);
              }
            },
          );
          await this.serviceLifecycleService.syncContainerStatus(stopIdx, serviceName, deployPreset);
          break;
        }
        case COMMAND.CONTAINER_START: {
          const commandPayload = this.getServiceCommandPayload(payload);
          if (!commandPayload) break;
          const { serviceIndex: serviceIdx, serviceName, deployPreset } = commandPayload;
          const containerName = String(payload.containerName ?? '');
          if (!containerName) break;
          await this.serviceLifecycleService.syncContainerStatus(serviceIdx, serviceName, deployPreset);
          await this.containerLifeCycleService.startContainer(
            serviceIdx,
            containerName,
            deployPreset,
            (event: string, emitPayload: unknown) => {
              const p = emitPayload as ServiceLogPayload & { status?: string };
              if (event === 'service-status' && typeof p.status === 'string') {
                this.emitToHub(event, { serviceIndex: serviceIdx, status: p.status });
                log(`[TunnelService] {{ cyan : bold : EVENT:STATUS }}\n  Service Index : ${serviceIdx}\n  Status        : ${p.status}`);
                this.serviceGateway.pushStatus(serviceIdx, p.status);
                void this.serviceLifecycleService.updateServiceStatus(serviceIdx, p.status);
              } else if (event === 'service-log') {
                this.emitServiceLog(serviceIdx, p);
              }
            },
          );
          await this.serviceLifecycleService.syncContainerStatus(serviceIdx, serviceName, deployPreset, 'starting');
          break;
        }
        case COMMAND.CONTAINER_STOP: {
          const commandPayload = this.getServiceCommandPayload(payload);
          if (!commandPayload) break;
          const { serviceIndex: serviceIdx, serviceName, deployPreset } = commandPayload;
          const containerName = String(payload.containerName ?? '');
          if (!containerName) break;
          await this.serviceLifecycleService.syncContainerStatus(serviceIdx, serviceName, deployPreset);
          await this.containerLifeCycleService.stopContainer(
            serviceIdx,
            containerName,
            deployPreset,
            (event: string, emitPayload: unknown) => {
              const p = emitPayload as ServiceLogPayload & { status?: string };
              if (event === 'service-status' && typeof p.status === 'string') {
                this.emitToHub(event, { serviceIndex: serviceIdx, status: p.status });
                log(`[TunnelService] {{ cyan : bold : EVENT:STATUS }}\n  Service Index : ${serviceIdx}\n  Status        : ${p.status}`);
                this.serviceGateway.pushStatus(serviceIdx, p.status);
                void this.serviceLifecycleService.updateServiceStatus(serviceIdx, p.status);
              } else if (event === 'service-log') {
                this.emitServiceLog(serviceIdx, p);
              }
            },
          );
          await this.serviceLifecycleService.syncContainerStatus(serviceIdx, serviceName, deployPreset);
          break;
        }
        case COMMAND.CONTAINER_RESTART: {
          const commandPayload = this.getServiceCommandPayload(payload);
          if (!commandPayload) break;
          const { serviceIndex: serviceIdx, serviceName, deployPreset } = commandPayload;
          const containerName = String(payload.containerName ?? '');
          if (!containerName) break;
          await this.serviceLifecycleService.syncContainerStatus(serviceIdx, serviceName, deployPreset);
          await this.containerLifeCycleService.restartContainer(
            serviceIdx,
            containerName,
            deployPreset,
            (event: string, emitPayload: unknown) => {
              const p = emitPayload as ServiceLogPayload & { status?: string };
              if (event === 'service-status' && typeof p.status === 'string') {
                this.emitToHub(event, { serviceIndex: serviceIdx, status: p.status });
                log(`[TunnelService] {{ cyan : bold : EVENT:STATUS }}\n  Service Index : ${serviceIdx}\n  Status        : ${p.status}`);
                this.serviceGateway.pushStatus(serviceIdx, p.status);
                void this.serviceLifecycleService.updateServiceStatus(serviceIdx, p.status);
              } else if (event === 'service-log') {
                this.emitServiceLog(serviceIdx, p);
              }
            },
          );
          await this.serviceLifecycleService.syncContainerStatus(serviceIdx, serviceName, deployPreset, 'starting');
          break;
        }
        case COMMAND.ABORT:
          log(`[TunnelService] {{ gray : bold : CMD:IGNORED }}\n  Command       : ${payload.command}\n  Service Index : ${payload.serviceIndex ?? '-'}\n  Service Name  : ${payload.serviceName ?? '-'}\n  Preset        : ${payload.deployPreset ?? '-'}`);
          break;
        case COMMAND.DELETE: {
          const commandPayload = this.getServiceCommandPayload(payload);
          if (!commandPayload) break;
          const { serviceIndex: deleteIdx, serviceName, deployPreset } = commandPayload;
          await this.serviceLifecycleService.syncContainerStatus(deleteIdx, serviceName, deployPreset);
          await this.serviceLifecycleService.v1DeleteService(
            serviceName,
            deleteIdx,
            deployPreset,
            payload.deleteScope === 'service' ? 'service' : 'containers',
            (event: string, emitPayload: unknown) => {
              const p = emitPayload as ServiceLogPayload & { status?: string };
              if (event === 'service-status' && typeof p.status === 'string') {
                this.emitToHub(event, { serviceIndex: deleteIdx, status: p.status });
                log(`[TunnelService] {{ cyan : bold : EVENT:STATUS }}\n  Service Index : ${deleteIdx}\n  Status        : ${p.status}`);
                this.serviceGateway.pushStatus(deleteIdx, p.status);
              } else if (event === 'service-log') {
                this.emitServiceLog(deleteIdx, p);
              }
            },
          );
          this.serviceLifecycleService.clearContainerStates(deleteIdx);
          break;
        }
        case COMMAND.DISCONNECT:
          log(`[TunnelService] {{ red : bold : SOCKET:DISCONNECT_REQUESTED }}`);
          this.socket.disconnect();
          break;
        case COMMAND.STREAM_LOG: {
          const commandPayload = this.getServiceCommandPayload(payload);
          if (!commandPayload) break;
          const { serviceIndex: streamIdx, serviceName: streamName, deployPreset } = commandPayload;
          const snapshot = this.serviceLifecycleService.getContainerSnapshot(streamIdx);
          if (snapshot) {
            this.emitToHub('container-status', snapshot);
          }
          const markers = await this.serviceLifecycleService.loadRecentSessionMarkers(streamIdx);
          this.emitToHub('service-log-markers', { serviceIndex: streamIdx, markers });
          await this.serviceLifecycleService.streamServiceLog(
            streamIdx,
            streamName,
            deployPreset,
            ({ line, timestamp: logTimestamp, source, stream, containerName, composeService, stderr }) => {
              this.emitServiceLog(streamIdx, {
                log: line,
                timestamp: logTimestamp,
                source,
                stream,
                containerName,
                composeService,
                stderr,
              });
            },
            (progress) => {
              this.emitToHub('log-load-progress', { serviceIndex: streamIdx, ...progress });
            },
            (entries) => {
              this.emitToHub('service-log-history', {
                serviceIndex: streamIdx,
                logs: entries,
                hasMore: true,
              });
            },
          );
          break;
        }
        case COMMAND.LOAD_OLDER_LOG: {
          const commandPayload = this.getServiceCommandPayload(payload);
          if (!commandPayload || !payload.before) break;
          const { serviceIndex: historyIdx, serviceName, deployPreset } = commandPayload;
          const logs = this.serviceLifecycleService.loadOlderServiceLogs(
            serviceName,
            deployPreset,
            payload.before,
            Number(payload.limit ?? 1000),
          );
          const markers = await this.serviceLifecycleService.loadOlderSessionMarkers(
            historyIdx,
            payload.before,
            Number(payload.limit ?? 1000),
          );
          this.emitToHub('service-log-history', {
            serviceIndex: historyIdx,
            before: payload.before,
            logs,
            markers,
            hasMore: logs.length >= Number(payload.limit ?? 1000),
          });
          break;
        }
        case COMMAND.SYNC_CONTAINER_STATUS: {
          const commandPayload = this.getServiceCommandPayload(payload);
          if (!commandPayload) break;
          const { serviceIndex: syncIdx, serviceName, deployPreset } = commandPayload;
          const snapshot = await this.serviceLifecycleService.syncContainerStatus(
            syncIdx,
            serviceName,
            deployPreset,
          );
          this.emitToHub('container-status', snapshot);
          break;
        }
        case COMMAND.STOP_LOG: {
          const stopName: string = String(payload.serviceName);
          this.serviceLifecycleService.stopServiceLog(stopName);
          break;
        }
      }

      log(`[TunnelService] {{ green : bold : CMD:DONE }}\n  Command       : ${payload.command}\n  Service Index : ${payload.serviceIndex ?? '-'}\n  Service Name  : ${payload.serviceName ?? '-'}\n  Preset        : ${payload.deployPreset ?? '-'}`);
      this.emitToHub('response', response);
    });

    this.onFromHub('connect-request', async (payload: ConnectRequestPayload) => {
      /**
       * 이 페이로드만 통째로 저장·중계되므로 계약에 있는 필드만 추려서 넘긴다.
       *
       * 그대로 넘기면 서명 봉투(_sig/_ts/_nonce)가 로컬 DB에 그대로 눌러앉고
       * Dashboard까지 흘러간다. 검증이 끝난 시점에 봉투는 더 이상 쓸모가 없다.
       */
      const request: ConnectRequestPayload = {
        workspaceOwnerName: payload.workspaceOwnerName,
        workspaceName: payload.workspaceName,
        workspaceCreatedAt: payload.workspaceCreatedAt,
        workspaceIndex: payload.workspaceIndex,
        requestDatetime: payload.requestDatetime,
      };

      await this.notifyService.savePendingRequest(request);
      this.notifyGateway.pushConnectRequest(request);
      log(`[TunnelService] {{ cyan : bold : CONNECT_REQUEST:RECEIVED }}\n  Workspace       : ${request.workspaceName}\n  Workspace Index : ${request.workspaceIndex}`);
    });

    // 이 함수는 현재 Hub 버전에서 어떠한 경우에도 사용되지 않음.
    this.onFromHub('reverse-proxy', async (payload: RouteRequest) => {
      log(`[TunnelService] {{ magenta : bold : REVERSE_PROXY:REQUEST }}\n  Target Service : ${payload.targetServiceName}\n  Path           : ${payload.path}`);
      const response = await this.serviceLifecycleService.fetchJSON(payload);
      this.emitToHub('response', response);
    });

    // RTS에서 Preconnect 관련 로직을 넣으면 될 듯.
    this.onFromHub('tunnel-connect', (payload: { token: string, service_port: number, tunnel_port: number }) => {
      this.reverseTunnelService.open({ servicePort: payload.service_port, token: payload.token, tunnelPort: payload.tunnel_port })
    });

    // 교체는 헬퍼 컨테이너에 위임되고 곧 이 프로세스가 사라진다. 응답을 기다리지 않는다.
    this.onFromHub('update-agent', (payload: { version: string }) => {
      log(`[TunnelService] {{ yellow : bold : UPDATE:REQUESTED }}\n  Target Version : ${payload.version}`);
      this.appService.updateAgent(payload.version, {
        progress: (line) => this.emitToHub('update-log', { line }),
        failed: (message) => this.emitToHub('update-failed', { message }),
      }).catch((error: unknown) => {
        this.emitToHub('update-failed', { message: String(error) });
        log(`[TunnelService] {{ red : bold : UPDATE:FAILED }}\n  ${String(error)}`);
      });
    });
  }

  onModuleDestroy() {
    this.socket?.disconnect();
  }
}
