import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import log from 'spectra-log';
import { PrismaService } from './share/prisma.service.js';
import { DashboardGateway } from './dashboard.gateway.js';
import { SystemMetricsUtility } from './utility/systemMetric.util.js';
import { DockerCli } from './docker/docker-cli.service.js';
import { SelfInspectService } from './docker/self-inspect.service.js';
import { readFileSync } from 'fs';
import { join } from 'path';

/** GHCR에 올라가는 Agent 이미지. 태그를 뺀 저장소 경로다. */
const DEFAULT_AGENT_IMAGE = 'ghcr.io/optics-organization/optics-agent';
/** docker CLI와 compose 플러그인만 있으면 되므로 stock 이미지를 그대로 쓴다. */
const UPDATER_IMAGE = 'docker:27-cli';
const UPDATER_CONTAINER = 'optics-agent-updater';
/** 교체 후 새 Agent가 살아남는지 지켜보는 시간(초). */
const HEALTH_WAIT_SECONDS = 45;
/** Hub가 보내온 값이 그대로 이미지 태그가 되므로 허용 문자를 좁게 막는다. */
const TAG_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;

/**
 * 업데이트 스크립트는 이미지에 파일로 실려 있고 헬퍼에는 argv로 건네진다.
 * 헬퍼는 stock docker:cli라서 Agent의 파일시스템을 볼 수 없으므로 마운트가 아니라 인자여야 한다.
 * (dist/src에서 두 단계 위가 /app이다)
 */
function readUpdateScript(): string {
  return readFileSync(join(__dirname, '../../entrypoints/update.sh'), 'utf-8');
}

@Injectable()
export class AppService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
    private readonly dashboardGateway: DashboardGateway,
    private readonly systemMetricsUtility: SystemMetricsUtility,
    private readonly dockerCli: DockerCli,
    private readonly selfInspect: SelfInspectService,
  ) { }

  public async getAgentInfo() {
    const agentCode = await this.prismaService.agentInfo.findFirst({
      where: {
        key: 'agent-code',
      },
      select: {
        value: true,
      }
    });
    const agentIp = await this.prismaService.agentInfo.findFirst({
      where: {
        key: 'agent-ip',
      },
      select: {
        value: true,
      }
    });

    if (!agentCode || !agentIp) return { agentCode: null, agentIp: null };

    return { agentCode: agentCode.value, agentIp: agentIp.value }
  }

  @Cron('* * * * * *')
  async heartbeat() {
    await this.updatePerformance();
  }

  async updatePerformance() {
    const metrics = this.systemMetricsUtility.getMetrics();

    // 직전 구간에 표본이 하나도 없으면 저장/전송할 게 없다.
    if (metrics.samples.cpu === 0 && metrics.samples.mem === 0) return;

    try {
      const timestamp = BigInt(metrics.timestamp);
      await this.prismaService.cpuUsage.create({
        data: { timestamp, ...metrics.cpu },
      });
      await this.prismaService.memoryUsage.create({
        data: { timestamp, ...metrics.mem },
      });

      const sevenDaysAgo = BigInt(Date.now() - 7 * 24 * 60 * 60 * 1000);

      await this.prismaService.cpuUsage.deleteMany({
        where: { timestamp: { lt: sevenDaysAgo } },
      });
      await this.prismaService.memoryUsage.deleteMany({
        where: { timestamp: { lt: sevenDaysAgo } },
      });
    } catch (error) {
      Logger.error(error);
    }

    // WebSocket으로 CPU/메모리 데이터 전송
    this.dashboardGateway.sendMetric({
      cpu: { timestamp: metrics.timestamp, ...metrics.cpu },
      memory: { timestamp: metrics.timestamp, ...metrics.mem },
    });
  }

  /**
   * 지정한 버전의 Agent 이미지로 자기 자신을 교체한다.
   *
   * 교체 도중 이 프로세스는 죽으므로 실제 작업은 별도 헬퍼 컨테이너에 위임하고 즉시 반환한다.
   * 헬퍼는 compose 프로젝트 바깥에 떠 있어야 `compose up -d`가 헬퍼 자신을 재생성하지 않는다.
   */
  async updateAgent(version: string) {
    if (!TAG_PATTERN.test(version)) {
      throw new Error(`Rejected malformed image tag: ${version}`);
    }

    const { workingDir, service } = await this.selfInspect.resolveComposeProject();
    const agentImage = this.configService.get<string>('OPTICS_AGENT_IMAGE') ?? DEFAULT_AGENT_IMAGE;

    // 이전 업데이터 잔해를 치운다. --rm을 쓰지 않으므로 실패한 회차의 로그가 남아 있고,
    // Agent가 죽은 채 돌아오지 않았다면 그 로그가 사용자에게 남는 유일한 단서다.
    this.dockerCli.runSync(['rm', '-f', UPDATER_CONTAINER]);

    const result = this.dockerCli.runSync([
      'run', '-d',
      '--name', UPDATER_CONTAINER,
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-v', `${workingDir}:/project`,
      '-w', '/project',
      '-e', `AGENT_IMAGE=${agentImage}`,
      '-e', `TARGET_TAG=${version}`,
      '-e', `AGENT_SERVICE=${service}`,
      '-e', `HEALTH_WAIT=${HEALTH_WAIT_SECONDS}`,
      UPDATER_IMAGE,
      'sh', '-c', readUpdateScript(),
    ]);

    if (result.status !== 0) {
      throw new Error(`Failed to start updater container: ${result.stderr.trim()}`);
    }
    log(`[AppService] Update to ${version} delegated to ${UPDATER_CONTAINER}. This process will be replaced shortly.`);
  }
}
