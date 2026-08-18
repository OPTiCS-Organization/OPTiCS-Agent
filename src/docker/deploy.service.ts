import { Injectable } from "@nestjs/common";
import { DeployCommand } from "src/service/dtos/DeployCommand.dto";
import { HubEmit } from "./types/HubEmit.type";
import { ExpectedServicesCallback } from "./types/ExpectedServicesCallback";
import { BuildWorkspaceService } from "./build-workspace.service";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { ServicePortMapping } from "src/global/types/Command.dto";

@Injectable()
export class DeployService {
  constructor(
    private readonly buildWorkspaceService: BuildWorkspaceService,

  ) { };

  // ServiceForm의 컨테이너 포트 입력값을 PORT 환경변수로 자동 주입하여
  // compose 파일이 ${PORT:-...} 컨벤션을 따를 때 정상 동작하게 한다.
  // 사용자가 env에 PORT를 직접 명시했다면 그것을 우선한다.
  private writeComposeEnvFile(buildDir: string, data: DeployCommand): void {
    const userEnv = data.env ?? {};
    const containerPort = this.resolvePortMappings(data)[0]?.containerPort ?? data.serviceContainerPort ?? data.servicePort;
    const finalEnv: Record<string, string> = { ...userEnv };
    if (containerPort !== undefined && finalEnv.PORT === undefined) {
      finalEnv.PORT = String(containerPort);
    }
    if (Object.keys(finalEnv).length === 0) return;
    const envContent = Object.entries(finalEnv).map(([k, v]) => `${k}=${v}`).join('\n');
    fs.writeFileSync(path.join(buildDir, '.env'), envContent);
  }

  private resolvePortMappings(data: Pick<DeployCommand, 'servicePort' | 'serviceHostPort' | 'serviceContainerPort' | 'servicePortMappings'>): ServicePortMapping[] {
    const mappings = Array.isArray(data.servicePortMappings)
      ? data.servicePortMappings
        .map(mapping => ({
          hostPort: Number(mapping.hostPort),
          containerPort: Number(mapping.containerPort),
        }))
        .filter(mapping =>
          Number.isInteger(mapping.hostPort) &&
          Number.isInteger(mapping.containerPort) &&
          mapping.hostPort >= 1 &&
          mapping.hostPort <= 65535 &&
          mapping.containerPort >= 1 &&
          mapping.containerPort <= 65535
        )
      : [];

    if (mappings.length > 0) return mappings;
    return [{
      hostPort: data.serviceHostPort ?? data.servicePort,
      containerPort: data.serviceContainerPort ?? data.servicePort,
    }];
  }

  async createServiceLogEmitter(line: string) {
    emit('service-log', {

    })
    const sendLog = (line: string) => emit('service-log', {
      serviceIndex: si,
      log: line,
      timestamp: new Date().toISOString(),
      source: 'agent',
      stream: 'deploy',
      containerName: data.serviceName.toLowerCase(),
    });
  }

  async deploy(data: DeployCommand, emit: HubEmit, redeploy: boolean, onExpectedServices?: ExpectedServicesCallback) {
    const serviceIndex = data.serviceIndex;

  }

  async redeployService(
    data: DeployCommand,
    emit: HubEmit,
    onExpectedServices?: ExpectedServicesCallback,
  ) {
    const si: number = Number(data.serviceIndex);
    const sendLog = (line: string) => emit('service-log', {
      serviceIndex: si,
      log: line,
      timestamp: new Date().toISOString(),
      source: 'agent',
      stream: 'deploy',
      containerName: data.serviceName.toLowerCase(),
    });
    const sendStatus = (status: string) => emit('service-status', { serviceIndex: si, status });
    const name = data.serviceName.toLowerCase();
    let composeBuildDir: string | null = null;

    try {
      sendStatus('building');
      sendLog(`Redeploying service '${name}@${data.serviceVersion}'...`);

      // 기존 컨테이너 중지 및 제거
      try {
        const existing = this.docker.getContainer(name);
        const info = await existing.inspect() as { State: { Running: boolean } };
        if (info.State.Running) {
          sendLog(`Stopping existing container '${name}'...`);
          await existing.stop();
        }
        sendLog(`Removing existing container '${name}'...`);
        await existing.remove();
      } catch {
        sendLog(`No existing container found, proceeding with fresh deploy.`);
      }

      // 기존 빌드 디렉토리 제거
      this.buildWorkspaceService.removeBuildDir(path.join(this.buildRoot, name), sendLog);

      const clonedDir = await this.cloneAll(data.sourceUrl, path.join(this.buildRoot, name), sendLog);
      const rootDirectory = this.primaryRootDirectory(data);
      const buildDir = this.resolveBuildContext(clonedDir, rootDirectory);
      if (buildDir !== clonedDir) {
        sendLog(`[DockerService] Using root directory: ${rootDirectory}`);
      }
      fs.chmodSync(buildDir, 0o755);
      fs.readdirSync(buildDir).forEach(file => {
        try { fs.chmodSync(path.join(buildDir, file), 0o755); } catch { /* skip */ }
      });

      const preset = data.deployPreset.toUpperCase() as DEPLOY_OPTION;
      const composeFileExists = fs.existsSync(path.join(buildDir, 'docker-compose.yml'))
        || fs.existsSync(path.join(buildDir, 'docker-compose.yaml'));

      if (preset === DEPLOY_OPTION.COMPOSE && !composeFileExists) {
        throw new Error('docker-compose.yml not found.');
      }

      const hasCompose = preset === DEPLOY_OPTION.COMPOSE
        || (preset !== DEPLOY_OPTION.DOCKERFILE && composeFileExists);

      if (hasCompose) {
        sendLog('Detected docker-compose, starting build...');
        composeBuildDir = buildDir;
        this.writeComposeEnvFile(buildDir, data);
        const services = this.writeNoRestartOverride(buildDir, sendLog);
        onExpectedServices?.(services);
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', '-p', name ?? data.serviceName.toLowerCase(), 'up', '-d', '--build'], { cwd: buildDir, env: subprocessEnv() });
          proc.stdout.on('data', (chunk: Buffer) => this.emitOutputLines(chunk, sendLog, true));
          proc.stderr.on('data', (chunk: Buffer) => this.emitOutputLines(chunk, sendLog, true));
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker compose exited with code ${code}`)));
        });
      } else {
        sendLog('Detected Dockerfile, starting build...');
        const stream = await this.docker.buildImage({
          context: buildDir,
          src: fs.readdirSync(buildDir),
        }, { t: `${name}:${data.serviceVersion}` });

        await new Promise((resolve, reject) => {
          type BuildEvent = { stream?: string; error?: string };
          this.docker.modem.followProgress(stream, (err: Error | null, res: BuildEvent[]) => {
            if (err) return reject(err);
            const failed = res.find(r => r.error);
            if (failed) return reject(new Error(failed.error ?? 'Build failed'));
            resolve(res);
          }, (event: BuildEvent) => {
            if (event.stream) { const line = event.stream.trim(); log(line); sendLog(line); }
            if (event.error) { log(`BUILD ERROR: ${event.error}`); sendLog(`BUILD ERROR: ${event.error}`); }
          });
        });
        sendLog('Build done. Starting container...');
        await this.runService(
          data.serviceName,
          data.serviceVersion,
          this.resolvePortMappings(data),
          data.env,
        );
      }

      sendStatus('running');
      sendLog('Service redeployed successfully.');
      log('Redeploy success.');
      return true;
    } catch (error) {
      await this.cleanupFailedDeployment(name, composeBuildDir, sendLog);
      sendStatus('failed');
      sendLog(`ERROR: ${String(error)}`);
      log(error);
      return false;
    }
  }

  // 이미지로 빌드하는 함수
  async deployNewService(
    data: DeployCommand,
    emit: HubEmit,
    onExpectedServices?: ExpectedServicesCallback,
  ) {
    const si: number = Number(data.serviceIndex);
    const sendLog = (line: string) => emit('service-log', {
      serviceIndex: si,
      log: line,
      timestamp: new Date().toISOString(),
      source: 'agent',
      stream: 'deploy',
      containerName: data.serviceName.toLowerCase(),
    });
    const sendStatus = (status: string) => emit('service-status', { serviceIndex: si, status });
    const name = data.serviceName.toLowerCase();
    let composeBuildDir: string | null = null;

    try {
      sendStatus('building');
      sendLog(`Creating new Service '${name}@${data.serviceVersion}' | preset: ${data.deployPreset}`);
      this.removeBuildDir(path.join(this.buildRoot, name), sendLog);
      const clonedDir = await this.cloneAll(data.sourceUrl, path.join(this.buildRoot, name), sendLog);
      const rootDirectory = this.primaryRootDirectory(data);
      const buildDir = this.resolveBuildContext(clonedDir, rootDirectory);
      if (buildDir !== clonedDir) {
        sendLog(`[DockerService] Using root directory: ${rootDirectory}`);
      }
      fs.chmodSync(buildDir, 0o755);
      fs.readdirSync(buildDir).forEach(file => {
        try { fs.chmodSync(path.join(buildDir, file), 0o755); } catch { /* skip non-chmodable */ }
      });

      const preset = data.deployPreset.toUpperCase() as DEPLOY_OPTION;
      const composeFileExists = fs.existsSync(path.join(buildDir, 'docker-compose.yml'))
        || fs.existsSync(path.join(buildDir, 'docker-compose.yaml'));

      if (preset === DEPLOY_OPTION.COMPOSE && !composeFileExists) {
        throw new Error('docker-compose.yml not found. Change deploy option to DOCKERFILE or add docker-compose.yml to the repository.');
      }

      const hasCompose = preset === DEPLOY_OPTION.COMPOSE
        || (preset !== DEPLOY_OPTION.DOCKERFILE && composeFileExists);

      if (hasCompose) {
        sendLog('Detected docker-compose, starting build...');
        composeBuildDir = buildDir;
        this.writeComposeEnvFile(buildDir, data);
        const services = this.writeNoRestartOverride(buildDir, sendLog);
        onExpectedServices?.(services);
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', '-p', name, 'up', '-d', '--build'], { cwd: buildDir, env: subprocessEnv() });
          proc.stdout.on('data', (chunk: Buffer) => this.emitOutputLines(chunk, sendLog, true));
          proc.stderr.on('data', (chunk: Buffer) => this.emitOutputLines(chunk, sendLog, true));
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker compose exited with code ${code}`)));
        });
      } else {
        sendLog('Detected Dockerfile, starting build...');
        const stream = await this.docker.buildImage({
          context: buildDir,
          src: fs.readdirSync(buildDir)
        }, { t: `${data.serviceName.toLowerCase()}:${data.serviceVersion}` });

        await new Promise((resolve, reject) => {
          type BuildEvent = { stream?: string; error?: string };
          this.docker.modem.followProgress(stream, (err: Error | null, res: BuildEvent[]) => {
            if (err) return reject(err);
            const failed = res.find(r => r.error);
            if (failed) return reject(new Error(failed.error ?? 'Build failed'));
            resolve(res);
          }, (event: BuildEvent) => {
            if (event.stream) { const line = event.stream.trim(); log(line); sendLog(line); }
            if (event.error) { log(`BUILD ERROR: ${event.error}`); sendLog(`BUILD ERROR: ${event.error}`); }
          });
        });
        sendLog('Build done. Starting container...');
        await this.runService(
          data.serviceName,
          data.serviceVersion,
          this.resolvePortMappings(data),
          data.env,
        );
      }

      sendStatus('running');
      sendLog('Service started successfully.');
      log('Success.');
      return true;
    } catch (error) {
      await this.cleanupFailedDeployment(name, composeBuildDir, sendLog);
      sendStatus('failed');
      sendLog(`ERROR: ${String(error)}`);
      log(error);
      return false;
    }
  }
}
