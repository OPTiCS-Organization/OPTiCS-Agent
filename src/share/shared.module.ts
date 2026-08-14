import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { GitService } from "./git.service";
import { PrismaService } from "./prisma.service";

@Module({
  imports: [ConfigModule],
  providers: [GitService, PrismaService],
  exports: [GitService, PrismaService]
})
export class SharedModule {}