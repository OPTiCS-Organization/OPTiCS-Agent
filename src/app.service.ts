import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import log from 'spectra-log';
import { PrismaService } from './share/prisma.service.js';
import { DashboardGateway } from './dashboard.gateway.js';
import { SystemMetricsUtility } from './utility/systemMetric.util.js';
import { DockerCli } from './docker/docker-cli.service.js';
import { SelfInspectService } from './docker/self-inspect.service.js';
import { stripAnsi } from './docker/utility/docker-cli.js';
import { readFileSync } from 'fs';
import { join } from 'path';

/** GHCR에 올라가는 Agent 이미지. 태그를 뺀 저장소 경로다. */
const DEFAULT_AGENT_IMAGE = 'ghcr.io/optics-organization/optics-agent';
/** docker CLI와 compose 플러그인만 있으면 되므로 stock 이미지를 그대로 쓴다. */
const UPDATER_IMAGE = 'docker:27-cli';
const UPDATER_CONTAINER = 'optics-agent-updater';
/** 교체 후 새 Agent가 살아남는지 지켜보는 시간(초). */
const HEALTH_WAIT_SECONDS = 45;
/** Hub가 보내온 값이 그대로 이미지 태그가 되므로 허용 문자를 막는다. */
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
  async updateAgent(
    version: string,
    report?: {
      progress: (line: string) => void;
      /** 교체가 일어나지 못한 채 업데이터가 끝났을 때. */
      failed: (message: string) => void;
    },
  ) {
    if (!TAG_PATTERN.test(version)) {
      throw new Error(`Rejected malformed image tag: ${version}`);
    }

    const { workingDir, service } = await this.selfInspect.resolveComposeProject();
    const agentImage = this.configService.get<string>('OPTICS_AGENT_IMAGE') ?? DEFAULT_AGENT_IMAGE;

    // 이전 업데이터 잔해를 치운다. --rm을 쓰지 않으므로 실패한 회차의 로그가 남아 있고,
    // Agent가 죽은 채 돌아오지 않았다면 그 로그가 사용자에게 남는 유일한 단서다.
    this.dockerCli.runSync(['rm', '-f', UPDATER_CONTAINER]);

    // 프로젝트는 반드시 "호스트와 같은 경로"에 마운트한다.
    // compose는 자기가 실행된 디렉터리를 working_dir 라벨에 그대로 박으므로, 여기서 /project 같은
    // 컨테이너 전용 경로를 쓰면 교체된 Agent의 라벨이 그 경로로 덮여 다음 업데이트가 존재하지 않는
    // 호스트 경로를 마운트하게 된다(원격 업데이트가 설치당 한 번만 되던 원인).
    // 양쪽 경로를 같게 두면 컨테이너 안에서 찍은 라벨이 호스트에서도 그대로 유효하다.
    const result = this.dockerCli.runSync([
      'run', '-d',
      '--name', UPDATER_CONTAINER,
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-v', `${workingDir}:${workingDir}`,
      '-w', workingDir,
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

    // 업데이터 로그를 Hub로 흘려보낸다. 이 스트림은 교체 시점에 프로세스와 함께 끊기므로
    // 대개 pull 구간까지만 도달한다. 그 이후 단계는 Hub가 소켓 상태로 판정한다.
    if (report) this.followUpdaterLogs(report);
  }

  private followUpdaterLogs(report: { progress: (line: string) => void; failed: (message: string) => void }) {
    let buffered = '';
    let lastLine = '';
    const forward = (chunk: Buffer) => {
      buffered += chunk.toString('utf-8');
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = stripAnsi(line).trim();
        if (!trimmed) continue;
        lastLine = trimmed;
        report.progress(trimmed);
      }
    };

    this.dockerCli.stream(['logs', '-f', UPDATER_CONTAINER], {
      onStdout: forward,
      onStderr: forward,
      // 로그가 끝났는데 이 프로세스가 아직 살아 있다면 교체가 일어나지 않은 것이다. 곧 실패다.
      // 성공했다면 compose가 이 컨테이너를 갈아치웠을 것이므로 여기까지 오지 못한다.
      // 알리지 않으면 Hub는 타임아웃(10분)까지 '내려받는 중'에 머문다.
      onClose: () => {
        const inspected = this.dockerCli.runSync(['inspect', '-f', '{{.State.ExitCode}}', UPDATER_CONTAINER]);
        const exitCode = Number(inspected.stdout.trim());
        const suffix = Number.isFinite(exitCode) && exitCode !== 0 ? ` (exit ${exitCode})` : '';
        report.failed(`${lastLine || '업데이터가 결과를 남기지 않고 종료했습니다.'}${suffix}`);
      },
    });
  }
}
