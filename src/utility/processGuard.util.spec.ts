import { installProcessGuards } from './processGuard.util';

describe('installProcessGuards', () => {
  const listenersOf = (event: 'unhandledRejection' | 'uncaughtException') =>
    process.listenerCount(event);

  // 핸들러가 없으면 라이브러리 하나가 흘린 예외로 에이전트 전체가 종료된다.
  it('두 이벤트에 핸들러를 등록한다', () => {
    const before = { rejection: listenersOf('unhandledRejection'), exception: listenersOf('uncaughtException') };

    installProcessGuards();

    expect(listenersOf('unhandledRejection')).toBeGreaterThan(before.rejection);
    expect(listenersOf('uncaughtException')).toBeGreaterThan(before.exception);
  });

  // 여러 번 불려도 같은 예외가 로그에 중복으로 쌓이면 안 된다.
  it('중복 호출해도 핸들러가 늘어나지 않는다', () => {
    const after = { rejection: listenersOf('unhandledRejection'), exception: listenersOf('uncaughtException') };

    installProcessGuards();
    installProcessGuards();

    expect(listenersOf('unhandledRejection')).toBe(after.rejection);
    expect(listenersOf('uncaughtException')).toBe(after.exception);
  });

  // 잡은 뒤 다시 던지면 프로세스가 죽는다. 로그만 남기고 넘어가야 한다.
  it('예외를 받아도 다시 던지지 않는다', () => {
    const handler = process.listeners('uncaughtException').at(-1) as (error: unknown) => void;

    expect(() => handler(new Error('boom'))).not.toThrow();
  });
});
