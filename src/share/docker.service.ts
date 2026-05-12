import { Global, Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Docker from "dockerode";
import path from "path";
import fs from "fs";
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from "child_process";
import log from "spectra-log";
import { DeployCommand } from "../service/dtos/DeployCommand.dto";
import { DEPLOY_OPTION } from "../global/DeployOptionEnum";

export type DockerStatusEvent = {
  status: string;
  containerName: string;
  timestamp: string;
  action: string;
};
type StatusEmit = (event: DockerStatusEvent) => void | Promise<void>;
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
type LogStream = 'deploy' | 'lifecycle' | 'runtime';

export type DockerLogEntry = {
  line: string;
  timestamp?: string;
  source?: 'agent' | 'runtime';
  stream?: LogStream;
  containerName?: string;
  composeService?: string;
  stderr?: boolean;
};
export type DockerLogProgress = {
  loaded: number;
  total: number;
  percent: number;
  phase: 'loading' | 'streaming' | 'complete';
};

@Global()
@Injectable()
export class DockerService implements OnModuleInit {
  private docker: Docker;
  private statusEmit: StatusEmit | null = null;

  private readonly buildRoot = process.env.OPTICS_BUILD_DIR ?? path.join(process.cwd(), 'dist/build');

  // ServiceForm의 컨테이너 포트 입력값을 PORT 환경변수로 자동 주입하여
  // compose 파일이 ${PORT:-...} 컨벤션을 따를 때 정상 동작하게 한다.
  // 사용자가 env에 PORT를 직접 명시했다면 그것을 우선한다.
  private writeComposeEnvFile(buildDir: string, data: DeployCommand): void {
    const userEnv = data.env ?? {};
    const containerPort = data.serviceContainerPort ?? data.servicePort;
    const finalEnv: Record<string, string> = { ...userEnv };
    if (containerPort !== undefined && finalEnv.PORT === undefined) {
      finalEnv.PORT = String(containerPort);
    }
    if (Object.keys(finalEnv).length === 0) return;
    const envContent = Object.entries(finalEnv).map(([k, v]) => `${k}=${v}`).join('\n');
    fs.writeFileSync(path.join(buildDir, '.env'), envContent);
  }

  // 에이전트 자기 자신용 환경변수가 자식 docker compose 프로세스로 누출되어
  // 사용자 compose 파일의 ${VAR} 치환을 오염시키는 것을 방지한다.
  private subprocessEnv(): NodeJS.ProcessEnv {
    const reserved = new Set([
      'PORT',
      'SERVER_PORT',
      'HUB_URL',
      'CENTRAL_SERVER_URL',
      'OPTICS_SOURCE_URL',
      'REMOTE_DOCKER_HOST',
      'REMOTE_DOCKER_PORT',
      'DATABASE_URL',
      'CORS_ORIGIN',
    ]);
    const cleaned: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!reserved.has(key) && !key.startsWith('OPTICS_')) {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }

  constructor(
    private readonly configService: ConfigService,
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

  private logStreams = new Map<string, ChildProcessWithoutNullStreams>();

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
    const buildDir = path.join(this.buildRoot, projectName);
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
      const proc = spawn('docker', ['compose', '-p', projectName, 'down', '--remove-orphans'], { cwd, env: this.subprocessEnv() });
      proc.stdout.on('data', (chunk: Buffer) => this.emitOutputLines(chunk, sendLog, true));
      proc.stderr.on('data', (chunk: Buffer) => this.emitOutputLines(chunk, sendLog, true));
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
    onLog: (entry: DockerLogEntry) => void,
    onProgress?: (progress: DockerLogProgress) => void,
  ): Promise<void> {
    if (this.logStreams.has(containerName)) {
      this.stopContainerLog(containerName);
    }

    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;
    log(`[DockerService] streamContainerLog | deployPreset="${deployPreset}" | isCompose=${isCompose}`);

    const historicalLogs = this.loadHistoricalLogs(containerName, isCompose);
    let lastPercent = -1;
    const emitProgress = (loaded: number, total: number, phase: DockerLogProgress['phase']) => {
      const percent = total > 0 ? Math.round((loaded / total) * 100) : 100;
      if (phase === 'loading' && percent !== 100 && percent < lastPercent + 5) return;
      lastPercent = percent;
      onProgress?.({ loaded, total, percent, phase });
    };

    emitProgress(0, historicalLogs.length, 'loading');
    historicalLogs.forEach((entry, index) => {
      onLog(entry);
      emitProgress(index + 1, historicalLogs.length, 'loading');
    });
    emitProgress(historicalLogs.length, historicalLogs.length, 'complete');
    onProgress?.({
      loaded: historicalLogs.length,
      total: historicalLogs.length,
      percent: 100,
      phase: 'streaming',
    });

    if (isCompose) {
      // Compose: historical logs are loaded above; follow only new lines from here.
      const proc = spawn('docker', ['compose', '-p', containerName, 'logs', '--follow', '--tail', '0', '--timestamps'], {});
      this.logStreams.set(containerName, proc);
      proc.stdout.on('data', (chunk: Buffer) => {
        this.outputLines(chunk).forEach(line => {
          const entry = this.runtimeLogEntry(line, containerName);
          if (entry) onLog(entry);
        });
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        this.outputLines(chunk).forEach(line => {
          const entry = this.runtimeLogEntry(line, containerName, true);
          if (entry) onLog(entry);
        });
      });
      proc.on('close', () => {
        if (this.logStreams.get(containerName) === proc) {
          this.logStreams.delete(containerName);
        }
        log(`[DockerService] streamContainerLog (compose) closed | project=${containerName}`);
      });
      log(`[DockerService] streamContainerLog (compose) started | project=${containerName}`);
    } else {
      const proc = spawn('docker', ['logs', '--follow', '--tail', '0', '--timestamps', containerName], {});
      this.logStreams.set(containerName, proc);
      proc.stdout.on('data', (chunk: Buffer) => {
        this.outputLines(chunk).forEach(line => {
          const entry = this.runtimeLogEntry(line, containerName);
          if (entry) onLog(entry);
        });
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        this.outputLines(chunk).forEach(line => {
          const entry = this.runtimeLogEntry(line, containerName, true);
          if (entry) onLog(entry);
        });
      });
      proc.on('close', () => {
        if (this.logStreams.get(containerName) === proc) {
          this.logStreams.delete(containerName);
        }
        log(`[DockerService] streamContainerLog closed | name=${containerName}`);
      });
      log(`[DockerService] streamContainerLog started | name=${containerName}`);
    }
  }

  private loadHistoricalLogs(containerName: string, isCompose: boolean): DockerLogEntry[] {
    const args = isCompose
      ? ['compose', '-p', containerName, 'logs', '--tail', '10000', '--timestamps']
      : ['logs', '--timestamps', '--tail', '10000', containerName];

    const result = spawnSync('docker', args, { encoding: 'utf8' });
    const stdout = result.stdout
      .split('\n')
      .filter(line => line.trim())
      .flatMap(line => {
        const entry = this.runtimeLogEntry(line, containerName);
        return entry ? [entry] : [];
      });
    const stderr = result.stderr
      .split('\n')
      .filter(line => line.trim())
      .flatMap(line => {
        const entry = this.runtimeLogEntry(line, containerName, true);
        return entry ? [entry] : [];
      });

    if (result.status !== 0 && stdout.length === 0 && stderr.length === 0) {
      return [{ line: `ERROR: docker logs exited with code ${result.status ?? 'unknown'}` }];
    }

    return this.sortLogEntries([...stdout, ...stderr]);
  }

  loadOlderContainerLogs(
    containerName: string,
    deployPreset: DEPLOY_OPTION,
    before: string,
    limit = 1000,
  ): DockerLogEntry[] {
    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;
    const until = new Date(new Date(before).getTime() - 1).toISOString();
    const safeLimit = Math.max(1, Math.min(limit, 5000));
    const args = isCompose
      ? ['compose', '-p', containerName, 'logs', '--tail', String(safeLimit), '--timestamps', '--until', until]
      : ['logs', '--timestamps', '--tail', String(safeLimit), '--until', until, containerName];

    const result = spawnSync('docker', args, { encoding: 'utf8' });
    const stdout = result.stdout
      .split('\n')
      .filter(line => line.trim())
      .flatMap(line => {
        const entry = this.runtimeLogEntry(line, containerName);
        return entry ? [entry] : [];
      });
    const stderr = result.stderr
      .split('\n')
      .filter(line => line.trim())
      .flatMap(line => {
        const entry = this.runtimeLogEntry(line, containerName, true);
        return entry ? [entry] : [];
      });

    if (result.status !== 0 && stdout.length === 0 && stderr.length === 0) {
      return [{ line: `ERROR: docker logs exited with code ${result.status ?? 'unknown'}` }];
    }

    return this.sortLogEntries([...stdout, ...stderr]);
  }

  private sortLogEntries(entries: DockerLogEntry[]): DockerLogEntry[] {
    return [...entries].sort((a, b) => this.logEntryTime(a) - this.logEntryTime(b));
  }

  private logEntryTime(entry: DockerLogEntry): number {
    if (!entry.timestamp) return Number.MAX_SAFE_INTEGER;
    const time = new Date(entry.timestamp).getTime();
    return Number.isNaN(time) ? Number.MAX_SAFE_INTEGER : time;
  }

  private outputLines(chunk: Buffer | string): string[] {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    return text.split(/\r?\n|\r/).map(line => this.stripAnsi(line).trim()).filter(Boolean);
  }

  private emitOutputLines(chunk: Buffer | string, sendLog: (line: string) => void, mirrorToAgentLog = false) {
    this.outputLines(chunk).forEach((line) => {
      if (mirrorToAgentLog) log(line);
      sendLog(line);
    });
  }

  private runtimeLogEntry(line: string, defaultContainerName?: string, stderr = false): DockerLogEntry | null {
    const parsed = this.parseDockerLogLine(line, defaultContainerName);
    if (!parsed.line.trim()) return null;

    return {
      ...parsed,
      source: 'runtime',
      stream: 'runtime',
      line: stderr ? `ERROR: ${parsed.line}` : parsed.line,
      stderr: stderr || undefined,
    };
  }

  private parseDockerLogLine(line: string, defaultContainerName?: string): DockerLogEntry {
    const cleanLine = this.stripAnsi(line).trim();
    const timestampPattern = '(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2})(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})';
    const match = cleanLine.match(new RegExp(`^(?:(.*?)\\s+\\|\\s*)?${timestampPattern}(?:\\s+(.*))?$`));
    if (!match) {
      const composeLine = cleanLine.match(/^([^|\s]+)\s+\|\s*(.*)$/);
      if (composeLine) {
        const [, prefix, message] = composeLine;
        const containerName = prefix.trim();
        const nested = this.parseDockerLogLine(message, containerName);
        return {
          ...nested,
          containerName: nested.containerName ?? containerName,
          composeService: nested.composeService ?? this.composeServiceName(containerName),
        };
      }

      const composeEvent = cleanLine.match(/^([A-Za-z0-9_.-]+-\d+)\s+(exited with code .*|Killed|Aborted|Terminated)$/);
      if (composeEvent) {
        const [, containerName, message] = composeEvent;
        return { line: message, containerName, composeService: this.composeServiceName(containerName) };
      }

      return { line: cleanLine, containerName: defaultContainerName };
    }

    const [, prefix, base, fraction = '', zone, message = ''] = match;
    const milliseconds = fraction ? fraction.slice(0, 4).padEnd(4, '0') : '';
    const timestamp = new Date(`${base}${milliseconds}${zone}`).toISOString();
    const containerName = prefix?.trim() || defaultContainerName;
    const composeService = containerName ? this.composeServiceName(containerName) : undefined;

    return { line: message, timestamp, containerName, composeService };
  }

  private stripAnsi(value: string): string {
    return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  }

  private composeServiceName(containerName: string): string {
    return containerName.replace(/-\d+$/, '');
  }

  stopContainerLog(containerName: string): void {
    const stream = this.logStreams.get(containerName);
    if (stream) {
      stream.kill();
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
            time?: number;
            timeNano?: number;
            Actor: { Attributes: Record<string, string> };
          };
          if (event.Type !== 'container') return;

          const name = event.Actor.Attributes['name'] ?? '';
          const action = event.Action;
          const timestamp = event.timeNano
            ? new Date(Math.floor(event.timeNano / 1_000_000)).toISOString()
            : new Date(event.time ? event.time * 1000 : Date.now()).toISOString();

          if (!this.statusEmit) return;

          switch (action) {
            case 'die':
            case 'stop':
            case 'kill': {
              const exitCode = event.Actor.Attributes['exitCode'] ?? '0';
              const status = exitCode !== '0' ? 'failed' : 'stopped';
              log(`[DockerService] Stopping Container '${name}'...\nExit Code: ${exitCode}\nExit State: ${status}`);
              void this.statusEmit({ status, containerName: name, timestamp, action });
              break;
            }
            case 'create': {
              void this.statusEmit({ status: 'starting', containerName: name, timestamp, action });
              break;
            }
            case 'start': {
              log(`[DockerService] Starting Container '${name}'...`);
              void this.statusEmit({ status: 'running', containerName: name, timestamp, action });
              break;
            }
            case 'restart': {
              log(`[DockerService] Restarting Container '${name}'...`);
              void this.statusEmit({ status: 'restarting', containerName: name, timestamp, action });
              break;
            }
            case 'destroy': {
              log(`[DockerService] Removing Container '${name}'...`)
              void this.statusEmit({ status: 'removed', containerName: name, timestamp, action });
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

  private isContainerRuntime() {
    return process.env.OPTICS_AGENT_RUNTIME === 'container' || fs.existsSync('/.dockerenv');
  }

  private cloneWorkspaceMount() {
    if (this.isContainerRuntime()) {
      return process.env.OPTICS_BUILD_VOLUME ?? 'optics-build';
    }

    fs.mkdirSync(this.buildRoot, { recursive: true });
    return this.buildRoot;
  }

  private dockerRunUserArgs(): string[] {
    if (this.isContainerRuntime()) return [];
    if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return [];

    return ['-u', `${process.getuid()}:${process.getgid()}`];
  }

  private removeBuildDir(targetDir: string, sendLog?: (line: string) => void) {
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
      return;
    } catch (error) {
      sendLog?.(`[DockerService] Local build directory cleanup failed, retrying in helper container.\n  ${String(error)}`);
    }

    const relativeTarget = path.relative(this.buildRoot, targetDir);
    if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
      throw new Error('Build directory cleanup target must stay inside the build workspace.');
    }

    const containerTarget = `/workspace/${relativeTarget.split(path.sep).join('/')}`;
    const result = spawnSync('docker', ['run', '--rm', '-v', `${this.cloneWorkspaceMount()}:/workspace`, 'alpine:3.20', 'rm', '-rf', containerTarget], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || `helper cleanup container exited with code ${result.status ?? 'unknown'}`);
    }
  }

  private async cloneInGitContainer(repoUrl: string, targetDir: string, sendLog: (line: string) => void): Promise<void> {
    const relativeTarget = path.relative(this.buildRoot, targetDir);
    if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
      throw new Error('Clone target must stay inside the build workspace.');
    }
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });

    const containerTarget = `/workspace/${relativeTarget.split(path.sep).join('/')}`;
    const mount = `${this.cloneWorkspaceMount()}:/workspace`;
    sendLog(`[DockerService] Cloning source in git container...\nFrom: ${repoUrl}\nInto: ${containerTarget}`);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('docker', ['run', '--rm', ...this.dockerRunUserArgs(), '-v', mount, 'alpine/git', 'clone', repoUrl, containerTarget]);
      proc.stdout.on('data', (chunk: Buffer) => this.emitOutputLines(chunk, sendLog));
      proc.stderr.on('data', (chunk: Buffer) => this.emitOutputLines(chunk, sendLog));
      proc.on('error', reject);
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`git clone container exited with code ${code}`)));
    });
  }

  private async cloneAll(
    sourceUrl: string | string[],
    baseDir: string,
    sendLog: (line: string) => void,
  ): Promise<string> {
    const urls = Array.isArray(sourceUrl) ? sourceUrl : [sourceUrl];

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
    const sendLog = (line: string) => emit('service-log', {
      serviceName,
      log: line,
      timestamp: new Date().toISOString(),
      source: 'agent',
      stream: 'lifecycle',
      containerName: si,
    });
    const sendStatus = (status: string) => emit('service-status', { serviceName, status });
    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;

    try {
      sendLog(`Stopping service '${si}'...`);
      if (isCompose) {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', '-p', si, 'stop']);
          proc.stderr.on('data', (chunk: Buffer) => this.emitOutputLines(chunk, sendLog));
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

  async startContainer(
    containerName: string,
    _deployPreset: DEPLOY_OPTION,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const sendLog = (line: string) => emit('service-log', {
      serviceName: containerName,
      log: line,
      timestamp: new Date().toISOString(),
      source: 'agent',
      stream: 'lifecycle',
      containerName,
    });

    try {
      sendLog(`Starting container '${containerName}'...`);
      await this.docker.getContainer(containerName).start();
      sendLog(`Container '${containerName}' started successfully.`);
      log(`[DockerService] startContainer success | name=${containerName}`);
    } catch (e) {
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] startContainer failed | name=${containerName} | ${String(e)}`);
    }
  }

  async stopContainer(
    containerName: string,
    _deployPreset: DEPLOY_OPTION,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const sendLog = (line: string) => emit('service-log', {
      serviceName: containerName,
      log: line,
      timestamp: new Date().toISOString(),
      source: 'agent',
      stream: 'lifecycle',
      containerName,
    });

    try {
      sendLog(`Stopping container '${containerName}'...`);
      await this.docker.getContainer(containerName).stop();
      sendLog(`Container '${containerName}' stopped successfully.`);
      log(`[DockerService] stopContainer success | name=${containerName}`);
    } catch (e) {
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
    const sendLog = (line: string) => emit('service-log', {
      serviceName,
      log: line,
      timestamp: new Date().toISOString(),
      source: 'agent',
      stream: 'lifecycle',
      containerName: si,
    });
    const sendStatus = (status: string) => emit('service-status', { serviceName, status });
    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;

    try {
      sendStatus('restarting');
      sendLog(`Restarting service '${si}'...`);
      if (isCompose) {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', '-p', si, 'restart']);
          proc.stderr.on('data', (chunk: Buffer) => this.emitOutputLines(chunk, sendLog));
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
    _deployPreset: DEPLOY_OPTION,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const sendLog = (line: string) => emit('service-log', {
      serviceName: containerName,
      log: line,
      timestamp: new Date().toISOString(),
      source: 'agent',
      stream: 'lifecycle',
      containerName,
    });

    try {
      sendLog(`Restarting container '${containerName}'...`);
      await this.docker.getContainer(containerName).restart();
      sendLog(`Container '${containerName}' restarted successfully.`);
      log(`[DockerService] restartContainer success | name=${containerName}`);
    } catch (e) {
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] restartContainer failed | name=${containerName} | ${String(e)}`);
    }
  }

  async deleteService(
    serviceName: string,
    deployPreset: DEPLOY_OPTION,
    deleteScope: 'containers' | 'service',
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const si = serviceName.toLowerCase();
    const sendLog = (line: string) => emit('service-log', {
      serviceName,
      log: line,
      timestamp: new Date().toISOString(),
      source: 'agent',
      stream: 'lifecycle',
      containerName: si,
    });
    const sendStatus = (status: string) => emit('service-status', { serviceName, status });
    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;

    try {
      sendLog(`Deleting service '${si}'...`);
      if (isCompose) {
        await new Promise<void>((resolve, reject) => {
          const args = deleteScope === 'service'
            ? ['compose', '-p', si, 'down', '--rmi', 'all', '--volumes']
            : ['compose', '-p', si, 'down'];
          const proc = spawn('docker', args, { env: this.subprocessEnv() });
          proc.stdout.on('data', (chunk: Buffer) => this.emitOutputLines(chunk, sendLog));
          proc.stderr.on('data', (chunk: Buffer) => this.emitOutputLines(chunk, sendLog));
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
        if (deleteScope === 'service') {
          try {
            await this.docker.getImage(si).remove();
            sendLog(`Image '${si}' removed.`);
          } catch {
            sendLog(`No image found for '${si}', skipping.`);
          }
        }
      }
      if (deleteScope === 'service') {
        this.removeBuildDir(path.join(this.buildRoot, si), sendLog);
      }
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
      this.removeBuildDir(path.join(this.buildRoot, name), sendLog);

      const clonedDir = await this.cloneAll(data.sourceUrl, path.join(this.buildRoot, name), sendLog);
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
        this.writeComposeEnvFile(buildDir, data);
        const services = this.writeNoRestartOverride(buildDir, sendLog);
        onExpectedServices?.(services);
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', '-p', name ?? data.serviceName.toLowerCase(), 'up', '-d', '--build'], { cwd: buildDir, env: this.subprocessEnv() });
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
      this.removeBuildDir(path.join(this.buildRoot, name), sendLog);
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
        { cwd: buildDir, encoding: 'utf8', env: this.subprocessEnv() },
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
        this.writeComposeEnvFile(buildDir, data);
        const services = this.writeNoRestartOverride(buildDir, sendLog);
        onExpectedServices?.(services);
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', '-p', name, 'up', '-d', '--build'], { cwd: buildDir, env: this.subprocessEnv() });
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
      this.removeBuildDir(path.join(this.buildRoot, name), sendLog);
      sendStatus('failed');
      sendLog(`ERROR: ${String(error)}`);
      log(error);
      return false;
    }
  }
}
