import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import log from 'spectra-log';
import { PrismaService } from './share/prisma.service.js';
import { DashboardGateway } from './dashboard.gateway.js';
import { SystemMetricsUtility } from './utility/systemMetric.util.js';

@Injectable()
export class AppService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
    private readonly dashboardGateway: DashboardGateway,
    private readonly systemMetricsUtility: SystemMetricsUtility,
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
      cpu: metrics.cpu,
      memory: metrics.mem,
    });
  }
}
