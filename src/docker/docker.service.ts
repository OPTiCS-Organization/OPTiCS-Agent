import { Global, Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Docker from "dockerode";
import path from "path";
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from "child_process";
import log from "spectra-log";
import { DeployCommand } from "../service/dtos/DeployCommand.dto";
import { DEPLOY_OPTION } from "../global/DeployOptionEnum";
import { stripAnsi, subprocessEnv } from "./utility/docker-cli";
import { DockerLogEntry } from "./types/DockerLogEntry.type";
import { runtimeLogEntry, sortLogEntries } from "./utility/docker-log.parser";
import { emitOutputLines, outputLines } from "./utility/global.util";
import fs from 'fs';

export type DockerStatusEvent = {
  status: string;
  containerName: string;
  timestamp: string;
  action: string;
  exitCode?: string;
};
type StatusEmit = (event: DockerStatusEvent) => void | Promise<void>;
type ContainerStatus = 'building' | 'starting' | 'running' | 'stopped' | 'failed' | 'removed';
type ContainerSnapshot = {
  name: string;
  status: ContainerStatus;
  service?: string;
  exitCode?: number | null;
  health?: string | null;
};
type ServicePortMapping = {
  hostPort: number;
  containerPort: number;
};
type SourceRepository = {
  url: string;
  rootDirectory?: string | null;
};

export type DockerLogProgress = {
  loaded: number;
  total: number;
  percent: number;
  phase: 'loading' | 'streaming' | 'complete';
};

// 초기 히스토리를 줄 단위 service-log 대신 묶음(service-log-history)으로 전송할 때의 배치 크기.
const HISTORY_BATCH_SIZE = 2000;

@Injectable()
export class DockerService implements OnModuleInit {
  private docker: Docker;
  private statusEmit: StatusEmit | null = null;

  private readonly buildRoot = process.env.OPTICS_BUILD_DIR ?? path.join(process.cwd(), 'dist/build');
  private readonly preserveFailedDeployArtifacts = true;

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


  async streamContainerLog(
    containerName: string,
    deployPreset: DEPLOY_OPTION,
    onLog: (entry: DockerLogEntry) => void,
    onProgress?: (progress: DockerLogProgress) => void,
    onHistory?: (entries: DockerLogEntry[]) => void,
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

    const total = historicalLogs.length;
    emitProgress(0, total, 'loading');
    for (let offset = 0; offset < total; offset += HISTORY_BATCH_SIZE) {
      const batch = historicalLogs.slice(offset, offset + HISTORY_BATCH_SIZE);
      if (onHistory) onHistory(batch);
      else batch.forEach(onLog);
      emitProgress(Math.min(offset + HISTORY_BATCH_SIZE, total), total, 'loading');
    }
    emitProgress(total, total, 'complete');
    onProgress?.({ loaded: total, total, percent: 100, phase: 'streaming' });

    if (isCompose) {
      // Compose: historical logs are loaded above; follow only new lines from here.
      const proc = spawn('docker', ['compose', '-p', containerName, 'logs', '--follow', '--tail', '0', '--timestamps'], {});
      this.logStreams.set(containerName, proc);
      proc.stdout.on('data', (chunk: Buffer) => {
        outputLines(chunk).forEach(line => {
          const entry = runtimeLogEntry(line, containerName);
          if (entry) onLog(entry);
        });
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        outputLines(chunk).forEach(line => {
          const entry = runtimeLogEntry(line, containerName, true);
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
        outputLines(chunk).forEach(line => {
          const entry = runtimeLogEntry(line, containerName);
          if (entry) onLog(entry);
        });
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        outputLines(chunk).forEach(line => {
          const entry = runtimeLogEntry(line, containerName, true);
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
        const entry = runtimeLogEntry(line, containerName);
        return entry ? [entry] : [];
      });
    const stderr = result.stderr
      .split('\n')
      .filter(line => line.trim())
      .flatMap(line => {
        const entry = runtimeLogEntry(line, containerName, true);
        return entry ? [entry] : [];
      });

    if (result.status !== 0 && stdout.length === 0 && stderr.length === 0) {
      return [{ line: `ERROR: docker logs exited with code ${result.status ?? 'unknown'}` }];
    }

    return sortLogEntries([...stdout, ...stderr]);
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
        const entry = runtimeLogEntry(line, containerName);
        return entry ? [entry] : [];
      });
    const stderr = result.stderr
      .split('\n')
      .filter(line => line.trim())
      .flatMap(line => {
        const entry = runtimeLogEntry(line, containerName, true);
        return entry ? [entry] : [];
      });

    if (result.status !== 0 && stdout.length === 0 && stderr.length === 0) {
      return [{ line: `ERROR: docker logs exited with code ${result.status ?? 'unknown'}` }];
    }

    return sortLogEntries([...stdout, ...stderr]);
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
              void this.statusEmit({ status, containerName: name, timestamp, action, exitCode });
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

  private isContainerRuntime() {
    return process.env.OPTICS_AGENT_RUNTIME === 'container' || fs.existsSync('/.dockerenv');
  }


  private dockerRunUserArgs(): string[] {
    if (this.isContainerRuntime()) return [];
    if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return [];

    return ['-u', `${process.getuid()}:${process.getgid()}`];
  }



}
