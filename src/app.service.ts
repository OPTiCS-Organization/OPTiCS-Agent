import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import log from 'spectra-log';
import { PrismaService } from './prisma.service.js';
import os from 'os-utils';

@Injectable()
export class AppService implements OnApplicationBootstrap {
  constructor(
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,

  ) {
    let a: number
  }

  async onApplicationBootstrap() {
    const response = await fetch(
      this.configService.get<string>('CENTRAL_SERVER_URL') +
      '/server/initialize',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );

    const data = await response.json();
    log(data);

    await this.prismaService.agentInfo.upsert({
      where: {
        key: 'agent-code',
      },
      update: { value: data.data.connectionCode },
      create: { key: 'agent-code', value: data.data.connectionCode },
    });
  }

  async getConnectionCode() {
    return await this.prismaService.agentInfo.findFirst({
      where: {
        key: 'agent-code',
      }
    });
  }

  @Cron('* * * * * *')
  async heartbeat() {
    try {
      os.cpuUsage((usage) =>
        log(
`CPU Usage: ${(usage * 100).toString().split('.')[0] + '.' + (usage * 100).toString().split('.')[1].slice(0, 2)}%
Memory Usage: ${Math.round(os.totalmem() - os.freemem())} MiB`
        )
      )
    } catch (error) {
      log(error, 500, 'ERROR');
    }
  }
}
