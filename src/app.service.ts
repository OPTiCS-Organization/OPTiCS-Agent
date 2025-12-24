import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import log from 'spectra-log';
import system from 'systeminformation';

@Injectable()
export class AppService {
  constructor(
    private readonly configService: ConfigService,
  ) { };

  @Cron('* * * * * *')
  async heartbeat() {
    try {
      const cpu = await system.cpuCurrentSpeed();
      const memory = await system.mem();
      const data = {
        cpuUsage: cpu.avg,  
        memTotal: Math.round(memory.total / 1024 / 1024),
        memUsage: Math.round(memory.used / 1024 / 1024),
        swapTotal: Math.round(memory.swaptotal / 1024 / 1024),
        swapUsage: Math.round(memory.swapused / 1024 / 1024),
      }
      fetch(this.configService.get<string>('CENTRAL_SERVER_URL') + '/server/status/heartbeat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',  
        },
        body: JSON.stringify(data)
      })
    } catch (error) {
      log(error, 500, 'ERROR');
    }
  }
}