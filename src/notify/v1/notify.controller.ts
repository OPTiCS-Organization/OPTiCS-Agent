import { Body, Controller, Post } from '@nestjs/common';
import { NotifyService } from '../notify.service';
import { ConnectRequest } from '../dto/ConnectRequest.dto';

@Controller({ path: 'notify', version: '1' })
export class NotifyController {
  constructor (
    private readonly notifyService: NotifyService,
  ) { };

  @Post('connect-request')
  handleOnReceiveConnectRequest(@Body() body: ConnectRequest) {
    this.notifyService.onReceiveConnectRequest(body);  
    return;
  }
}
