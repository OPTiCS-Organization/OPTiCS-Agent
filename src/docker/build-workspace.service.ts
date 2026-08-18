import { Injectable } from "@nestjs/common";

@Injectable()
export class BuildWorkspaceService {
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