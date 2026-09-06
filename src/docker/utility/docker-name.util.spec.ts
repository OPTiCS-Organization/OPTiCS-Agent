import { toDockerName } from './docker-name.util';

describe('toDockerName', () => {
  // 공백이 들어간 이름은 docker API URL 경로에 그대로 실려
  // ERR_UNESCAPED_CHARACTERS로 에이전트 프로세스를 죽였다.
  it('공백을 하이픈으로 바꾸고 소문자로 만든다', () => {
    expect(toDockerName('Obsidian Livesync')).toBe('obsidian-livesync');
  });

  // compose 프로젝트명은 점을 허용하지 않는다.
  it('도커가 허용하지 않는 문자를 하이픈으로 접는다', () => {
    expect(toDockerName('my.app')).toBe('my-app');
    expect(toDockerName('my/app@v2')).toBe('my-app-v2');
  });

  // 이미지 이름 규칙상 구분자가 연달아 나오면 안 되고 앞뒤에 붙어도 안 된다.
  it('구분자가 겹치거나 양끝에 붙으면 정리한다', () => {
    expect(toDockerName('  spaced   out  ')).toBe('spaced-out');
    expect(toDockerName('--weird__name--')).toBe('weird-name');
  });

  // 기존 서비스 이름을 그대로 유지하기 위해 밑줄 하나는 살린다.
  it('이미 안전한 이름은 그대로 둔다', () => {
    expect(toDockerName('my_app')).toBe('my_app');
    expect(toDockerName('optics-agent')).toBe('optics-agent');
  });

  // 호출부 여러 곳이 각자 계산하므로 결과가 흔들리면 컨테이너를 못 찾는다.
  it('남는 글자가 없으면 원본 해시로 대체하고 항상 같은 값을 준다', () => {
    const name = toDockerName('테스트 서비스');

    expect(name).toMatch(/^service-[0-9a-f]{8}$/);
    expect(toDockerName('테스트 서비스')).toBe(name);
    expect(toDockerName('다른 서비스')).not.toBe(name);
  });

  // 정규화된 이름을 다시 정규화하는 호출 경로가 있어 멱등이어야 한다.
  it('멱등이다', () => {
    const once = toDockerName('Obsidian Livesync');

    expect(toDockerName(once)).toBe(once);
  });
});
