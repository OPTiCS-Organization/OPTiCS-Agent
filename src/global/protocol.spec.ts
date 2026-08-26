import { readFileSync } from 'fs';
import { join } from 'path';
import { PROTOCOL_VERSION } from './protocol';

describe('PROTOCOL_VERSION', () => {
  // 런타임 진실은 protocol.ts지만 릴리즈 워크플로는 package.json을 읽는다.
  // 둘이 어긋나면 카탈로그가 실제와 다른 프로토콜 버전을 광고하게 되므로 여기서 막는다.
  it('package.json의 optics.protocol과 일치한다', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf-8'),
    ) as { optics?: { protocol?: number } };

    expect(pkg.optics?.protocol).toBe(PROTOCOL_VERSION);
  });
});
