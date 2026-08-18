import { Injectable } from "@nestjs/common";
import { spawnSync } from "child_process";
import { ConfigService } from "@nestjs/config";
import path from "path";
import fs from 'fs';
import { isContainerRuntime } from "./utility/runtime.util";
@Injectable()
export class BuildWorkspaceService {
  private buildRoot: string;

  constructor (
    private readonly configService: ConfigService,
  ) {
    this.buildRoot = configService.get<string>('OPTICS_BUILD_DIR') ?? path.join(process.cwd(), 'dist/build');
  }

cloneWorkspaceMount() {
  if (isContainerRuntime()) {
    return process.env.OPTICS_BUILD_VOLUME ?? 'optics-build';
  }

  fs.mkdirSync(this.buildRoot, { recursive: true });
  return this.buildRoot;
}
  removeBuildDir(targetDir: string, sendLog?: (line: string) => void) {
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
}
