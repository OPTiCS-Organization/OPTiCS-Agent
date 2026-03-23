import { Body, Controller, Get, Post } from '@nestjs/common';
import { NotifyService, ConnectRequestPayload } from './notify.service';
import { NotifyGateway } from './notify.gateway';

@Controller({ path: 'notify', version: '1' })
export class NotifyController {
  constructor(
    private readonly notifyService: NotifyService,
    private readonly notifyGateway: NotifyGateway,
  ) {}

  // Hub에서 호출: 연결 요청 수신 및 저장, 대시보드에 실시간 push
  @Post('/connect-request')
  async receiveConnectRequest(@Body() body: ConnectRequestPayload) {
    await this.notifyService.savePendingRequest(body);
    this.notifyGateway.pushConnectRequest(body);
    return { success: true };
  }

  // 대시보드에서 호출: 미처리 연결 요청 조회
  @Get('/connect-request/pending')
  async getPendingRequest() {
    const pending = await this.notifyService.getPendingRequest();
    return { data: pending };
  }

  // 대시보드에서 수락 시 호출: Hub에 수락 전달 후 pending 삭제
  @Post('/connect-request/accept')
  async acceptConnectRequest() {
    await this.notifyService.respondToRequest(true);
    return { success: true };
  }

  // 대시보드에서 거절 시 호출: Hub에 거절 전달 후 pending 삭제
  @Post('/connect-request/reject')
  async rejectConnectRequest() {
    await this.notifyService.respondToRequest(false);
    return { success: true };
  }
}
