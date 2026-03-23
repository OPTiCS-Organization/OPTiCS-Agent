import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DockerService } from "./docker.service";
import { GitService } from "./git.service";
import { PrismaService } from "./prisma.service";

@Module({
  imports: [ConfigModule],
  providers: [DockerService, GitService, PrismaService],
  exports: [DockerService, GitService, PrismaService]
})
export class SharedModule {}