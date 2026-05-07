import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import fs from 'fs';
import path from 'path';

function isContainerRuntime() {
  return process.env.OPTICS_AGENT_RUNTIME === 'container' || fs.existsSync('/.dockerenv');
}

function databaseUrl() {
  const configured = process.env.DATABASE_URL;
  if (isContainerRuntime()) {
    return configured ?? 'file:/app/data/data.db';
  }

  if (configured && configured !== 'file:/app/data/data.db') {
    return configured;
  }

  const dataDir = path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return `file:${path.join(dataDir, 'data.db')}`;
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const adapter = new PrismaBetterSqlite3({
      url: databaseUrl(),
    });
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
