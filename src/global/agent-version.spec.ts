/*
 * Agent가 Hub에 보고하는 버전이 실제로 읽히는지 확인합니다.
 *
 * 예전에는 고정된 상대 경로로 package.json을 찾았고, 파일이 디렉터리 한 단계
 * 아래로 옮겨지자 조용히 null이 되어 Hub에 버전이 NULL로 쌓였습니다.
 * catch가 사유를 삼켜 로그에도 흔적이 없었고, 타입 검사도 통과했습니다.
 * 그 자리를 여기서 붙듭니다.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { AGENT_VERSION, readAgentVersion } from './agent-version';

function packageVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '../../package.json'), 'utf-8'),
  ) as { version?: string };
  return pkg.version!;
}

describe('AGENT_VERSION', () => {
  // null이면 Hub가 이 Agent를 원격 업데이트 대상에서 제외한다(agent-capability.ts).
  it('null이 아니다', () => {
    expect(AGENT_VERSION).not.toBeNull();
  });

  it('package.json의 version과 일치한다', () => {
    expect(AGENT_VERSION).toBe(packageVersion());
  });

  it('SemVer 형태다', () => {
    // Hub가 compareSemver로 원격 업데이트 가능 여부를 판정하므로 형태가 맞아야 한다.
    expect(AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  // 이 파일이 다른 디렉터리로 옮겨져도 위로 탐색해 같은 package.json에 닿아야 한다.
  it('파일 위치에 의존하지 않는다', () => {
    expect(readAgentVersion()).toBe(packageVersion());
  });
});
