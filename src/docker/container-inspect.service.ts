import { Injectable } from "@nestjs/common";
import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import { DEPLOY_OPTION } from "../global/DeployOptionEnum";
import { ContainerState } from "./types/ContainerState.type";
import { parseJsonOutput } from "./utility/docker-output.util";
import { healthFromStatus, labelsToRecord, normalizeContainerStatus } from "./utility/container-status.util";
import { isComposePreset } from "./utility/deploy-command.util";

@Injectable()
export class ContainerInspectService {
  private readonly buildRoot = process.env.OPTICS_BUILD_DIR ?? path.join(process.cwd(), 'dist/build');

  // 서비스 하나에 속한 컨테이너들의 현재 상태를 조회한다.
  // compose 서비스는 여러 개가, Dockerfile 서비스는 하나가 돌아온다.
  async getContainerSnapshot(serviceName: string, deployPreset: DEPLOY_OPTION): Promise<ContainerState[]> {
    return isComposePreset(deployPreset)
      ? this.listComposeContainers(serviceName)
      : this.inspectDockerfileContainer(serviceName);
  }

  // 단일 컨테이너를 docker inspect로 조회한다.
  // 컨테이너가 없으면 빈 배열이라 호출부에서 '삭제됨'으로 해석할 수 있다.
  private inspectDockerfileContainer(serviceName: string): ContainerState[] {
    const result = spawnSync('docker', ['inspect', serviceName], { encoding: 'utf8' });
    if (result.status !== 0) return [];
    return parseJsonOutput<Record<string, any>>(result.stdout).map(container => {
      const state = container.State ?? {};
      const exitCode = typeof state.ExitCode === 'number' ? state.ExitCode : null;
      const health = typeof state.Health?.Status === 'string' ? state.Health.Status : null;
      return {
        name: container.Name ? String(container.Name).replace(/^\//, '') : serviceName,
        status: normalizeContainerStatus(state.Status, exitCode, health),
        exitCode,
        health,
      };
    });
  }

  // compose 프로젝트의 컨테이너를 조회하되 빌드 디렉토리가 남아있을 때만 compose ps를 쓴다.
  // 디렉토리가 지워졌거나 compose ps가 실패하면 프로젝트 라벨로 docker ps를 걸어 대체한다.
  private listComposeContainers(projectName: string): ContainerState[] {
    const buildDir = path.join(this.buildRoot, projectName);
    if (fs.existsSync(buildDir)) {
      const composeResult = spawnSync(
        'docker',
        ['compose', '-p', projectName, 'ps', '-a', '--format', 'json'],
        { cwd: buildDir, encoding: 'utf8' },
      );
      if (composeResult.status === 0) {
        const composeRows = parseJsonOutput<Record<string, any>>(composeResult.stdout);
        if (composeRows.length > 0) {
          return composeRows.map(row => {
            const exitCode = typeof row.ExitCode === 'number' ? row.ExitCode : Number.isFinite(Number(row.ExitCode)) ? Number(row.ExitCode) : null;
            const health = typeof row.Health === 'string' ? row.Health : healthFromStatus(row.Status);
            return {
              name: String(row.Name ?? row.Names ?? row.ID ?? ''),
              service: row.Service ? String(row.Service) : undefined,
              status: normalizeContainerStatus(row.State, exitCode, health),
              exitCode,
              health,
            };
          }).filter(container => container.name);
        }
      }
    }

    const psResult = spawnSync(
      'docker',
      ['ps', '-a', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{json .}}'],
      { encoding: 'utf8' },
    );
    if (psResult.status !== 0) return [];
    return parseJsonOutput<Record<string, any>>(psResult.stdout).map(row => {
      const labels = labelsToRecord(row.Labels ? String(row.Labels) : '');
      const health = healthFromStatus(row.Status ? String(row.Status) : undefined);
      return {
        name: String(row.Names ?? ''),
        service: labels['com.docker.compose.service'],
        status: normalizeContainerStatus(row.State ? String(row.State) : undefined, null, health),
        exitCode: null,
        health,
      };
    }).filter(container => container.name);
  }
}
