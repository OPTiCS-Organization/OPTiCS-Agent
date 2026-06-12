import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../share/prisma.service';

export interface ConnectRequestPayload {
  workspaceOwnerName: string;
  workspaceName: string;
  workspaceCreatedAt: string;
  workspaceIndex: number;
  requestDatetime: string;
}

const PENDING_REQUEST_KEY = 'pending-connect-request';

const AGENT_CODE_KEY = 'agent-code';
const AGENT_UUID_KEY = 'agent-uuid';

@Injectable()
export class NotifyService {
  hubUrl: string = '';
  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.hubUrl = `${configService.getOrThrow<string>('HUB_URL')}:${configService.getOrThrow<string>('HUB_API_PORT')}`;
  }

  async savePendingRequest(payload: ConnectRequestPayload): Promise<void> {
    await this.prismaService.agentInfo.upsert({
      where: { key: PENDING_REQUEST_KEY },
      create: { key: PENDING_REQUEST_KEY, value: JSON.stringify(payload) },
      update: { value: JSON.stringify(payload) },
    });
  }

  async getPendingRequest(): Promise<ConnectRequestPayload | null> {
    const row = await this.prismaService.agentInfo.findUnique({
      where: { key: PENDING_REQUEST_KEY },
    });
    if (!row) return null;
    return JSON.parse(row.value) as ConnectRequestPayload;
  }

  async clearPendingRequest(): Promise<void> {
    await this.prismaService.agentInfo.deleteMany({
      where: { key: PENDING_REQUEST_KEY },
    });
  }

  async respondToRequest(accept: boolean): Promise<void> {
    const agentCodeRow = await this.prismaService.agentInfo.findUnique({
      where: { key: AGENT_CODE_KEY },
    });
    if (!agentCodeRow) throw new Error('Agent code not found.');

    const agentUuidRow = await this.prismaService.agentInfo.findUnique({
      where: { key: AGENT_UUID_KEY },
    });
    if (!agentUuidRow) throw new Error('Agent uuid not found.');

    const endpoint = accept ? 'accept' : 'reject';

    await fetch(`${this.hubUrl}/v1/agent/connect/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentCode: agentCodeRow.value,
        agentUuid: agentUuidRow.value,
      }),
    });

    await this.clearPendingRequest();
  }
}
