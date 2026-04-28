import { Global, Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Docker from "dockerode";
import path from "path";
import fs from "fs";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { Readable } from "stream";
import log from "spectra-log";
import { DeployCommand } from "../service/dtos/DeployCommand.dto";
import { GitService } from "./git.service";
import { DEPLOY_OPTION } from "../global/DeployOptionEnum";

type StatusEmit = (raw: string) => void | Promise<void>;

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

          log(`[DockerService] Container Command Received.\nTarget Container: ${name}\nAction=${action}`);

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

  // 컨테이너 이름을 받아 시작 하는 함수
  async runService(serviceName: string, serviceVersion: string, servicePort: number, env?: Record<string, string>, servicePortBindings?: Record<number, number>) {
    const portBindings: Record<string, { HostPort: string }[]> = {};
    const exposedPorts: Record<string, object> = {};

    if (servicePortBindings) {
      for (const [containerPort, hostPort] of Object.entries(servicePortBindings)) {
        const key = `${containerPort}/tcp`;
        portBindings[key] = [{ HostPort: String(hostPort) }];
        exposedPorts[key] = {};
      }
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
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const si: number = Number(data.serviceIndex);
    const sendLog = (line: string) => emit('service-log', { serviceIndex: si, log: line, timestamp: new Date().toISOString() });
    const sendStatus = (status: string) => emit('service-status', { serviceIndex: si, status });
    const name = data.serviceName.toLowerCase();

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

      const buildDir = await this.cloneAll(data.sourceUrl, path.join(__dirname, '../build', name), sendLog);
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
        if (data.env) {
          const envContent = Object.entries(data.env).map(([k, v]) => `${k}=${v}`).join('\n');
          fs.writeFileSync(path.join(buildDir, '.env'), envContent);
        }
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
        await this.runService(data.serviceName, data.serviceVersion, data.servicePort, data.env);
      }

      sendStatus('running');
      sendLog('Service redeployed successfully.');
      log('Redeploy success.');
    } catch (error) {
      fs.rmSync(path.join(__dirname, '../build', name), { recursive: true, force: true });
      sendStatus('failed');
      sendLog(`ERROR: ${String(error)}`);
      log(error);
    }
  }

  // 이미지로 빌드하는 함수
  async deployNewService(
    data: DeployCommand,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const si: number = Number(data.serviceIndex);
    const sendLog = (line: string) => emit('service-log', { serviceIndex: si, log: line, timestamp: new Date().toISOString() });
    const sendStatus = (status: string) => emit('service-status', { serviceIndex: si, status });

    try {
      sendStatus('building');
      sendLog(`Creating new Service '${data.serviceName.toLowerCase()}@${data.serviceVersion}' | preset: ${data.deployPreset}`);
      const buildDir = await this.cloneAll(data.sourceUrl, path.join(__dirname, '../build', data.serviceName.toLowerCase()), sendLog);
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
        if (data.env) {
          const envContent = Object.entries(data.env).map(([k, v]) => `${k}=${v}`).join('\n');
          fs.writeFileSync(path.join(buildDir, '.env'), envContent);
        }
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', '-p', data.serviceName.toLowerCase(), 'up', '-d', '--build'], { cwd: buildDir });
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
        await this.runService(data.serviceName, data.serviceVersion, data.servicePort, data.env);
      }

      sendStatus('running');
      sendLog('Service started successfully.');
      log('Success.');
    } catch (error) {
      fs.rmSync(path.join(__dirname, '../build', data.serviceName.toLowerCase()), { recursive: true, force: true });
      sendStatus('failed');
      sendLog(`ERROR: ${String(error)}`);
      log(error);
    }
  }
}
