/**
 * 이 Agent가 Hub에 보고하는 자기 버전.
 *
 * 계약 정의: OPTiCS-Hub/docs/protocol_v1.md
 *
 * Hub는 이 값으로 원격 업데이트 가능 여부를 판정하므로(agent-capability.ts),
 * null이 보고되면 그 Agent는 콘솔에서 업데이트할 수 없는 상태가 된다.
 * 즉 "못 읽으면 null" 은 조용한 실패가 아니라 기능 하나가 꺼지는 일이다.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import log from 'spectra-log';

/**
 * package.json을 찾을 때까지 상위 디렉터리를 거슬러 올라가며 버전을 읽는다.
 *
 * 고정된 상대 경로(`../../package.json`)를 쓰면 이 코드가 디렉터리를 옮기는 순간
 * 조용히 깨진다. 실제로 tunnel.service.ts가 src/에서 src/tunnel/로 내려가면서
 * 기준점이 한 단계 어긋났고, catch가 사유를 삼켜 Hub에 버전이 NULL로 쌓일 때까지
 * 아무도 알아채지 못했다. 위로 탐색하면 파일 위치에 무관해진다.
 *
 * 빌드 산출물(dist/)에는 package.json이 들어가지 않으므로, 컨테이너에서는
 * /app/dist/src/... 에서 출발해 /app/package.json 에 닿는다.
 */
export function readAgentVersion(): string | null {
  let directory = __dirname;

  for (;;) {
    const candidate = join(directory, 'package.json');

    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { version?: string };
        if (pkg.version) return pkg.version;

        log(`[Agent Version] {{ red : bold : VERSION:MISSING_FIELD }}\n  file: ${candidate}\n  package.json has no "version" field. The Hub will record this agent's version as NULL.`, 500, 'ERROR');
        return null;
      } catch (error) {
        log(`[Agent Version] {{ red : bold : VERSION:UNREADABLE }}\n  file: ${candidate}\n  reason: ${error instanceof Error ? error.message : String(error)}\n  The Hub will record this agent's version as NULL.`, 500, 'ERROR');
        return null;
      }
    }

    const parent = dirname(directory);
    // 파일시스템 루트에 닿으면 dirname이 자기 자신을 돌려준다. 그때 멈추지 않으면 무한 루프다.
    if (parent === directory) break;
    directory = parent;
  }

  log(`[Agent Version] {{ red : bold : VERSION:NOT_FOUND }}\n  searched upward from: ${__dirname}\n  No package.json was found. The Hub will record this agent's version as NULL.`, 500, 'ERROR');
  return null;
}

/** 기동 시 한 번만 읽는다. 실행 중에 바뀔 값이 아니다. */
export const AGENT_VERSION = readAgentVersion();
