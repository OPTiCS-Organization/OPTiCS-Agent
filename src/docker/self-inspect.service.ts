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
 * 0.7.0 이하의 업데이터가 compose 프로젝트를 마운트하던 컨테이너 내부 경로.
 *
 * 지금 업데이터는 호스트와 같은 경로에 마운트해 오염을 만들지 않지만(app.service.ts),
 * 이미 라벨이 덮인 설치본이 현장에 남아 있으므로 이 값을 만나면 복구를 시도한다.
 */
const LEGACY_UPDATER_MOUNT = '/project';

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

    if (workingDir !== LEGACY_UPDATER_MOUNT) {
      return { project, workingDir, service };
    }

    const recovered = await this.workingDirFromSiblings(project);
    if (!recovered) {
      throw new Error(
        `compose 프로젝트 경로가 구버전 업데이터에 ${LEGACY_UPDATER_MOUNT}로 덮여 있고 되찾을 단서도 없다. ` +
        '호스트에서 설치 디렉터리로 이동해 `docker compose up -d`를 한 번 실행하면 경로가 복구된다.',
      );
    }
    return { project, workingDir: recovered, service };
  }

  /**
   * 라벨이 덮인 경우 같은 compose 프로젝트의 다른 컨테이너에서 호스트 경로를 되찾는다.
   *
   * 업데이터는 Agent 서비스만 교체하고 나머지 서비스는 이미지가 그대로라 재생성하지 않는다.
   * 그래서 Dashboard처럼 함께 설치된 컨테이너는 설치 당시의 호스트 경로를 아직 들고 있다.
   * 프로젝트 전체가 교체된 적이 있다면 되찾을 값이 없고, 그때는 호출부가 수동 복구를 안내한다.
   */
  private async workingDirFromSiblings(project: string): Promise<string | undefined> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${project}`] },
    });

    for (const container of containers) {
      const candidate = container.Labels?.['com.docker.compose.project.working_dir'];
      if (candidate && candidate !== LEGACY_UPDATER_MOUNT) return candidate;
    }
    return undefined;
  }
}
