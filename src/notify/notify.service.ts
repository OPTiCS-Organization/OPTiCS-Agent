import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { NotificationGateway } from 'src/socket.gateway';
import { ConnectRequest } from './dto/ConnectRequest.dto';
import { NotificationEnum } from './enums/NotificationTypes.enum';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma.service';

@Injectable()
export class NotifyService {
  constructor (
    @Inject(forwardRef(() => NotificationGateway))
    private readonly notificationGateway: NotificationGateway,
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
  ) { };

  onReceiveConnectRequest(request: ConnectRequest) {
    this.notificationGateway.sendNotification(request.workspaceOwnerName, request.workspaceName, request.requestDatetime, NotificationEnum.ConnectRequest)
  }

  async responseConnectRequest(respond: boolean) {
    const agentInfo = await this.prismaService.agentInfo.findFirst({
      where: { key: 'agent-code' },
      select: { value: true },
    });

    await axios.post(`${this.configService.getOrThrow('CENTRAL_SERVER_URL')}/v1/agent/connect/${respond === true ? 'accept' : 'reject'}`, {
      agentCode: agentInfo?.value,
    });
  }
}
