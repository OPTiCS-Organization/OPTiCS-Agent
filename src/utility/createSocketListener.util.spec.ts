import type { Socket } from 'socket.io-client';
import { createSocketListener } from './createSocketListener.util';
import { sign } from './hash.util';

const SECRET = 'a'.repeat(64);

/** socket.on으로 등록된 리스너를 붙잡아 두었다가 임의로 발화시키는 가짜 소켓. */
function fakeSocket() {
  const listeners = new Map<string, (payload: unknown) => void>();
  const socket = {
    on: (event: string, handler: (payload: unknown) => void) => { listeners.set(event, handler); },
  } as unknown as Socket;

  return {
    socket,
    /** Hub가 보낸 것처럼 이벤트를 밀어넣는다. socket.io의 JSON 왕복까지 재현한다. */
    deliver: (event: string, payload: unknown) => {
      listeners.get(event)?.(payload === undefined ? payload : JSON.parse(JSON.stringify(payload)));
    },
  };
}

describe('createSocketListener', () => {
  it('서명이 유효하면 핸들러를 호출한다', () => {
    const { socket, deliver } = fakeSocket();
    const received: unknown[] = [];

    createSocketListener(socket, () => SECRET)('command', payload => { received.push(payload); });
    deliver('command', sign('command', { command: 'DEPLOY', serviceIndex: 1 }, SECRET));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ command: 'DEPLOY', serviceIndex: 1 });
  });

  it('서명이 없으면 핸들러를 호출하지 않는다', () => {
    const { socket, deliver } = fakeSocket();
    const received: unknown[] = [];

    createSocketListener(socket, () => SECRET)('command', payload => { received.push(payload); });
    deliver('command', { command: 'DEPLOY', serviceIndex: 1 });

    expect(received).toHaveLength(0);
  });

  // 소켓을 가로챈 쪽이 Hub인 척 명령을 밀어넣는 시나리오.
  it('다른 비밀로 서명한 명령을 버린다', () => {
    const { socket, deliver } = fakeSocket();
    const received: unknown[] = [];

    createSocketListener(socket, () => SECRET)('command', payload => { received.push(payload); });
    deliver('command', sign('command', { command: 'DELETE' }, 'b'.repeat(64)));

    expect(received).toHaveLength(0);
  });

  it('본문이 변조된 명령을 버린다', () => {
    const { socket, deliver } = fakeSocket();
    const received: unknown[] = [];

    createSocketListener(socket, () => SECRET)('command', payload => { received.push(payload); });
    const signed = sign('command', { command: 'START', serviceIndex: 1 }, SECRET) as Record<string, unknown>;
    deliver('command', { ...signed, serviceIndex: 99 });

    expect(received).toHaveLength(0);
  });

  it('비밀이 아직 없으면 핸들러를 호출하지 않는다', () => {
    const { socket, deliver } = fakeSocket();
    const received: unknown[] = [];

    createSocketListener(socket, () => null)('command', payload => { received.push(payload); });
    deliver('command', sign('command', { command: 'DEPLOY' }, SECRET));

    expect(received).toHaveLength(0);
  });

  // register는 비밀을 받아오는 응답이라 검증할 재료가 존재하지 않는다.
  it.each(['register', 'connect', 'disconnect'])('%s는 검증 없이 통과시킨다', event => {
    const { socket, deliver } = fakeSocket();
    const received: unknown[] = [];

    createSocketListener(socket, () => SECRET)(event, payload => { received.push(payload); });
    deliver(event, { code: 'ok' });

    expect(received).toHaveLength(1);
  });

  it('가로챈 명령을 재전송하면 두 번째를 버린다', () => {
    const { socket, deliver } = fakeSocket();
    const received: unknown[] = [];

    createSocketListener(socket, () => SECRET)('command', payload => { received.push(payload); });
    const signed = sign('command', { command: 'DEPLOY' }, SECRET);
    deliver('command', signed);
    deliver('command', signed);

    expect(received).toHaveLength(1);
  });

  // 재연결 때마다 가드가 새로 생기면, 끊고 다시 붙인 뒤 재전송하는 우회가 열린다.
  it('여러 이벤트가 재전송 가드를 공유한다', () => {
    const { socket, deliver } = fakeSocket();
    const received: unknown[] = [];
    const onFromHub = createSocketListener(socket, () => SECRET);

    onFromHub('command', payload => { received.push(payload); });
    onFromHub('terminal-input', payload => { received.push(payload); });

    const signed = sign('command', { command: 'DEPLOY' }, SECRET) as Record<string, unknown>;
    deliver('command', signed);
    // 같은 nonce를 다른 이벤트에 옮겨 붙인 경우(서명 자체가 이벤트에 묶여 있어 먼저 걸린다)
    deliver('terminal-input', { ...signed, sessionId: 'x' });

    expect(received).toHaveLength(1);
  });

  // async 핸들러의 거절이 새어나가면 Node가 프로세스를 죽인다.
  // 명령 하나가 실패했다고 Agent 전체가 내려가면 그 호스트의 모든 서비스가 관리 불능이 된다.
  it('비동기 핸들러의 거절이 리스너 밖으로 새지 않는다', async () => {
    const { socket, deliver } = fakeSocket();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);

    createSocketListener(socket, () => SECRET)('command', () => Promise.reject(new Error('boom')));
    deliver('command', sign('command', { command: 'DEPLOY' }, SECRET));
    await new Promise(resolve => setImmediate(resolve));

    process.off('unhandledRejection', onRejection);
    expect(rejections).toHaveLength(0);
  });

  it('동기 핸들러가 던져도 리스너 밖으로 새지 않는다', () => {
    const { socket, deliver } = fakeSocket();

    createSocketListener(socket, () => SECRET)('command', () => { throw new Error('boom'); });

    expect(() => deliver('command', sign('command', { command: 'DEPLOY' }, SECRET))).not.toThrow();
  });
});
