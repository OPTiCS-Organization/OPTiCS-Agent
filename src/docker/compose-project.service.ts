import { Injectable } from "@nestjs/common";
import path from "path";
import fs from "fs";
import { DeployCommand } from "src/service/dtos/DeployCommand.dto";
import { resolvePortMappings } from "./utility/deploy-command.util";
import { DockerCli } from "./docker-cli.service";

const OVERRIDE_FAILED = 'Failed to generate compose restart override.';

@Injectable()
export class ComposeProjectService {
  constructor(
    private readonly dockerCli: DockerCli,
  ) { }

  // 빌드 컨텍스트에 compose 파일이 있는지 본다.
  // .yml과 .yaml 두 확장자를 모두 인정한다.
  hasComposeFile(buildDir: string): boolean {
    return fs.existsSync(path.join(buildDir, 'docker-compose.yml'))
      || fs.existsSync(path.join(buildDir, 'docker-compose.yaml'));
  }

  // ServiceForm의 컨테이너 포트를 PORT 환경변수로 주입해 ${PORT:-...} 컨벤션을 살린다.
  // 사용자가 env에 PORT를 직접 넣었다면 그 값을 우선한다.
  writeEnvFile(buildDir: string, data: DeployCommand): void {
    const userEnv = data.env ?? {};
    const containerPort = resolvePortMappings(data)[0]?.containerPort ?? data.serviceContainerPort ?? data.servicePort;
    const finalEnv: Record<string, string> = { ...userEnv };
    if (containerPort !== undefined && finalEnv.PORT === undefined) {
      finalEnv.PORT = String(containerPort);
    }
    if (Object.keys(finalEnv).length === 0) return;
    const envContent = Object.entries(finalEnv).map(([k, v]) => `${k}=${v}`).join('\n');
    fs.writeFileSync(path.join(buildDir, '.env'), envContent);
  }

  // 사용자 compose의 restart 정책을 "no"로 덮어쓰는 override 파일을 만든다.
  // 이게 없으면 실패한 컨테이너가 무한 재시작해 상태 판정이 불가능해진다.
  writeNoRestartOverride(buildDir: string, sendLog: (line: string) => void): string[] {
    const services = this.listServices(buildDir, sendLog);

    if (services.length === 0) {
      sendLog('[ComposeProjectService] Compose service list is empty; restart override cannot be generated.');
      throw new Error(OVERRIDE_FAILED);
    }

    const overrideContent = [
      'services:',
      ...services.map(service => `  ${service}:\n    restart: "no"`),
    ].join('\n') + '\n';

    try {
      fs.writeFileSync(path.join(buildDir, 'docker-compose.override.yml'), overrideContent);
    } catch (error) {
      sendLog(`[ComposeProjectService] Could not write compose restart override.\n  ${String(error)}`);
      throw new Error(OVERRIDE_FAILED);
    }

    sendLog(`[ComposeProjectService] Injected restart: "no" override for services: ${services.join(', ')}`);
    return services;
  }

  // compose 프로젝트를 빌드하고 백그라운드로 띄운다.
  // 종료 코드가 0이 아니면 배포 실패로 예외를 던진다.
  async up(projectName: string, buildDir: string, sendLog: (line: string) => void): Promise<void> {
    await this.dockerCli.run(['compose', '-p', projectName, 'up', '-d', '--build'], {
      label: 'docker compose',
      cwd: buildDir,
      onLine: sendLog,
      mirrorToAgentLog: true,
    });
  }

  // 실패한 배포의 compose 프로젝트를 정리한다.
  // 정리 자체가 실패해도 원래 에러를 덮지 않도록 항상 resolve한다.
  async down(projectName: string, cwd: string, sendLog: (line: string) => void): Promise<void> {
    if (!fs.existsSync(cwd)) return;
    sendLog(`[ComposeProjectService] Cleaning up failed compose project '${projectName}'...`);
    await this.dockerCli.run(['compose', '-p', projectName, 'down', '--remove-orphans'], {
      label: `docker compose down for '${projectName}'`,
      cwd,
      onLine: sendLog,
      mirrorToAgentLog: true,
      ignoreExitCode: true,
    });
  }

  // compose 파일이 정의한 서비스 이름 목록을 읽는다.
  // 목록을 못 읽으면 override를 만들 수 없으므로 배포를 중단시킨다.
  private listServices(buildDir: string, sendLog: (line: string) => void): string[] {
    try {
      const result = this.dockerCli.runSync(['compose', 'config', '--services'], { cwd: buildDir });

      if (result.status !== 0) {
        const errorMessage = result.stderr?.trim() || 'docker compose config --services failed.';
        sendLog(`[ComposeProjectService] Could not resolve compose service list for restart override.\n  ${errorMessage}`);
        throw new Error(OVERRIDE_FAILED);
      }
      return result.stdout.split('\n').map(service => service.trim()).filter(Boolean);
    } catch (error) {
      if (error instanceof Error && error.message === OVERRIDE_FAILED) throw error;
      sendLog(`[ComposeProjectService] Could not resolve compose service list for restart override.\n  ${String(error)}`);
      throw new Error(OVERRIDE_FAILED);
    }
  }
}
