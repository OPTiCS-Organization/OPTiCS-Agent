import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import path from "path";
import log from "spectra-log";
import { DeployCommand } from "src/service/dtos/DeployCommand.dto";
import { DEPLOY_OPTION } from "src/global/DeployOptionEnum";
import { BuildWorkspaceService } from "./build-workspace.service";
import { ComposeProjectService } from "./compose-project.service";
import { ImageBuildService } from "./image-build.service";
import { HubEmit } from "./types/HubEmit.type";
import { ExpectedServicesCallback } from "./types/ExpectedServicesCallback";
import { DeployOptions } from "./types/DeployOptions.type";
import { ServiceStatus } from "./types/ServiceStatus.type";
import { primaryRootDirectory, resolvePortMappings } from "./utility/deploy-command.util";
import { createServiceLogEmitter, createServiceStatusEmitter } from "./utility/emitters";

@Injectable()
export class DeployService {
  private buildRoot: string;
  private readonly preserveFailedDeployArtifacts = true;

  constructor(
    private readonly buildWorkspaceService: BuildWorkspaceService,
    private readonly composeProjectService: ComposeProjectService,
    private readonly imageBuildService: ImageBuildService,
    private readonly configService: ConfigService,
  ) {
    this.buildRoot = configService.get<string>('OPTICS_BUILD_DIR') ?? path.join(process.cwd(), 'dist/build');
  }

  // 배포 한 건의 전체 순서를 지휘한다: 정리 -> 클론 -> 빌드 -> 기동.
  // 실제 작업은 워크스페이스/compose/이미지 서비스가 맡고 여기서는 상태와 로그만 관리한다.
  async deploy(data: DeployCommand, emit: HubEmit, deployOptions?: DeployOptions, onExpectedServices?: ExpectedServicesCallback) {
    const serviceName = data.serviceName.toLowerCase();
    const { sendLog } = createServiceLogEmitter(emit, {
      serviceIndex: data.serviceIndex,
      containerName: serviceName,
      stream: 'deploy',
    });
    const { sendStatus } = createServiceStatusEmitter(emit, { serviceIndex: data.serviceIndex });
    const serviceDir = path.join(this.buildRoot, serviceName);
    let composeBuildDir: string | null = null;

    try {
      sendStatus(ServiceStatus.BUILDING);
      sendLog(`Redeploying service ${serviceName}@${data.serviceVersion}`);

      await this.imageBuildService.removeExistingContainer(serviceName, sendLog);

      // 클론보다 반드시 먼저 지워야 한다. 순서가 바뀌면 방금 클론한 소스를 삭제한다.
      this.buildWorkspaceService.removeBuildDir(serviceDir, sendLog);

      const clonedDir = await this.buildWorkspaceService.cloneAll(data.sourceUrl, serviceDir, sendLog);
      const rootDirectory = primaryRootDirectory(data);
      const buildDir = this.buildWorkspaceService.resolveBuildContext(clonedDir, rootDirectory);
      if (buildDir !== clonedDir) {
        sendLog(`[DeployService] Using root directory: ${rootDirectory}`);
      }
      this.buildWorkspaceService.applyBuildPermissions(buildDir);

      if (this.shouldUseCompose(data.deployPreset, buildDir)) {
        composeBuildDir = buildDir;
        await this.deployWithCompose(serviceName, buildDir, data, sendLog, onExpectedServices);
      } else {
        await this.deployWithDockerfile(serviceName, buildDir, data, sendLog, sendStatus);
      }

      sendLog('Service redeployed successfully.');
      sendStatus(ServiceStatus.RUNNING);
      log('Redeploy success.');
      return true;
    } catch (error) {
      await this.cleanupFailedDeployment(serviceName, composeBuildDir, sendLog);
      sendStatus(ServiceStatus.FAILED);
      sendLog(`ERROR: ${String(error)}`);
      log(error);
      return false;
    }
  }

  // 프리셋과 실제 파일 존재 여부로 compose 경로를 탈지 결정한다.
  // COMPOSE를 골랐는데 파일이 없으면 Dockerfile로 넘어가지 않고 실패시킨다.
  private shouldUseCompose(deployPreset: DEPLOY_OPTION, buildDir: string): boolean {
    const preset = deployPreset.toUpperCase() as DEPLOY_OPTION;
    const composeFileExists = this.composeProjectService.hasComposeFile(buildDir);

    if (preset === DEPLOY_OPTION.COMPOSE && !composeFileExists) {
      throw new Error('docker-compose.yml not found.');
    }
    return preset === DEPLOY_OPTION.COMPOSE
      || (preset !== DEPLOY_OPTION.DOCKERFILE && composeFileExists);
  }

  // compose 경로: env 파일과 restart override를 쓴 뒤 프로젝트를 띄운다.
  // 기동 전에 예상 서비스 목록을 알려 대시보드가 컨테이너 자리를 먼저 잡게 한다.
  private async deployWithCompose(
    serviceName: string,
    buildDir: string,
    data: DeployCommand,
    sendLog: (line: string) => void,
    onExpectedServices?: ExpectedServicesCallback,
  ): Promise<void> {
    sendLog('Detected docker-compose, starting build...');
    this.composeProjectService.writeEnvFile(buildDir, data);
    const services = this.composeProjectService.writeNoRestartOverride(buildDir, sendLog);
    onExpectedServices?.(services);
    await this.composeProjectService.up(serviceName, buildDir, sendLog);
  }

  // Dockerfile 경로: 이미지를 빌드하고 컨테이너 하나를 띄운다.
  // 빌드가 끝난 시점에 starting을 쏴서 UI가 빌드와 기동을 구분하게 한다.
  private async deployWithDockerfile(
    serviceName: string,
    buildDir: string,
    data: DeployCommand,
    sendLog: (line: string) => void,
    sendStatus: (status: ServiceStatus) => void,
  ): Promise<void> {
    sendLog('Detected Dockerfile, starting build...');
    await this.imageBuildService.buildImage(buildDir, `${serviceName}:${data.serviceVersion}`, sendLog);

    sendLog('Build done. Starting container...');
    sendStatus(ServiceStatus.STARTING);
    await this.imageBuildService.runContainer(
      data.serviceName,
      data.serviceVersion,
      resolvePortMappings(data),
      data.env,
    );
  }

  // 배포 실패 시 남은 컨테이너와 빌드 디렉토리를 치운다.
  // 지금은 원인 분석을 위해 플래그로 꺼둔 상태다.
  private async cleanupFailedDeployment(
    projectName: string,
    composeBuildDir: string | null,
    sendLog: (line: string) => void,
  ): Promise<void> {
    if (this.preserveFailedDeployArtifacts) {
      sendLog('[DeployService] Failed deploy cleanup is temporarily disabled; leaving containers and build directory in place.');
      return;
    }

    if (composeBuildDir) {
      await this.composeProjectService.down(projectName, composeBuildDir, sendLog);
    }
    this.buildWorkspaceService.removeBuildDir(path.join(this.buildRoot, projectName), sendLog);
  }
}
