import { Global, Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Docker from "dockerode";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
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

  private logStreams = new Map<string, import('stream').Readable>();

  async streamContainerLog(
    containerName: string,
    onLog: (line: string) => void,
  ): Promise<void> {
    if (this.logStreams.has(containerName)) return;
    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect() as { State: { StartedAt: string } };
      const since = Math.floor(new Date(info.State.StartedAt).getTime() / 1000);
      const stream = await container.logs({ follow: true, stdout: true, stderr: true, tail: 10000, since }) as unknown as import('stream').Readable;
      this.logStreams.set(containerName, stream);
      stream.on('data', (chunk: Buffer) => {
        // Docker multiplexed stream: 첫 8바이트는 헤더
        const raw = chunk.length > 8 ? chunk.subarray(8).toString('utf8') : chunk.toString('utf8');
        raw.split('\n').filter(l => l.trim()).forEach(line => onLog(line));
      });
      stream.on('end', () => {
        this.logStreams.delete(containerName);
      });
      log(`[DockerService] streamContainerLog started | name=${containerName}`);
    } catch (e) {
      log(`[DockerService] streamContainerLog failed | name=${containerName} | ${String(e)}`);
    }
  }

  stopContainerLog(containerName: string): void {
    const stream = this.logStreams.get(containerName);
    if (stream) {
      stream.destroy();
      this.logStreams.delete(containerName);
      log(`[DockerService] streamContainerLog stopped | name=${containerName}`);
    }
  }

  onModuleInit() {
    this.docker.getEvents({}, (err, stream) => {
      if (err || !stream) {
        log(`[DockerService] Failed to subscribe to Docker events: ${String(err)}`);
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

          log(`[DockerService] container event | action=${action} | name=${name}`);

          if (!this.statusEmit) return;

          if (action === 'die' || action === 'stop' || action === 'kill') {
            const exitCode = event.Actor.Attributes['exitCode'] ?? '0';
            const status = exitCode !== '0' ? 'failed' : 'stopped';
            log(`[DockerService] → status=${status} | exitCode=${exitCode}`);
            // serviceName으로 serviceIndex를 알 수 없으므로 name을 함께 emit
            void this.statusEmit(`${status}:${name}`);
          } else if (action === 'start') {
            log(`[DockerService] → status=running`);
            void this.statusEmit(`running:${name}`);
          } else if (action === 'restart') {
            log(`[DockerService] → status=restarting`);
            void this.statusEmit(`restarting:${name}`);
          } else if (action === 'destroy') {
            log(`[DockerService] → status=removed`);
            void this.statusEmit(`removed:${name}`);
          }
        } catch {
          // JSON 파싱 실패 무시
        }
      });
    });
  }

  // 컨테이너 이름을 받아 시작 하는 함수
  async runService(serviceName: string, serviceVersion: string, servicePort: number, env?: Record<string, string>) {
    const container = await this.docker.createContainer({
      Image: `${serviceName.toLowerCase()}:${serviceVersion}`,
      name: serviceName.toLowerCase(),
      Env: env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : undefined,
      HostConfig: {
        PortBindings: {
          [`${servicePort}/tcp`]: [{ HostPort: String(servicePort) }]
        },
        RestartPolicy: { Name: 'unless-stopped' },
        ExtraHosts: ['host.docker.internal:host-gateway']
      }
    });

    await container.start();
    log('Started Service')
  }

  async stopService(
    serviceName: string,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const si = serviceName.toLowerCase();
    const sendLog = (line: string) => emit('service-log', { serviceName, log: line, timestamp: new Date().toISOString() });
    const sendStatus = (status: string) => emit('service-status', { serviceName, status });

    try {
      sendLog(`Stopping container '${si}'...`);
      const container = this.docker.getContainer(si);
      await container.stop();
      sendStatus('stopped');
      sendLog(`Container '${si}' stopped successfully.`);
      log(`[DockerService] stopService success | name=${si}`);
    } catch (e) {
      sendStatus('failed');
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] stopService failed | name=${si} | ${String(e)}`);
    }
  }

  async restartService(
    serviceName: string,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    log(serviceName)
    const si = serviceName.toLowerCase();
    const sendLog = (line: string) => emit('service-log', { serviceName, log: line, timestamp: new Date().toISOString() });
    const sendStatus = (status: string) => emit('service-status', { serviceName, status });

    try {
      sendStatus('restarting');
      sendLog(`Restarting container '${si}'...`);
      const container = this.docker.getContainer(si);
      await container.restart();
      sendStatus('running');
      sendLog(`Container '${si}' restarted successfully.`);
      log(`[DockerService] restartService success | name=${si}`);
    } catch (e) {
      sendStatus('failed');
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] restartService failed | name=${si} | ${String(e)}`);
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

      sendLog(`Cloning from '${data.sourceUrl}'...`);
      await this.gitService.clone(data.sourceUrl, path.join(__dirname, `../build`, name));
      sendLog('Clone done.');

      const buildDir = path.join(__dirname, '../build', name);
      fs.chmodSync(buildDir, 0o755);
      fs.readdirSync(buildDir).forEach(file => {
        try { fs.chmodSync(path.join(buildDir, file), 0o755); } catch { /* skip */ }
      });

      const composeFileExists = fs.existsSync(path.join(buildDir, 'docker-compose.yml'))
        || fs.existsSync(path.join(buildDir, 'docker-compose.yaml'));

      if (data.deployPreset === DEPLOY_OPTION.COMPOSE && !composeFileExists) {
        throw new Error('docker-compose.yml not found.');
      }

      const hasCompose = data.deployPreset === DEPLOY_OPTION.COMPOSE
        || (data.deployPreset !== DEPLOY_OPTION.DOCKERFILE && composeFileExists);

      if (hasCompose) {
        sendLog('Detected docker-compose, starting build...');
        if (data.env) {
          const envContent = Object.entries(data.env).map(([k, v]) => `${k}=${v}`).join('\n');
          fs.writeFileSync(path.join(buildDir, '.env'), envContent);
        }
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', 'up', '-d', '--build'], { cwd: buildDir });
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
      sendLog(`Cloning from '${data.sourceUrl}'...`);
      await this.gitService.clone(data.sourceUrl, path.join(__dirname, `../build`, data.serviceName.toLowerCase()));
      sendLog('Clone done.');

      const buildDir = path.join(__dirname, "../build", data.serviceName.toLowerCase());
      fs.chmodSync(buildDir, 0o755);
      fs.readdirSync(buildDir).forEach(file => {
        try { fs.chmodSync(path.join(buildDir, file), 0o755); } catch { /* skip non-chmodable */ }
      });

      const composeFileExists = fs.existsSync(path.join(buildDir, 'docker-compose.yml'))
        || fs.existsSync(path.join(buildDir, 'docker-compose.yaml'));

      if (data.deployPreset === DEPLOY_OPTION.COMPOSE && !composeFileExists) {
        throw new Error('docker-compose.yml not found. Change deploy option to DOCKERFILE or add docker-compose.yml to the repository.');
      }

      const hasCompose = data.deployPreset === DEPLOY_OPTION.COMPOSE
        || (data.deployPreset !== DEPLOY_OPTION.DOCKERFILE && composeFileExists);

      if (hasCompose) {
        sendLog('Detected docker-compose, starting build...');
        if (data.env) {
          const envContent = Object.entries(data.env).map(([k, v]) => `${k}=${v}`).join('\n');
          fs.writeFileSync(path.join(buildDir, '.env'), envContent);
        }
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', 'up', '-d', '--build'], { cwd: buildDir });
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