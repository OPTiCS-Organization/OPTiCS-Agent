import { Global, Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Docker from "dockerode";
import path from "path";
import fs from "fs";
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from "child_process";
import { Readable } from "stream";
import log from "spectra-log";
import { DeployCommand } from "../service/dtos/DeployCommand.dto";
import { GitService } from "./git.service";
import { DEPLOY_OPTION } from "../global/DeployOptionEnum";

type StatusEmit = (raw: string) => void | Promise<void>;
type HubEmit = (event: 'service-status' | 'service-log' | 'container-status', payload: object) => void;
type ContainerStatus = 'building' | 'starting' | 'running' | 'stopped' | 'failed' | 'removed';
type ContainerSnapshot = {
  name: string;
  status: ContainerStatus;
  service?: string;
  exitCode?: number | null;
  health?: string | null;
};
type ExpectedServicesCallback = (services: string[]) => void;

@Global()
@Injectable()
export class DockerService implements OnModuleInit {
  private docker: Docker;
  private statusEmit: StatusEmit | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly gitService: GitService,
  ) {
    this.docker = new Docker({
      socketPath: '/var/run/docker.sock'
      // For Remote Docker Connection
      // host: this.configService.getOrThrow<string>('REMOTE_DOCKER_HOST'),
      // port: this.configService.getOrThrow<number>('REMOTE_DOCKER_PORT')
    });
  }

  registerStatusEmit(fn: StatusEmit) {
    this.statusEmit = fn;
  }

  private logStreams = new Map<string, Readable | ChildProcessWithoutNullStreams>();

  private normalizeContainerStatus(state?: string, exitCode?: number | null, health?: string | null): ContainerStatus {
    const normalizedState = (state ?? '').toLowerCase();
    const normalizedHealth = (health ?? '').toLowerCase();
    if (normalizedState === 'removing' || normalizedState === 'removed') return 'removed';
    if (normalizedState === 'created' || normalizedState === 'restarting') return 'starting';
    if (normalizedState === 'running') {
      if (normalizedHealth === 'unhealthy') return 'failed';
      if (normalizedHealth === 'starting') return 'starting';
      return 'running';
    }
    if (normalizedState === 'exited' || normalizedState === 'dead') return exitCode && exitCode !== 0 ? 'failed' : 'stopped';
    if (normalizedState === 'paused') return 'stopped';
    return 'stopped';
  }

  private parseJsonOutput<T = Record<string, unknown>>(output: string): T[] {
    const trimmed = output.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed) as T | T[];
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return trimmed.split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .flatMap(line => {
          try { return [JSON.parse(line) as T]; } catch { return []; }
        });
    }
  }

  private healthFromStatus(status?: string): string | null {
    if (!status) return null;
    const lower = status.toLowerCase();
    if (lower.includes('unhealthy')) return 'unhealthy';
    if (lower.includes('health: starting') || lower.includes('(health: starting)')) return 'starting';
    if (lower.includes('healthy')) return 'healthy';
    return null;
  }

  private labelsToRecord(labels?: string): Record<string, string> {
    if (!labels) return {};
    return Object.fromEntries(
      labels.split(',')
        .map(label => label.split('='))
        .filter(([key]) => Boolean(key))
        .map(([key, ...value]) => [key, value.join('=')]),
    );
  }

  private inspectDockerfileContainer(serviceName: string): ContainerSnapshot[] {
    const result = spawnSync('docker', ['inspect', serviceName], { encoding: 'utf8' });
    if (result.status !== 0) return [];
    return this.parseJsonOutput<Record<string, any>>(result.stdout).map(container => {
      const state = container.State ?? {};
      const exitCode = typeof state.ExitCode === 'number' ? state.ExitCode : null;
      const health = typeof state.Health?.Status === 'string' ? state.Health.Status : null;
      return {
        name: container.Name ? String(container.Name).replace(/^\//, '') : serviceName,
        status: this.normalizeContainerStatus(state.Status, exitCode, health),
        exitCode,
        health,
      };
    });
  }

  private listComposeContainers(projectName: string): ContainerSnapshot[] {
    const buildDir = path.join(__dirname, '../build', projectName);
    if (fs.existsSync(buildDir)) {
      const composeResult = spawnSync(
        'docker',
        ['compose', '-p', projectName, 'ps', '-a', '--format', 'json'],
        { cwd: buildDir, encoding: 'utf8' },
      );
      if (composeResult.status === 0) {
        const composeRows = this.parseJsonOutput<Record<string, any>>(composeResult.stdout);
        if (composeRows.length > 0) {
          return composeRows.map(row => {
            const exitCode = typeof row.ExitCode === 'number' ? row.ExitCode : Number.isFinite(Number(row.ExitCode)) ? Number(row.ExitCode) : null;
            const health = typeof row.Health === 'string' ? row.Health : this.healthFromStatus(row.Status);
            return {
              name: String(row.Name ?? row.Names ?? row.ID ?? ''),
              service: row.Service ? String(row.Service) : undefined,
              status: this.normalizeContainerStatus(row.State, exitCode, health),
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
    return this.parseJsonOutput<Record<string, any>>(psResult.stdout).map(row => {
      const labels = this.labelsToRecord(row.Labels ? String(row.Labels) : '');
      const health = this.healthFromStatus(row.Status ? String(row.Status) : undefined);
      return {
        name: String(row.Names ?? ''),
        service: labels['com.docker.compose.service'],
        status: this.normalizeContainerStatus(row.State ? String(row.State) : undefined, null, health),
        exitCode: null,
        health,
      };
    }).filter(container => container.name);
  }

  async getContainerSnapshot(serviceName: string, deployPreset: DEPLOY_OPTION): Promise<ContainerSnapshot[]> {
    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;
    return isCompose
      ? this.listComposeContainers(serviceName)
      : this.inspectDockerfileContainer(serviceName);
  }

  private async downComposeProject(
    projectName: string,
    cwd: string,
    sendLog: (line: string) => void,
  ) {
    if (!fs.existsSync(cwd)) return;
    sendLog(`[DockerService] Cleaning up failed compose project '${projectName}'...`);
    await new Promise<void>((resolve) => {
      const proc = spawn('docker', ['compose', '-p', projectName, 'down', '--remove-orphans'], { cwd });
      proc.stdout.on('data', (chunk: Buffer) => { const line = chunk.toString().trim(); if (line) { log(line); sendLog(line); } });
      proc.stderr.on('data', (chunk: Buffer) => { const line = chunk.toString().trim(); if (line) { log(line); sendLog(line); } });
      proc.on('close', () => resolve());
      proc.on('error', (error) => {
        sendLog(`[DockerService] Failed to clean up compose project '${projectName}': ${String(error)}`);
        resolve();
      });
    });
  }

  async streamContainerLog(
    containerName: string,
    deployPreset: DEPLOY_OPTION,
    onLog: (line: string) => void,
  ): Promise<void> {
    if (this.logStreams.has(containerName)) {
      this.stopContainerLog(containerName);
    }

    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;
    log(`[DockerService] streamContainerLog | deployPreset="${deployPreset}" | isCompose=${isCompose}`);

    if (isCompose) {
      // Compose: docker compose -p {name} logs --follow --tail 10000
      const proc = spawn('docker', ['compose', '-p', containerName, 'logs', '--follow', '--tail', '10000'], {});
      this.logStreams.set(containerName, proc);
      proc.stdout.on('data', (chunk: Buffer) => {
        chunk.toString('utf8').split('\n').filter(l => l.trim()).forEach(line => onLog(line));
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        chunk.toString('utf8').split('\n').filter(l => l.trim()).forEach(line => onLog(`ERROR: ${line}`));
      });
      proc.on('close', () => {
        if (this.logStreams.get(containerName) === proc) {
          this.logStreams.delete(containerName);
        }
      });
      log(`[DockerService] streamContainerLog (compose) started | project=${containerName}`);
    } else {
      try {
        const container = this.docker.getContainer(containerName);
        const stream = await container.logs({ follow: true, stdout: true, stderr: true, tail: 10000 }) as unknown as Readable;
        this.logStreams.set(containerName, stream);
        stream.on('data', (chunk: Buffer) => {
          const raw = chunk.length > 8 ? chunk.subarray(8).toString('utf8') : chunk.toString('utf8');
          raw.split('\n').filter(l => l.trim()).forEach(line => onLog(line));
        });
        stream.on('end', () => { this.logStreams.delete(containerName); });
        log(`[DockerService] streamContainerLog started | name=${containerName}`);
      } catch (e) {
        log(`[DockerService] streamContainerLog failed | name=${containerName} | ${String(e)}`);
      }
    }
  }

  stopContainerLog(containerName: string): void {
    const stream = this.logStreams.get(containerName);
    if (stream) {
      if ('kill' in stream) {
        stream.kill();
      } else {
        stream.destroy();
      }
      this.logStreams.delete(containerName);
      log(`[DockerService] streamContainerLog stopped | name=${containerName}`);
    }
  }

  /**
   * Done: Log
   * 서비스 시작 시 도커 이벤트 소켓 구독
   */
  onModuleInit() {
    this.docker.getEvents({}, (err, stream) => {
      if (err || !stream) {
        log(`[DockerService] Failed to subscribe to Docker events: ${String(err)}`, 500, 'ERROR');
        return;
      }
      stream.on('data', (chunk: Buffer) => {
        try {
          const event = JSON.parse(chunk.toString()) as {
            Type: string;
            Action: string;
            Actor: { Attributes: Record<string, string> };
          };
          if (event.Type !== 'container') return;

          const name = event.Actor.Attributes['name'] ?? '';
          const action = event.Action;

          if (!this.statusEmit) return;

          switch (action) {
            case 'die':
            case 'stop':
            case 'kill': {
              const exitCode = event.Actor.Attributes['exitCode'] ?? '0';
              const status = exitCode !== '0' ? 'failed' : 'stopped';
              log(`[DockerService] Stopping Container '${name}'...\nExit Code: ${exitCode}\nExit State: ${status}`);
              void this.statusEmit(`${status}:${name}`);
              break;
            }
            case 'create': {
              void this.statusEmit(`starting:${name}`);
              break;
            }
            case 'start': {
              log(`[DockerService] Starting Container '${name}'...`);
              void this.statusEmit(`running:${name}`);
              break;
            }
            case 'restart': {
              log(`[DockerService] Restarting Container '${name}'...`);
              void this.statusEmit(`restarting:${name}`);
              break;
            }
            case 'destroy': {
              log(`[DockerService] Removing Container '${name}'...`)
              void this.statusEmit(`removed:${name}`);
            }
          }
        } catch {
          // JSON 파싱 실패 무시
        }
      });
    });
  }

  // IN: https://www.github.com/acorn497/testproject.git
  // RETURN: https://www.github.com/acotn497/testproject
  private repoName(url: string): string {
    return url.split('/').pop()?.replace(/\.git$/, '') ?? 'repo';
  }

  private async cloneAll(
    sourceUrl: string | string[],
    baseDir: string,
    sendLog: (line: string) => void,
  ): Promise<string> {
    const urls = Array.isArray(sourceUrl) ? sourceUrl : [sourceUrl];

    if (urls.length === 1) {
      // 단일 URL: baseDir에 바로 클론
      sendLog(`[DockerService] Cloning Source...\nFrom: ${urls[0]}`);
      await this.gitService.clone(urls[0], baseDir);
      sendLog('[DockerService] Clone done.');
      return baseDir;
    }

    // 복수 URL: baseDir/{repoName}/ 에 각각 클론, 첫 번째가 메인
    for (const url of urls) {
      const repoDir = path.join(baseDir, this.repoName(url));
      sendLog(`[DockerService] Cloning Source...\nFrom: $${url}\nInto: ${this.repoName(url)}`)
      await this.gitService.clone(url, repoDir);
    }
    sendLog('[DockerService] All Repository Successfully Cloned.');
    return path.join(baseDir, this.repoName(urls[0]));
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

  // 컨테이너 이름을 받아 시작 하는 함수
  async runService(
    serviceName: string,
    serviceVersion: string,
    hostPort: number,
    containerPort: number,
    env?: Record<string, string>,
  ) {
    const portBindings: Record<string, { HostPort: string }[]> = {};
    const exposedPorts: Record<string, object> = {};
    const key = `${containerPort}/tcp`;
    portBindings[key] = [{ HostPort: String(hostPort) }];
    exposedPorts[key] = {};

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

  async stopService(
    serviceName: string,
    deployPreset: DEPLOY_OPTION,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const si = serviceName.toLowerCase();
    const sendLog = (line: string) => emit('service-log', { serviceName, log: line, timestamp: new Date().toISOString() });
    const sendStatus = (status: string) => emit('service-status', { serviceName, status });
    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;

    try {
      sendLog(`Stopping service '${si}'...`);
      if (isCompose) {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', '-p', si, 'stop']);
          proc.stderr.on('data', (chunk: Buffer) => sendLog(chunk.toString().trim()));
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker compose stop exited with code ${code}`)));
        });
      } else {
        await this.docker.getContainer(si).stop();
      }
      sendStatus('stopped');
      sendLog(`Service '${si}' stopped successfully.`);
      log(`[DockerService] stopService success | name=${si}`);
    } catch (e) {
      sendStatus('failed');
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] stopService failed | name=${si} | ${String(e)}`);
    }
  }

  private async resolveComposeContainerTarget(containerName: string): Promise<{ projectName: string; serviceName: string }> {
    const fallback = containerName.toLowerCase();
    try {
      const inspect = await this.docker.getContainer(containerName).inspect() as { Config?: { Labels?: Record<string, string> } };
      const labels = inspect.Config?.Labels ?? {};
      return {
        projectName: labels['com.docker.compose.project'] ?? fallback,
        serviceName: labels['com.docker.compose.service'] ?? fallback,
      };
    } catch {
      return { projectName: fallback, serviceName: fallback };
    }
  }

  async startContainer(
    containerName: string,
    deployPreset: DEPLOY_OPTION,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const sendLog = (line: string) => emit('service-log', { serviceName: containerName, log: line, timestamp: new Date().toISOString() });
    const sendStatus = (status: string) => emit('service-status', { serviceName: containerName, status });
    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;

    try {
      sendStatus('starting');
      sendLog(`Starting container '${containerName}'...`);
      if (isCompose) {
        const { projectName, serviceName } = await this.resolveComposeContainerTarget(containerName);
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', '-p', projectName, 'start', serviceName]);
          proc.stderr.on('data', (chunk: Buffer) => sendLog(chunk.toString().trim()));
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker compose start exited with code ${code}`)));
        });
      } else {
        await this.docker.getContainer(containerName).start();
      }
      sendStatus('running');
      sendLog(`Container '${containerName}' started successfully.`);
      log(`[DockerService] startContainer success | name=${containerName}`);
    } catch (e) {
      sendStatus('failed');
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] startContainer failed | name=${containerName} | ${String(e)}`);
    }
  }

  async stopContainer(
    containerName: string,
    deployPreset: DEPLOY_OPTION,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const sendLog = (line: string) => emit('service-log', { serviceName: containerName, log: line, timestamp: new Date().toISOString() });
    const sendStatus = (status: string) => emit('service-status', { serviceName: containerName, status });
    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;

    try {
      sendLog(`Stopping container '${containerName}'...`);
      if (isCompose) {
        const { projectName, serviceName } = await this.resolveComposeContainerTarget(containerName);
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', '-p', projectName, 'stop', serviceName]);
          proc.stderr.on('data', (chunk: Buffer) => sendLog(chunk.toString().trim()));
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker compose stop exited with code ${code}`)));
        });
      } else {
        await this.docker.getContainer(containerName).stop();
      }
      sendStatus('stopped');
      sendLog(`Container '${containerName}' stopped successfully.`);
      log(`[DockerService] stopContainer success | name=${containerName}`);
    } catch (e) {
      sendStatus('failed');
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] stopContainer failed | name=${containerName} | ${String(e)}`);
    }
  }

  async restartService(
    serviceName: string,
    deployPreset: DEPLOY_OPTION,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const si = serviceName.toLowerCase();
    const sendLog = (line: string) => emit('service-log', { serviceName, log: line, timestamp: new Date().toISOString() });
    const sendStatus = (status: string) => emit('service-status', { serviceName, status });
    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;

    try {
      sendStatus('restarting');
      sendLog(`Restarting service '${si}'...`);
      if (isCompose) {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', '-p', si, 'restart']);
          proc.stderr.on('data', (chunk: Buffer) => sendLog(chunk.toString().trim()));
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker compose restart exited with code ${code}`)));
        });
      } else {
        await this.docker.getContainer(si).restart();
      }
      sendStatus('running');
      sendLog(`Service '${si}' restarted successfully.`);
      log(`[DockerService] restartService success | name=${si}`);
    } catch (e) {
      sendStatus('failed');
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] restartService failed | name=${si} | ${String(e)}`);
    }
  }

  async restartContainer(
    containerName: string,
    deployPreset: DEPLOY_OPTION,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const sendLog = (line: string) => emit('service-log', { serviceName: containerName, log: line, timestamp: new Date().toISOString() });
    const sendStatus = (status: string) => emit('service-status', { serviceName: containerName, status });
    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;

    try {
      sendStatus('restarting');
      sendLog(`Restarting container '${containerName}'...`);
      if (isCompose) {
        const { projectName, serviceName } = await this.resolveComposeContainerTarget(containerName);
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', '-p', projectName, 'restart', serviceName]);
          proc.stderr.on('data', (chunk: Buffer) => sendLog(chunk.toString().trim()));
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker compose restart exited with code ${code}`)));
        });
      } else {
        await this.docker.getContainer(containerName).restart();
      }
      sendStatus('running');
      sendLog(`Container '${containerName}' restarted successfully.`);
      log(`[DockerService] restartContainer success | name=${containerName}`);
    } catch (e) {
      sendStatus('failed');
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] restartContainer failed | name=${containerName} | ${String(e)}`);
    }
  }

  async deleteService(
    serviceName: string,
    deployPreset: DEPLOY_OPTION,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const si = serviceName.toLowerCase();
    const sendLog = (line: string) => emit('service-log', { serviceName, log: line, timestamp: new Date().toISOString() });
    const sendStatus = (status: string) => emit('service-status', { serviceName, status });
    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;

    try {
      sendLog(`Deleting service '${si}'...`);
      if (isCompose) {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', '-p', si, 'down', '--rmi', 'all', '--volumes']);
          proc.stdout.on('data', (chunk: Buffer) => sendLog(chunk.toString().trim()));
          proc.stderr.on('data', (chunk: Buffer) => sendLog(chunk.toString().trim()));
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker compose down exited with code ${code}`)));
        });
      } else {
        const container = this.docker.getContainer(si);
        const info = await container.inspect() as { State: { Running: boolean } };
        if (info.State.Running) {
          sendLog(`Stopping container '${si}'...`);
          await container.stop();
        }
        await container.remove();
        sendLog(`Container '${si}' removed.`);
        try {
          await this.docker.getImage(si).remove();
          sendLog(`Image '${si}' removed.`);
        } catch {
          sendLog(`No image found for '${si}', skipping.`);
        }
      }
      fs.rmSync(path.join(__dirname, '../build', si), { recursive: true, force: true });
      sendStatus('removed');
      sendLog(`Service '${si}' deleted successfully.`);
      log(`[DockerService] deleteService success | name=${si}`);
    } catch (e) {
      sendStatus('failed');
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] deleteService failed | name=${si} | ${String(e)}`);
    }
  }

  async redeployService(
    data: DeployCommand,
    emit: HubEmit,
    onExpectedServices?: ExpectedServicesCallback,
  ) {
    const si: number = Number(data.serviceIndex);
    const sendLog = (line: string) => emit('service-log', { serviceIndex: si, log: line, timestamp: new Date().toISOString() });
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
      fs.rmSync(path.join(__dirname, '../build', name), { recursive: true, force: true });

      const clonedDir = await this.cloneAll(data.sourceUrl, path.join(__dirname, '../build', name), sendLog);
      const buildDir = this.resolveBuildContext(clonedDir, data.rootDirectory);
      if (buildDir !== clonedDir) {
        sendLog(`[DockerService] Using root directory: ${data.rootDirectory}`);
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
        if (data.env) {
          const envContent = Object.entries(data.env).map(([k, v]) => `${k}=${v}`).join('\n');
          fs.writeFileSync(path.join(buildDir, '.env'), envContent);
        }
        const services = this.writeNoRestartOverride(buildDir, sendLog);
        onExpectedServices?.(services);
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', '-p', name ?? data.serviceName.toLowerCase(), 'up', '-d', '--build'], { cwd: buildDir });
          proc.stdout.on('data', (chunk: Buffer) => { const line = chunk.toString().trim(); log(line); sendLog(line); });
          proc.stderr.on('data', (chunk: Buffer) => { const line = chunk.toString().trim(); log(line); sendLog(line); });
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
          data.serviceHostPort ?? data.servicePort,
          data.serviceContainerPort ?? data.servicePort,
          data.env,
        );
      }

      sendStatus('running');
      sendLog('Service redeployed successfully.');
      log('Redeploy success.');
      return true;
    } catch (error) {
      if (composeBuildDir) {
        await this.downComposeProject(name, composeBuildDir, sendLog);
      }
      fs.rmSync(path.join(__dirname, '../build', name), { recursive: true, force: true });
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
        { cwd: buildDir, encoding: 'utf8' },
      );

      if (result.status !== 0) {
        sendLog('[DockerService] Could not resolve service list for override, skipping.');
        return [];
      }
      services = result.stdout.split('\n').map(s => s.trim()).filter(Boolean);
    } catch {
      sendLog('[DockerService] Could not resolve service list for override, skipping.');
      return [];
    }

    if (services.length === 0) return [];

    const overrideContent = [
      'services:',
      ...services.map(s => `  ${s}:\n    restart: "no"`),
    ].join('\n') + '\n';

    fs.writeFileSync(path.join(buildDir, 'docker-compose.override.yml'), overrideContent);
    sendLog(`[DockerService] Injected restart: "no" override for services: ${services.join(', ')}`);
    return services;
  }

  // 이미지로 빌드하는 함수
  async deployNewService(
    data: DeployCommand,
    emit: HubEmit,
    onExpectedServices?: ExpectedServicesCallback,
  ) {
    const si: number = Number(data.serviceIndex);
    const sendLog = (line: string) => emit('service-log', { serviceIndex: si, log: line, timestamp: new Date().toISOString() });
    const sendStatus = (status: string) => emit('service-status', { serviceIndex: si, status });
    const name = data.serviceName.toLowerCase();
    let composeBuildDir: string | null = null;

    try {
      sendStatus('building');
      sendLog(`Creating new Service '${name}@${data.serviceVersion}' | preset: ${data.deployPreset}`);
      const clonedDir = await this.cloneAll(data.sourceUrl, path.join(__dirname, '../build', name), sendLog);
      const buildDir = this.resolveBuildContext(clonedDir, data.rootDirectory);
      if (buildDir !== clonedDir) {
        sendLog(`[DockerService] Using root directory: ${data.rootDirectory}`);
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
        if (data.env) {
          const envContent = Object.entries(data.env).map(([k, v]) => `${k}=${v}`).join('\n');
          fs.writeFileSync(path.join(buildDir, '.env'), envContent);
        }
        const services = this.writeNoRestartOverride(buildDir, sendLog);
        onExpectedServices?.(services);
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', '-p', name, 'up', '-d', '--build'], { cwd: buildDir });
          proc.stdout.on('data', (chunk: Buffer) => { const line = chunk.toString().trim(); log(line); sendLog(line); });
          proc.stderr.on('data', (chunk: Buffer) => { const line = chunk.toString().trim(); log(line); sendLog(line); });
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
          data.serviceHostPort ?? data.servicePort,
          data.serviceContainerPort ?? data.servicePort,
          data.env,
        );
      }

      sendStatus('running');
      sendLog('Service started successfully.');
      log('Success.');
      return true;
    } catch (error) {
      if (composeBuildDir) {
        await this.downComposeProject(name, composeBuildDir, sendLog);
      }
      fs.rmSync(path.join(__dirname, '../build', name), { recursive: true, force: true });
      sendStatus('failed');
      sendLog(`ERROR: ${String(error)}`);
      log(error);
      return false;
    }
  }
}
