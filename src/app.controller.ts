import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) { }

  @Get('/connect')
  async handleDisplayConnectionCode() {
    return this.appService.getConnectionCode();
  }
}
