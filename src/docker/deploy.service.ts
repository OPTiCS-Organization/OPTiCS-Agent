import { Injectable } from "@nestjs/common";
import { DeployCommand } from "src/service/dtos/DeployCommand.dto";
import { HubEmit } from "./types/HubEmit.type";
import { ExpectedServicesCallback } from "./types/ExpectedServicesCallback";
import { BuildWorkspaceService } from "./build-workspace.service";
import { spawn, spawnSync } from "child_process";
import { ConfigService } from "@nestjs/config";
import { DEPLOY_OPTION } from "src/global/DeployOptionEnum";
import { normalizeSourceRepositories, primaryRootDirectory, resolvePortMappings } from "./utility/deploy-command.util";
import { ServicePortMapping } from "src/global/types/Command.dto";
import { subprocessEnv } from "./utility/docker-cli";
import Docker from "dockerode";
import path from "path";
import log from "spectra-log";
import fs from "fs";
import { emitOutputLines } from "./utility/docker-output.util";
import { isContainerRuntime } from "./utility/runtime.util";
import { DeployOptions } from "./types/DeployOptions.type";
import { createServiceLogEmitter, createServiceStatusEmitter } from "./utility/emitters";
import { ServiceStatus } from "./types/ServiceStatus.type";
@Injectable()
export class DeployService {
  private docker: Docker;
  private buildRoot: string;
  private readonly preserveFailedDeployArtifacts = true;

  constructor(
    private readonly buildWorkspaceService: BuildWorkspaceService,
    private readonly configService: ConfigService,
  ) {
    this.buildRoot = configService.get<string>('OPTICS_BUILD_DIR') ?? path.join(process.cwd(), 'dist/build');
    this.docker = new Docker({
      socketPath: '/var/run/docker.sock'
      // For Remote Docker Connection
      // host: this.configService.getOrThrow<string>('REMOTE_DOCKER_HOST'),
      // port: this.configService.getOrThrow<number>('REMOTE_DOCKER_PORT')
    });
  };

  async deploy(data: DeployCommand, emit: HubEmit, deployOptions?: DeployOptions, onExpectedServices?: ExpectedServicesCallback) {
    const serviceName = data.serviceName.toLowerCase();
    const { sendLog } = createServiceLogEmitter(emit, { serviceName });
    const { sendStatus } = createServiceStatusEmitter(emit, { serviceName });
    let composeBuildDir: string | null = null;
    const clonedDir = await this.cloneAll(data.sourceUrl, path.join(this.buildRoot, serviceName), sendLog);
    try {
      sendStatus(ServiceStatus.BUILDING);
      sendLog(`Redeploying service ${serviceName}@${data.serviceVersion}`);

      try {
        // serviceName이 포함된 컨테이너들을 반환하는가?
        const existing = this.docker.getContainer(serviceName);
        const info = await existing.inspect() as { State: { Running: boolean } };
        if (info.State.Running) {
          sendLog(`Stopping existing container '${serviceName}'...`);
          await existing.stop();
        }
        sendLog(`Removing existing container '${serviceName}'...`);
        await existing.remove();
      } catch {
        sendLog(`No running container found. Proceeding deploy.`);
      }

      this.buildWorkspaceService.removeBuildDir(path.join(this.buildRoot, serviceName), sendLog);
      const rootDirectory = primaryRootDirectory(data);
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
          proc.stdout.on('data', (chunk: Buffer) => emitOutputLines(chunk, sendLog, true));
          proc.stderr.on('data', (chunk: Buffer) => emitOutputLines(chunk, sendLog, true));
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker compose exited with code ${code}`)));
        });
      } else {
        sendLog('Detected Dockerfile, starting build...');
        const stream = await this.docker.buildImage({
          context: buildDir,
          src: fs.readdirSync(buildDir),
        }, { t: `${serviceName}:${data.serviceVersion}` });

        await new Promise((resolve, reject) => {
          type BuildEvent = { stream?: string; error?: string };
          this.docker.modem.followProgress(stream, (err: Error | null, res: BuildEvent[]) => {
            if (err) return reject(err);
            const failed = res.find(r => r.error);
            if (failed) return reject(new Error(failed.error ?? 'Build failed'));
            resolve(res);
          }, (event: BuildEvent) => {
            if (event.stream) {
              const line = event.stream.trim();
              log(line);
              sendLog(line);
            }
            if (event.error) {
              log(`BUILD ERROR: ${event.error}`);
              sendLog(`BUILD ERROR: ${event.error}`);
            }
          });
        });
        sendLog('Build done. Starting container...');
        sendStatus(ServiceStatus.STARTING);
        await this.runService(
          data.serviceName,
          data.serviceVersion,
          resolvePortMappings(data),
          data.env,
        );
      }

      sendLog('Service redeployed successfully.');
      sendStatus(ServiceStatus.RUNNING);
      log('Redeploy success.');
      return true;
    } catch (error) {
      await this.cleanupFailedDeployment(serviceName, composeBuildDir, sendLog);
      sendStatus('failed');
      sendLog(`ERROR: ${String(error)}`);
      log(error);
      return false;
    }
  }

  private writeNoRestartOverride(buildDir: string, sendLog: (line: string) => void): string[] {
    let services: string[] = [];
    try {
      const result = spawnSync(
        'docker', ['compose', 'config', '--services'],
        { cwd: buildDir, encoding: 'utf8', env: subprocessEnv() },
      );

      if (result.status !== 0) {
        const errorMessage = result.stderr?.trim() || 'docker compose config --services failed.';
        sendLog(`[DockerService] Could not resolve compose service list for restart override.\n  ${errorMessage}`);
        throw new Error('Failed to generate compose restart override.');
      }
      services = result.stdout.split('\n').map(s => s.trim()).filter(Boolean);
    } catch (error) {
      if (error instanceof Error && error.message === 'Failed to generate compose restart override.') {
        throw error;
      }
      sendLog(`[DockerService] Could not resolve compose service list for restart override.\n  ${String(error)}`);
      throw new Error('Failed to generate compose restart override.');
    }

    if (services.length === 0) {
      sendLog('[DockerService] Compose service list is empty; restart override cannot be generated.');
      throw new Error('Failed to generate compose restart override.');
    }

    const overrideContent = [
      'services:',
      ...services.map(s => `  ${s}:\n    restart: "no"`),
    ].join('\n') + '\n';

    try {
      fs.writeFileSync(path.join(buildDir, 'docker-compose.override.yml'), overrideContent);
    } catch (error) {
      sendLog(`[DockerService] Could not write compose restart override.\n  ${String(error)}`);
      throw new Error('Failed to generate compose restart override.');
    }

    sendLog(`[DockerService] Injected restart: "no" override for services: ${services.join(', ')}`);
    return services;
  }

  // 컨테이너 이름을 받아 시작 하는 함수
  private async runService(
    serviceName: string,
    serviceVersion: string,
    portMappings: ServicePortMapping[],
    env?: Record<string, string>,
  ) {
    const portBindings: Record<string, { HostPort: string }[]> = {};
    const exposedPorts: Record<string, object> = {};
    for (const mapping of portMappings) {
      const key = `${mapping.containerPort}/tcp`;
      portBindings[key] = [{ HostPort: String(mapping.hostPort) }];
      exposedPorts[key] = {};
    }

    const container = await this.docker.createContainer({
      Image: `${serviceName.toLowerCase()}:${serviceVersion}`,
      name: serviceName.toLowerCase(),
      Env: env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : undefined,
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        RestartPolicy: { Name: 'no' },
        ExtraHosts: ['host.docker.internal:host-gateway'],
      },
    });

    await container.start();
    log('Started Service');
  }

  private resolveBuildContext(baseDir: string, rootDirectory: string | null | undefined): string {
    const cleanRoot = rootDirectory?.trim();
    if (!cleanRoot || cleanRoot === '.') return baseDir;

    const resolved = path.resolve(baseDir, cleanRoot);
    const relative = path.relative(baseDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Root directory must stay inside the cloned repository.');
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Root directory not found: ${cleanRoot}`);
    }
    return resolved;
  }
  // ServiceForm의 컨테이너 포트 입력값을 PORT 환경변수로 자동 주입하여
  // compose 파일이 ${PORT:-...} 컨벤션을 따를 때 정상 동작하게 한다.
  // 사용자가 env에 PORT를 직접 명시했다면 그것을 우선한다.
  private writeComposeEnvFile(buildDir: string, data: DeployCommand): void {
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

  private async cleanupFailedDeployment(
    projectName: string,
    composeBuildDir: string | null,
    sendLog: (line: string) => void,
  ) {
    if (this.preserveFailedDeployArtifacts) {
      sendLog('[DockerService] Failed deploy cleanup is temporarily disabled; leaving containers and build directory in place.');
      return;
    }

    if (composeBuildDir) {
      await this.downComposeProject(projectName, composeBuildDir, sendLog);
    }
    this.buildWorkspaceService.removeBuildDir(path.join(this.buildRoot, projectName), sendLog);
  }

  private async cloneAll(
    sourceUrl: DeployCommand['sourceUrl'],
    baseDir: string,
    sendLog: (line: string) => void,
  ): Promise<string> {
    const sources = normalizeSourceRepositories(sourceUrl);
    const urls = sources.map(source => source.url);

    if (urls.length === 1) {
      // 단일 URL: baseDir에 바로 클론
      await this.cloneInGitContainer(urls[0], baseDir, sendLog);
      sendLog('[DockerService] Clone done.');
      return baseDir;
    }

    // 복수 URL: baseDir/{repoName}/ 에 각각 클론, 첫 번째가 메인
    fs.mkdirSync(baseDir, { recursive: true });
    for (const url of urls) {
      const repoDir = path.join(baseDir, this.repoName(url));
      await this.cloneInGitContainer(url, repoDir, sendLog);
    }
    sendLog('[DockerService] All Repository Successfully Cloned.');
    return path.join(baseDir, this.repoName(urls[0]));
  }

  private repoName(url: string): string {
    return url.split('/').pop()?.replace(/\.git$/, '') ?? 'repo';
  }

  private async cloneInGitContainer(repoUrl: string, targetDir: string, sendLog: (line: string) => void): Promise<void> {
    const relativeTarget = path.relative(this.buildRoot, targetDir);
    if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
      throw new Error('Clone target must stay inside the build workspace.');
    }
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });

    const containerTarget = `/workspace/${relativeTarget.split(path.sep).join('/')}`;
    const mount = `${this.buildWorkspaceService.cloneWorkspaceMount()}:/workspace`;
    sendLog(`[DockerService] Cloning source in git container...\nFrom: ${repoUrl}\nInto: ${containerTarget}`);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('docker', ['run', '--rm', ...this.dockerRunUserArgs(), '-v', mount, 'alpine/git', 'clone', repoUrl, containerTarget]);
      proc.stdout.on('data', (chunk: Buffer) => emitOutputLines(chunk, sendLog));
      proc.stderr.on('data', (chunk: Buffer) => emitOutputLines(chunk, sendLog));
      proc.on('error', reject);
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`git clone container exited with code ${code}`)));
    });
  }

  private async downComposeProject(
    projectName: string,
    cwd: string,
    sendLog: (line: string) => void,
  ) {
    if (!fs.existsSync(cwd)) return;
    sendLog(`[DockerService] Cleaning up failed compose project '${projectName}'...`);
    await new Promise<void>((resolve) => {
      const proc = spawn('docker', ['compose', '-p', projectName, 'down', '--remove-orphans'], { cwd, env: subprocessEnv() });
      proc.stdout.on('data', (chunk: Buffer) => emitOutputLines(chunk, sendLog, true));
      proc.stderr.on('data', (chunk: Buffer) => emitOutputLines(chunk, sendLog, true));
      proc.on('close', () => resolve());
      proc.on('error', (error) => {
        sendLog(`[DockerService] Failed to clean up compose project '${projectName}': ${String(error)}`);
        resolve();
      });
    });
  }

  private dockerRunUserArgs(): string[] {
    if (isContainerRuntime()) return [];
    if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return [];

    return ['-u', `${process.getuid()}:${process.getgid()}`];
  }

  // // 이미지로 빌드하는 함수
  // async deployNewService(
  //   data: DeployCommand,
  //   emit: HubEmit,
  //   onExpectedServices?: ExpectedServicesCallback,
  // ) {
  //   const si: number = Number(data.serviceIndex);
  //   const sendLog = (line: string) => emit('service-log', {
  //     serviceIndex: si,
  //     log: line,
  //     timestamp: new Date().toISOString(),
  //     source: 'agent',
  //     stream: 'deploy',
  //     containerName: data.serviceName.toLowerCase(),
  //   });
  //   const sendStatus = (status: string) => emit('service-status', { serviceIndex: si, status });
  //   const name = data.serviceName.toLowerCase();
  //   let composeBuildDir: string | null = null;

  //   try {
  //     sendStatus('building');
  //     sendLog(`Creating new Service '${name}@${data.serviceVersion}' | preset: ${data.deployPreset}`);
  //     removeBuildDir(path.join(this.buildRoot, name), sendLog);
  //     const clonedDir = await cloneAll(data.sourceUrl, path.join(this.buildRoot, name), sendLog);
  //     const rootDirectory = primaryRootDirectory(data);
  //     const buildDir = this.resolveBuildContext(clonedDir, rootDirectory);
  //     if (buildDir !== clonedDir) {
  //       sendLog(`[DockerService] Using root directory: ${rootDirectory}`);
  //     }
  //     fs.chmodSync(buildDir, 0o755);
  //     fs.readdirSync(buildDir).forEach(file => {
  //       try { fs.chmodSync(path.join(buildDir, file), 0o755); } catch { /* skip non-chmodable */ }
  //     });

  //     const preset = data.deployPreset.toUpperCase() as DEPLOY_OPTION;
  //     const composeFileExists = fs.existsSync(path.join(buildDir, 'docker-compose.yml'))
  //       || fs.existsSync(path.join(buildDir, 'docker-compose.yaml'));

  //     if (preset === DEPLOY_OPTION.COMPOSE && !composeFileExists) {
  //       throw new Error('docker-compose.yml not found. Change deploy option to DOCKERFILE or add docker-compose.yml to the repository.');
  //     }

  //     const hasCompose = preset === DEPLOY_OPTION.COMPOSE
  //       || (preset !== DEPLOY_OPTION.DOCKERFILE && composeFileExists);

  //     if (hasCompose) {
  //       sendLog('Detected docker-compose, starting build...');
  //       composeBuildDir = buildDir;
  //       this.writeComposeEnvFile(buildDir, data);
  //       const services = writeNoRestartOverride(buildDir, sendLog);
  //       onExpectedServices?.(services);
  //       await new Promise<void>((resolve, reject) => {
  //         const proc = spawn('docker', ['compose', '-p', name, 'up', '-d', '--build'], { cwd: buildDir, env: subprocessEnv() });
  //         proc.stdout.on('data', (chunk: Buffer) => emitOutputLines(chunk, sendLog, true));
  //         proc.stderr.on('data', (chunk: Buffer) => emitOutputLines(chunk, sendLog, true));
  //         proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker compose exited with code ${code}`)));
  //       });
  //     } else {
  //       sendLog('Detected Dockerfile, starting build...');
  //       const stream = await this.docker.buildImage({
  //         context: buildDir,
  //         src: fs.readdirSync(buildDir)
  //       }, { t: `${data.serviceName.toLowerCase()}:${data.serviceVersion}` });

  //       await new Promise((resolve, reject) => {
  //         type BuildEvent = { stream?: string; error?: string };
  //         this.docker.modem.followProgress(stream, (err: Error | null, res: BuildEvent[]) => {
  //           if (err) return reject(err);
  //           const failed = res.find(r => r.error);
  //           if (failed) return reject(new Error(failed.error ?? 'Build failed'));
  //           resolve(res);
  //         }, (event: BuildEvent) => {
  //           if (event.stream) { const line = event.stream.trim(); log(line); sendLog(line); }
  //           if (event.error) { log(`BUILD ERROR: ${event.error}`); sendLog(`BUILD ERROR: ${event.error}`); }
  //         });
  //       });
  //       sendLog('Build done. Starting container...');
  //       await runService(
  //         data.serviceName,
  //         data.serviceVersion,
  //         resolvePortMappings(data),
  //         data.env,
  //       );
  //     }

  //     sendStatus('running');
  //     sendLog('Service started successfully.');
  //     log('Success.');
  //     return true;
  //   } catch (error) {
  //     await this.cleanupFailedDeployment(name, composeBuildDir, sendLog);
  //     sendStatus('failed');
  //     sendLog(`ERROR: ${String(error)}`);
  //     log(error);
  //     return false;
  //   }
  // }
}
