import type { Socket } from 'socket.io-client';
import { createSocketEmitter } from './createSocketEmitter.util';
import { NONCE_FIELD, SIGNATURE_FIELD, TIMESTAMP_FIELD, verify } from './hash.util';

const SECRET = 'a'.repeat(64);

function fakeSocket() {
  const sent: Array<{ event: string; payload: unknown }> = [];
  const socket = {
    emit: (event: string, payload: unknown) => { sent.push({ event, payload }); },
  } as unknown as Socket;
  return { socket, sent };
}

describe('createSocketEmitter', () => {
  it('페이로드에 서명 봉투를 붙여 보낸다', () => {
    const { socket, sent } = fakeSocket();
    const emit = createSocketEmitter(socket, () => SECRET);

    emit('service-status', { serviceIndex: 1, status: 'running' });

    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ serviceIndex: 1, status: 'running' });
    expect(verify('service-status', sent[0].payload, SECRET)).toEqual({ ok: true });
  });

  it('원본 페이로드를 변형하지 않는다', () => {
    const { socket } = fakeSocket();
    const payload = { serviceIndex: 1 };

    createSocketEmitter(socket, () => SECRET)('service-status', payload);

    expect(payload).toEqual({ serviceIndex: 1 });
  });

  // 최초 register는 비밀을 받으러 가는 요청이라 서명할 수단이 없다.
  // 여기서 막으면 Agent는 영원히 비밀을 발급받지 못한다.
  it('비밀이 없으면 서명 없이 그대로 보낸다', () => {
    const { socket, sent } = fakeSocket();
    const emit = createSocketEmitter(socket, () => null);

    emit('register', { agentUuid: null });

    expect(sent[0].payload).toEqual({ agentUuid: null });
  });

  // 소켓을 만드는 시점엔 비밀이 없고, register 응답 이후에 생긴다.
  it('나중에 발급된 비밀을 emit 시점에 다시 읽는다', () => {
    const { socket, sent } = fakeSocket();
    let secret: string | null = null;
    const emit = createSocketEmitter(socket, () => secret);

    emit('register', { agentUuid: null });
    secret = SECRET;
    emit('service-status', { serviceIndex: 1 });

    expect(sent[0].payload).not.toHaveProperty(SIGNATURE_FIELD);
    expect(verify('service-status', sent[1].payload, SECRET)).toEqual({ ok: true });
  });

  it('이벤트마다 다른 nonce를 쓴다', () => {
    const { socket, sent } = fakeSocket();
    const emit = createSocketEmitter(socket, () => SECRET);

    emit('service-status', { serviceIndex: 1 });
    emit('service-status', { serviceIndex: 1 });

    const [first, second] = sent.map(entry => entry.payload as Record<string, unknown>);
    expect(first[NONCE_FIELD]).not.toBe(second[NONCE_FIELD]);
    expect(first[SIGNATURE_FIELD]).not.toBe(second[SIGNATURE_FIELD]);
  });

  it.each([
    ['문자열', 'raw string'],
    ['배열', [1, 2, 3]],
    ['undefined', undefined],
    ['null', null],
  ])('객체가 아닌 %s 페이로드는 모양을 바꾸지 않고 통과시킨다', (_label, payload) => {
    const { socket, sent } = fakeSocket();

    createSocketEmitter(socket, () => SECRET)('response', payload);

    expect(sent[0].payload).toEqual(payload);
  });

  it('서명 불가능한 페이로드는 미서명으로 내보내지 않고 버린다', () => {
    const { socket, sent } = fakeSocket();
    const cyclic: Record<string, unknown> = { serviceIndex: 1 };
    cyclic.self = cyclic;

    expect(() => createSocketEmitter(socket, () => SECRET)('command', cyclic)).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it('registerHubEmit이 기대하는 (event, payload) 형태와 호환된다', () => {
    const { socket, sent } = fakeSocket();
    const hubEmit: (event: string, payload: object) => void = createSocketEmitter(socket, () => SECRET);

    hubEmit('service-log', { serviceIndex: 1, log: 'hello' });

    expect(sent[0].payload).toHaveProperty(TIMESTAMP_FIELD);
  });
});
