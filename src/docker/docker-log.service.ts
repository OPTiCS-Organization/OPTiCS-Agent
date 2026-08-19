import { Injectable } from "@nestjs/common";
import { ChildProcessWithoutNullStreams } from "child_process";
import log from "spectra-log";
import { DEPLOY_OPTION } from "../global/DeployOptionEnum";
import { DockerLogEntry } from "./types/DockerLogEntry.type";
import { DockerLogProgress } from "./types/DockerLogProgress.type";
import { runtimeLogEntry, sortLogEntries } from "./utility/docker-log.parser";
import { outputLines } from "./utility/docker-output.util";
import { DockerCli } from "./docker-cli.service";
import { isComposePreset } from "./utility/deploy-command.util";

// 초기 히스토리를 줄 단위 service-log 대신 묶음(service-log-history)으로 전송할 때의 배치 크기.
const HISTORY_BATCH_SIZE = 2000;
// 스트리밍 시작 시 한 번에 끌어올 과거 로그 줄 수.
const HISTORY_TAIL = '10000';

@Injectable()
export class DockerLogService {
  private logStreams = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(
    private readonly dockerCli: DockerCli,
  ) { }

  // 과거 로그를 배치로 먼저 흘려보낸 뒤 새 줄만 따라가는 스트림을 연다.
  // 같은 컨테이너로 다시 부르면 기존 스트림을 닫고 새로 시작한다.
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

    const isCompose = isComposePreset(deployPreset);
    log(`[DockerLogService] streamContainerLog | deployPreset="${deployPreset}" | isCompose=${isCompose}`);

    const historicalLogs = this.fetchLogEntries(containerName, this.logArgs(containerName, isCompose, HISTORY_TAIL));
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

    // 과거 로그는 위에서 이미 보냈으므로 --tail 0으로 새 줄만 따라간다.
    const args = isCompose
      ? ['compose', '-p', containerName, 'logs', '--follow', '--tail', '0', '--timestamps']
      : ['logs', '--follow', '--tail', '0', '--timestamps', containerName];
    const label = isCompose ? `project=${containerName}` : `name=${containerName}`;

    const proc: ChildProcessWithoutNullStreams = this.dockerCli.stream(args, {
      onStdout: (chunk) => this.pushLines(chunk, containerName, onLog, false),
      onStderr: (chunk) => this.pushLines(chunk, containerName, onLog, true),
      onClose: () => {
        if (this.logStreams.get(containerName) === proc) {
          this.logStreams.delete(containerName);
        }
        log(`[DockerLogService] streamContainerLog closed | ${label}`);
      },
    });
    this.logStreams.set(containerName, proc);
    log(`[DockerLogService] streamContainerLog started | ${label}`);
  }

  // 무한 스크롤용으로 특정 시각 이전의 로그를 거슬러 올라가 읽는다.
  // limit은 한 번에 5000줄까지만 허용해 과도한 조회를 막는다.
  loadOlderContainerLogs(
    containerName: string,
    deployPreset: DEPLOY_OPTION,
    before: string,
    limit = 1000,
  ): DockerLogEntry[] {
    const until = new Date(new Date(before).getTime() - 1).toISOString();
    const safeLimit = Math.max(1, Math.min(limit, 5000));
    const args = this.logArgs(containerName, isComposePreset(deployPreset), String(safeLimit), until);
    return this.fetchLogEntries(containerName, args);
  }

  // 열려 있는 로그 스트림 프로세스를 죽이고 맵에서 제거한다.
  // 여기서 지우지 않으면 콜백이 붙잡은 객체들이 계속 메모리에 남는다.
  stopContainerLog(containerName: string): void {
    const stream = this.logStreams.get(containerName);
    if (stream) {
      stream.kill();
      this.logStreams.delete(containerName);
      log(`[DockerLogService] streamContainerLog stopped | name=${containerName}`);
    }
  }

  // compose와 단일 컨테이너의 docker logs 인자 차이를 한 곳에서 만든다.
  // until을 주면 그 시각 이전 구간만 조회한다.
  private logArgs(containerName: string, isCompose: boolean, tail: string, until?: string): string[] {
    if (isCompose) {
      return ['compose', '-p', containerName, 'logs', '--tail', tail, '--timestamps', ...(until ? ['--until', until] : [])];
    }
    return ['logs', '--timestamps', '--tail', tail, ...(until ? ['--until', until] : []), containerName];
  }

  // docker logs를 동기로 실행해 stdout/stderr를 하나의 시간순 목록으로 합친다.
  // 로그가 한 줄도 없이 실패한 경우에만 에러 항목을 대신 돌려준다.
  private fetchLogEntries(containerName: string, args: string[]): DockerLogEntry[] {
    const result = this.dockerCli.runSync(args);
    const toEntries = (raw: string, stderr: boolean) => raw
      .split('\n')
      .filter(line => line.trim())
      .flatMap(line => {
        const entry = runtimeLogEntry(line, containerName, stderr);
        return entry ? [entry] : [];
      });

    const stdout = toEntries(result.stdout, false);
    const stderr = toEntries(result.stderr, true);

    if (result.status !== 0 && stdout.length === 0 && stderr.length === 0) {
      return [{ line: `ERROR: docker logs exited with code ${result.status ?? 'unknown'}` }];
    }

    return sortLogEntries([...stdout, ...stderr]);
  }

  // 스트림 청크를 줄 단위 로그 항목으로 바꿔 콜백에 넘긴다.
  // stdout/stderr 핸들러가 같은 일을 하므로 한 함수로 묶었다.
  private pushLines(chunk: Buffer, containerName: string, onLog: (entry: DockerLogEntry) => void, stderr: boolean): void {
    outputLines(chunk).forEach(line => {
      const entry = runtimeLogEntry(line, containerName, stderr);
      if (entry) onLog(entry);
    });
  }
}
