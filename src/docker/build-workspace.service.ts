import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import path from "path";
import fs from 'fs';
import { isContainerRuntime } from "./utility/runtime.util";
import { normalizeSourceRepositories, repoName } from "./utility/deploy-command.util";
import { DockerCli } from "./docker-cli.service";
import { DeployCommand } from "src/service/dtos/DeployCommand.dto";

@Injectable()
export class BuildWorkspaceService {
  private buildRoot: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly dockerCli: DockerCli,
  ) {
    this.buildRoot = configService.get<string>('OPTICS_BUILD_DIR') ?? path.join(process.cwd(), 'dist/build');
  }

  // 클론/정리 컨테이너에 붙일 워크스페이스 마운트 소스를 고른다.
  // 에이전트가 컨테이너로 돌면 명명 볼륨을, 호스트로 돌면 빌드 디렉토리를 쓴다.
  cloneWorkspaceMount(): string {
    if (isContainerRuntime()) {
      return process.env.OPTICS_BUILD_VOLUME ?? 'optics-build';
    }

    fs.mkdirSync(this.buildRoot, { recursive: true });
    return this.buildRoot;
  }

  // 빌드 디렉토리를 지운다. 호스트에서 실패하면 헬퍼 컨테이너로 한 번 더 시도한다.
  // 컨테이너가 root로 만든 파일을 호스트 권한으로 못 지우는 경우가 있어서다.
  removeBuildDir(targetDir: string, sendLog?: (line: string) => void): void {
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
      return;
    } catch (error) {
      sendLog?.(`[BuildWorkspaceService] Local build directory cleanup failed, retrying in helper container.\n  ${String(error)}`);
    }

    const containerTarget = this.toContainerPath(targetDir, 'Build directory cleanup target');
    const result = this.dockerCli.runSync(['run', '--rm', '-v', `${this.cloneWorkspaceMount()}:/workspace`, 'alpine:3.20', 'rm', '-rf', containerTarget]);
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || `helper cleanup container exited with code ${result.status ?? 'unknown'}`);
    }
  }

  // 소스 저장소를 전부 클론하고 빌드 컨텍스트로 쓸 디렉토리를 돌려준다.
  // 저장소가 여러 개면 이름별 하위 디렉토리에 받고 첫 번째를 메인으로 본다.
  async cloneAll(
    sourceUrl: DeployCommand['sourceUrl'],
    baseDir: string,
    sendLog: (line: string) => void,
  ): Promise<string> {
    const urls = normalizeSourceRepositories(sourceUrl).map(source => source.url);

    if (urls.length === 1) {
      await this.cloneInGitContainer(urls[0], baseDir, sendLog);
      sendLog('[BuildWorkspaceService] Clone done.');
      return baseDir;
    }

    fs.mkdirSync(baseDir, { recursive: true });
    for (const url of urls) {
      await this.cloneInGitContainer(url, path.join(baseDir, repoName(url)), sendLog);
    }
    sendLog('[BuildWorkspaceService] All Repository Successfully Cloned.');
    return path.join(baseDir, repoName(urls[0]));
  }

  // rootDirectory가 지정되면 그 하위 디렉토리를 빌드 컨텍스트로 삼는다.
  // 저장소 밖으로 나가는 경로는 거부해 임의 경로 접근을 막는다.
  resolveBuildContext(baseDir: string, rootDirectory: string | null | undefined): string {
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

  // 빌드 컨텍스트와 그 바로 아래 항목에 읽기/실행 권한을 준다.
  // 클론 컨테이너가 남긴 권한 때문에 docker build가 파일을 못 읽는 경우를 막는다.
  applyBuildPermissions(buildDir: string): void {
    fs.chmodSync(buildDir, 0o755);
    fs.readdirSync(buildDir).forEach(file => {
      try { fs.chmodSync(path.join(buildDir, file), 0o755); } catch { /* skip */ }
    });
  }

  // alpine/git 컨테이너로 클론한다. 에이전트에 git이 없어도 되도록 하기 위함이다.
  // 호스트 실행 시에는 현재 uid/gid로 돌려 결과물 소유자를 맞춘다.
  private async cloneInGitContainer(repoUrl: string, targetDir: string, sendLog: (line: string) => void): Promise<void> {
    const containerTarget = this.toContainerPath(targetDir, 'Clone target');
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });

    const mount = `${this.cloneWorkspaceMount()}:/workspace`;
    sendLog(`[BuildWorkspaceService] Cloning source in git container...\nFrom: ${repoUrl}\nInto: ${containerTarget}`);

    await this.dockerCli.run(['run', '--rm', ...this.dockerRunUserArgs(), '-v', mount, 'alpine/git', 'clone', repoUrl, containerTarget], {
      label: 'git clone container',
      onLine: sendLog,
    });
  }

  // 호스트 경로를 워크스페이스 마운트 기준의 컨테이너 경로로 바꾼다.
  // 빌드 워크스페이스 밖을 가리키면 예외를 던져 탈출을 막는다.
  private toContainerPath(targetDir: string, label: string): string {
    const relativeTarget = path.relative(this.buildRoot, targetDir);
    if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
      throw new Error(`${label} must stay inside the build workspace.`);
    }
    return `/workspace/${relativeTarget.split(path.sep).join('/')}`;
  }

  // 호스트에서 돌 때만 docker run에 현재 사용자 인자를 붙인다.
  // 컨테이너 런타임에서는 붙이지 않아야 볼륨 권한이 꼬이지 않는다.
  private dockerRunUserArgs(): string[] {
    if (isContainerRuntime()) return [];
    if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return [];

    return ['-u', `${process.getuid()}:${process.getgid()}`];
  }
}
