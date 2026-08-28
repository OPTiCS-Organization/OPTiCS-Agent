import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_MAX_CLOCK_SKEW_MS,
  NONCE_FIELD,
  ReplayGuard,
  SIGNATURE_FIELD,
  TIMESTAMP_FIELD,
  VERIFY_FAILURE,
  canonicalize,
  digest,
  sign,
  signingMaterial,
  verify,
} from './hash.util';

const SECRET = 'a'.repeat(64);
const NOW = 1_756_000_000_000;

describe('canonicalize', () => {
  // 서명이 맞으려면 Agent와 Hub가 같은 문자열을 만들어야 한다.
  // 양쪽 조립 코드가 다르니 키 순서에 의존하는 순간 전부 불일치한다.
  it('키를 만든 순서가 달라도 같은 문자열을 만든다', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('중첩된 객체의 키도 정렬한다', () => {
    expect(canonicalize({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('배열 순서는 의미가 있으므로 보존한다', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('undefined 키는 JSON.stringify와 동일하게 제거한다', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  // Hub는 connect-request에서 Date 객체를 그대로 넘긴다(protocol_v0.md §5-4).
  it('Date는 toJSON을 거쳐 문자열이 된다', () => {
    expect(canonicalize({ at: new Date(NOW) })).toBe(`{"at":"${new Date(NOW).toISOString()}"}`);
  });

  it('형제 노드가 같은 객체를 참조하는 것은 순환이 아니다', () => {
    const shared = { value: 1 };
    expect(() => canonicalize({ left: shared, right: shared })).not.toThrow();
  });

  it('순환 참조는 던진다', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalize(cyclic)).toThrow(TypeError);
  });
});

describe('signingMaterial', () => {
  it('서명 봉투 필드는 서명 대상에서 제외한다', () => {
    const bare = signingMaterial('command', NOW, 'n1', { serviceIndex: 1 });
    const enveloped = signingMaterial('command', NOW, 'n1', {
      serviceIndex: 1,
      [SIGNATURE_FIELD]: 'whatever',
      [TIMESTAMP_FIELD]: 1,
      [NONCE_FIELD]: 'other',
    });

    expect(enveloped).toBe(bare);
  });

  it('이벤트 이름이 다르면 다른 문자열이 된다', () => {
    expect(signingMaterial('command', NOW, 'n1', {}))
      .not.toBe(signingMaterial('service-status', NOW, 'n1', {}));
  });
});

describe('sign / verify', () => {
  it('자신이 서명한 페이로드를 검증한다', () => {
    const signed = sign('service-status', { serviceIndex: 1, status: 'running' }, SECRET, { now: NOW });

    expect(verify('service-status', signed, SECRET, { now: NOW })).toEqual({ ok: true });
  });

  it('원본 페이로드를 변형하지 않는다', () => {
    const payload = { serviceIndex: 1 };
    sign('service-status', payload, SECRET, { now: NOW });

    expect(payload).toEqual({ serviceIndex: 1 });
  });

  // 최초 register는 비밀을 받기 위한 요청이므로 아직 서명할 수단이 없다.
  it('비밀이 없으면 서명 없이 원본을 그대로 돌려준다', () => {
    const payload = { agentUuid: null };

    expect(sign('register', payload, null)).toBe(payload);
    expect(verify('register', payload, null)).toEqual({ ok: false, reason: VERIFY_FAILURE.NO_SECRET });
  });

  it('본문이 한 글자라도 바뀌면 거부한다', () => {
    const signed = sign('command', { serviceIndex: 1 }, SECRET, { now: NOW }) as Record<string, unknown>;
    const tampered = { ...signed, serviceIndex: 2 };

    expect(verify('command', tampered, SECRET, { now: NOW }))
      .toEqual({ ok: false, reason: VERIFY_FAILURE.INVALID_SIGNATURE });
  });

  // 서명에 이벤트 이름이 들어가지 않으면 이 재사용이 통과한다.
  it('다른 이벤트로 옮겨 붙인 서명을 거부한다', () => {
    const signed = sign('service-status', { serviceIndex: 1 }, SECRET, { now: NOW });

    expect(verify('command', signed, SECRET, { now: NOW }))
      .toEqual({ ok: false, reason: VERIFY_FAILURE.INVALID_SIGNATURE });
  });

  it('다른 비밀로 만든 서명을 거부한다', () => {
    const signed = sign('command', { serviceIndex: 1 }, 'b'.repeat(64), { now: NOW });

    expect(verify('command', signed, SECRET, { now: NOW }))
      .toEqual({ ok: false, reason: VERIFY_FAILURE.INVALID_SIGNATURE });
  });

  it('키 순서만 다른 페이로드는 그대로 통과한다', () => {
    const signed = sign('command', { a: 1, b: 2 }, SECRET, { now: NOW }) as Record<string, unknown>;
    const reordered = {
      [SIGNATURE_FIELD]: signed[SIGNATURE_FIELD],
      [NONCE_FIELD]: signed[NONCE_FIELD],
      [TIMESTAMP_FIELD]: signed[TIMESTAMP_FIELD],
      b: 2,
      a: 1,
    };

    expect(verify('command', reordered, SECRET, { now: NOW })).toEqual({ ok: true });
  });

  it('허용 오차를 벗어난 시각은 만료로 본다', () => {
    const signed = sign('command', { serviceIndex: 1 }, SECRET, { now: NOW });
    const late = NOW + DEFAULT_MAX_CLOCK_SKEW_MS + 1;

    expect(verify('command', signed, SECRET, { now: late }))
      .toEqual({ ok: false, reason: VERIFY_FAILURE.EXPIRED });
  });

  it('미래로 너무 앞선 시각도 만료로 본다', () => {
    const signed = sign('command', { serviceIndex: 1 }, SECRET, { now: NOW + DEFAULT_MAX_CLOCK_SKEW_MS + 1 });

    expect(verify('command', signed, SECRET, { now: NOW }))
      .toEqual({ ok: false, reason: VERIFY_FAILURE.EXPIRED });
  });

  it.each([
    [SIGNATURE_FIELD, VERIFY_FAILURE.MISSING_SIGNATURE],
    [TIMESTAMP_FIELD, VERIFY_FAILURE.MISSING_TIMESTAMP],
    [NONCE_FIELD, VERIFY_FAILURE.MISSING_NONCE],
  ])('%s가 없으면 %s로 거부한다', (field, reason) => {
    const signed = { ...(sign('command', { serviceIndex: 1 }, SECRET, { now: NOW }) as Record<string, unknown>) };
    delete signed[field];

    expect(verify('command', signed, SECRET, { now: NOW })).toEqual({ ok: false, reason });
  });

  it('hex가 아닌 서명은 대조 전에 걸러낸다', () => {
    const signed = {
      ...(sign('command', { serviceIndex: 1 }, SECRET, { now: NOW }) as Record<string, unknown>),
      [SIGNATURE_FIELD]: 'not-a-hex-digest',
    };

    expect(verify('command', signed, SECRET, { now: NOW }))
      .toEqual({ ok: false, reason: VERIFY_FAILURE.MALFORMED_SIGNATURE });
  });

  it('길이가 다른 서명은 던지지 않고 거부한다', () => {
    const signed = {
      ...(sign('command', { serviceIndex: 1 }, SECRET, { now: NOW }) as Record<string, unknown>),
      [SIGNATURE_FIELD]: 'ab',
    };

    expect(verify('command', signed, SECRET, { now: NOW }))
      .toEqual({ ok: false, reason: VERIFY_FAILURE.INVALID_SIGNATURE });
  });

  it('객체가 아닌 페이로드는 서명 없음으로 본다', () => {
    expect(verify('command', 'string payload', SECRET))
      .toEqual({ ok: false, reason: VERIFY_FAILURE.MISSING_SIGNATURE });
  });
});

describe('ReplayGuard', () => {
  it('같은 서명을 두 번 보내면 두 번째를 거부한다', () => {
    const replayGuard = new ReplayGuard();
    const signed = sign('command', { serviceIndex: 1 }, SECRET, { now: NOW });

    expect(verify('command', signed, SECRET, { now: NOW, replayGuard })).toEqual({ ok: true });
    expect(verify('command', signed, SECRET, { now: NOW, replayGuard }))
      .toEqual({ ok: false, reason: VERIFY_FAILURE.REPLAYED });
  });

  // 서명 대조보다 nonce 등록이 먼저 일어나면, 공격자가 남의 nonce를 미리 태워
  // 정상 요청을 REPLAYED로 떨어뜨릴 수 있다.
  it('서명이 틀린 페이로드의 nonce는 기억하지 않는다', () => {
    const replayGuard = new ReplayGuard();
    const signed = sign('command', { serviceIndex: 1 }, SECRET, { now: NOW }) as Record<string, unknown>;

    verify('command', { ...signed, serviceIndex: 2 }, SECRET, { now: NOW, replayGuard });

    expect(replayGuard.size).toBe(0);
    expect(verify('command', signed, SECRET, { now: NOW, replayGuard })).toEqual({ ok: true });
  });

  it('창을 벗어난 항목을 정리해 무한히 자라지 않는다', () => {
    const replayGuard = new ReplayGuard(1_000);

    replayGuard.remember('old', NOW);
    replayGuard.remember('new', NOW + 2_000);

    expect(replayGuard.size).toBe(1);
  });
});

/**
 * GOLDEN VECTOR — Agent와 Hub 양쪽 spec에 동일하게 존재해야 한다.
 *
 * 두 저장소의 hash.util.ts는 서로의 사본이고, 정규화 규칙이 한 글자만 어긋나도
 * 모든 서명이 조용히 불일치한다. 그 어긋남은 각자의 sign/verify 테스트로는
 * 절대 잡히지 않는다(양쪽 다 자기 규칙으로 만들고 자기 규칙으로 검증하므로).
 * 그래서 결과 문자열 자체를 못박아 둔다. 이 값이 바뀌면 상대 쪽도 반드시 같이 바뀌어야 한다.
 */
describe('고정 벡터', () => {
  const EVENT = 'service-status';
  const TIMESTAMP = 1_756_000_000_000;
  const NONCE = 'fixednonce';
  const PAYLOAD = { serviceIndex: 7, status: 'running', nested: { z: [3, 1, 2], a: null } };

  it('서명 대상 문자열이 고정된 값과 일치한다', () => {
    expect(signingMaterial(EVENT, TIMESTAMP, NONCE, PAYLOAD)).toBe(
      'v1\nservice-status\n1756000000000\nfixednonce\n{"nested":{"a":null,"z":[3,1,2]},"serviceIndex":7,"status":"running"}',
    );
  });

  it('다이제스트가 고정된 값과 일치한다', () => {
    expect(digest(EVENT, TIMESTAMP, NONCE, PAYLOAD, SECRET)).toBe(
      '87c3b0072ca0e67142ac489bb6c04043d1ff5bd86d79f2e4b42f833617e436ef',
    );
  });
});

/**
 * 두 저장소의 hash.util.ts가 갈라지지 않게 파일 지문 자체를 못박는다.
 *
 * 고정 벡터는 "규칙이 바뀌었다"를 잡지만, 바꾼 사람이 자기 저장소의 상수까지
 * 같이 고치면 통과한다. 그래서 파일 내용의 해시를 직접 붙들어, 어느 쪽이든
 * 손대는 순간 반드시 이 테스트를 마주하게 한다.
 *
 * 이 값을 갱신할 때는 **반드시 상대 저장소의 파일과 상수도 함께 갱신해야 한다.**
 * 한쪽만 갱신하면 두 사본이 갈라진 채로 양쪽 CI가 모두 초록이 된다.
 *   OPTiCS-Agent/src/utility/hash.util.ts
 *   OPTiCS-Hub/src/global/hash.util.ts
 */
describe('사본 동일성', () => {
  it('hash.util.ts의 지문이 고정된 값과 일치한다', () => {
    const source = readFileSync(join(__dirname, 'hash.util.ts'));
    const fingerprint = createHash('sha256').update(source).digest('hex');

    expect(fingerprint).toBe('8332033c9bc773a237abc6f6d99724c98c8da1fa209a202a5c5647663b3f22cf');
  });
});
