import { Injectable } from "@nestjs/common";
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from "child_process";
import { subprocessEnv } from "./utility/docker-cli";
import { emitOutputLines } from "./utility/docker-output.util";

export type DockerCliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type DockerCliRunOptions = {
  // 실패 시 에러 문구에 쓰인다: `${label} exited with code 1`
  label: string;
  cwd?: string;
  onLine?: (line: string) => void;
  mirrorToAgentLog?: boolean;
  // 정리 경로처럼 실패해도 진행해야 하는 경우 true.
  ignoreExitCode?: boolean;
};

export type DockerCliStreamHandlers = {
  onStdout: (chunk: Buffer) => void;
  onStderr: (chunk: Buffer) => void;
  onClose: () => void;
};

/**
 * docker CLI 호출을 한 곳으로 모으는 경계.
 * 에이전트 전용 환경변수 차단을 여기서 항상 적용하고, 테스트에서는 이 클래스만 바꾸면 된다.
 */
@Injectable()
export class DockerCli {
  // 명령을 동기로 실행하고 종료코드와 출력을 그대로 돌려준다.
  // 조회성 명령(inspect, ps, config, logs)처럼 결과 문자열이 필요한 곳에서 쓴다.
  runSync(args: string[], options: { cwd?: string } = {}): DockerCliResult {
    const result = spawnSync('docker', args, {
      cwd: options.cwd,
      encoding: 'utf8',
      env: subprocessEnv(),
    });

    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  // 명령을 실행하며 출력을 줄 단위로 흘려보내고 종료까지 기다린다.
  // 종료코드가 0이 아니면 reject하되 ignoreExitCode면 넘어간다.
  async run(args: string[], options: DockerCliRunOptions): Promise<void> {
    const { label, cwd, onLine, mirrorToAgentLog = false, ignoreExitCode = false } = options;

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('docker', args, { cwd, env: subprocessEnv() });

      if (onLine) {
        proc.stdout.on('data', (chunk: Buffer) => emitOutputLines(chunk, onLine, mirrorToAgentLog));
        proc.stderr.on('data', (chunk: Buffer) => emitOutputLines(chunk, onLine, mirrorToAgentLog));
      }

      proc.on('error', (error) => {
        if (ignoreExitCode) {
          onLine?.(`[DockerCli] ${label} failed to start: ${String(error)}`);
          resolve();
          return;
        }
        reject(error);
      });

      proc.on('close', (code) => {
        if (code === 0 || ignoreExitCode) return resolve();
        reject(new Error(`${label} exited with code ${code}`));
      });
    });
  }

  // 종료를 기다리지 않는 장기 실행 명령(logs --follow)을 띄우고 프로세스를 돌려준다.
  // 호출부가 핸들을 보관했다가 직접 kill해야 하므로 여기서는 생명주기를 관리하지 않는다.
  stream(args: string[], handlers: DockerCliStreamHandlers): ChildProcessWithoutNullStreams {
    const proc = spawn('docker', args, { env: subprocessEnv() });
    proc.stdout.on('data', handlers.onStdout);
    proc.stderr.on('data', handlers.onStderr);
    proc.on('close', handlers.onClose);
    return proc;
  }
}
