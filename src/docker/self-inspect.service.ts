import { Injectable } from '@nestjs/common';
import Docker from 'dockerode';
import { readFileSync } from 'fs';
import { hostname } from 'os';

export type ComposeProject = {
  /** compose 프로젝트 이름 */
  project: string;
  /** compose 파일이 있는 디렉터리. 컨테이너 내부가 아니라 호스트 기준 경로다. */
  workingDir: string;
  /** 이 Agent에 해당하는 compose 서비스 이름 */
  service: string;
};

/**
 * Agent가 자기 자신이 어떻게 기동됐는지 도커 소켓으로 되짚어보는 서비스.
 *
 * 자기 교체를 하려면 compose 프로젝트의 "호스트 측" 경로가 필요한데,
 * bind mount 경로는 도커 데몬이 호스트 기준으로 해석하므로 컨테이너 안에서 본 경로를 넘기면
 * 엉뚱한 디렉터리가 마운트된다. compose가 컨테이너에 심어둔 라벨이 유일하게 믿을 수 있는 출처다.
 */
@Injectable()
export class SelfInspectService {
  private readonly docker = new Docker({ socketPath: '/var/run/docker.sock' });

  /**
   * 자기 컨테이너 ID.
   * hostname은 compose에서 hostname을 지정하면 컨테이너 ID가 아니게 되므로 mountinfo를 먼저 본다.
   * (cgroup v2에서는 /proc/self/cgroup에 컨테이너 ID가 없어 쓸 수 없다)
   */
  private selfContainerId(): string {
    try {
      const mountinfo = readFileSync('/proc/self/mountinfo', 'utf-8');
      const matched = /\/docker\/containers\/([0-9a-f]{64})\//.exec(mountinfo);
      if (matched) return matched[1];
    } catch {
      // 컨테이너 밖(로컬 개발)에서는 읽히지 않는다. 아래 hostname 폴백으로 넘어간다.
    }
    return hostname();
  }

  async resolveComposeProject(): Promise<ComposeProject> {
    const info = await this.docker.getContainer(this.selfContainerId()).inspect();
    const labels = info.Config?.Labels ?? {};

    const project = labels['com.docker.compose.project'];
    const workingDir = labels['com.docker.compose.project.working_dir'];
    const service = labels['com.docker.compose.service'];

    if (!project || !workingDir || !service) {
      throw new Error(
        'Agent가 docker compose로 기동되지 않아 자동 업데이트를 사용할 수 없다. 설치 스크립트로 다시 설치해야 한다.',
      );
    }
    return { project, workingDir, service };
  }
}
