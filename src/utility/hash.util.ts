/**
 * Agent ↔ Hub 소켓 페이로드의 HMAC 서명·검증 유틸리티입니다.
 *
 * Hub가 등록 시 발급한 `signingSecret`(agents.agent_signing_secret)을 공유 비밀로 삼아
 * 이벤트마다 서명을 붙이고, 받은 쪽이 같은 방식으로 재계산해 대조합니다.
 * socket.io 연결 자체는 TLS로 보호되지만, 그것만으로는 "이 소켓이 정말 그 Agent인가"를
 * 말해주지 못합니다. UUID는 페이로드에 실려 오는 값이라 아는 사람은 누구나 사칭할 수 있고,
 * Hub가 UUID 하나만 보고 `agentUuidToSocketId`에 등록하면 그 시점부터 남의 서비스로
 * 명령이 흘러갑니다. 서명은 그 갭을 막습니다.
 *
 * 이 파일은 두 저장소가 공유하는 사본입니다. 런타임 의존성 없이 순수 함수로만 둡니다.
 *   OPTiCS-Agent/src/utility/hash.util.ts
 *   OPTiCS-Hub/src/global/hash.util.ts
 * 두 파일은 **바이트 단위로 동일해야 하며**, 한쪽만 고치면 모든 서명이 조용히 불일치합니다.
 * hash.util.spec.ts가 파일 지문과 고정 벡터로 이 동일성을 지킵니다.
 * 규칙을 바꾸려면 SIGNATURE_SCHEME_VERSION을 올리고 양쪽을 함께 배포해야 합니다.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * 서명 방식 자체의 버전. 프로토콜 버전과 별개로 관리한다.
 *
 * 서명 대상 문자열 맨 앞에 박히므로, 규칙이 바뀌면 구버전 서명이 새 규칙으로
 * 우연히 통과하는 일이 구조적으로 불가능해진다.
 */
export const SIGNATURE_SCHEME_VERSION = 1;

/** 서명이 실리는 필드. 이 세 필드는 서명 대상 본문에서 제외된다. */
export const SIGNATURE_FIELD = '_sig';
export const TIMESTAMP_FIELD = '_ts';
export const NONCE_FIELD = '_nonce';

const ENVELOPE_FIELDS = [SIGNATURE_FIELD, TIMESTAMP_FIELD, NONCE_FIELD] as const;

/** 기본 허용 시계 오차. 이보다 오래된(또는 미래의) 서명은 만료로 본다. */
export const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** 서명이 붙은 페이로드에 추가되는 필드들. */
export type SignatureEnvelope = {
  [SIGNATURE_FIELD]: string;
  [TIMESTAMP_FIELD]: number;
  [NONCE_FIELD]: string;
};

export type Signed<T> = T & SignatureEnvelope;

/**
 * 검증 실패 사유.
 *
 * 호출부가 "재시도할 가치가 있는 실패(expired)"와 "사칭 시도(invalid_signature)"를
 * 구분해 로그 수준을 다르게 가져갈 수 있도록 단일 boolean 대신 사유를 돌려준다.
 */
export const VERIFY_FAILURE = {
  NO_SECRET: 'no_secret',
  MISSING_SIGNATURE: 'missing_signature',
  MALFORMED_SIGNATURE: 'malformed_signature',
  MISSING_TIMESTAMP: 'missing_timestamp',
  MISSING_NONCE: 'missing_nonce',
  EXPIRED: 'expired',
  REPLAYED: 'replayed',
  INVALID_SIGNATURE: 'invalid_signature',
} as const;

export type VerifyFailure = typeof VERIFY_FAILURE[keyof typeof VERIFY_FAILURE];

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyFailure };

export type VerifyOptions = {
  /** 허용 시계 오차(ms). 0 이하를 주면 시각 검사를 건너뛴다. */
  maxClockSkewMs?: number;
  /** 재사용된 nonce를 걸러낼 가드. 생략하면 재전송 검사를 하지 않는다. */
  replayGuard?: ReplayGuard;
  /** 테스트에서 시각을 고정하기 위한 주입점. */
  now?: number;
};

/**
 * 값을 결정적(deterministic) JSON 문자열로 직렬화한다.
 *
 * JSON.stringify는 객체 키 순서를 입력 순서 그대로 두므로, 같은 내용이라도
 * 키를 만든 순서가 다르면 다른 문자열이 나온다. Agent와 Hub가 페이로드를 조립하는
 * 코드는 서로 다르니 그대로 쓰면 서명이 맞을 리가 없다. 그래서 객체 키를 재귀적으로
 * 정렬하고 undefined를 버린 뒤에 직렬화한다.
 *
 * 규칙:
 * - 객체 키는 코드 유닛 오름차순(Array#sort 기본값)으로 정렬한다.
 * - 배열 순서는 의미가 있으므로 보존한다.
 * - 값이 undefined인 객체 키는 제거한다(JSON.stringify와 동일).
 * - 배열 원소의 undefined는 null이 된다(JSON.stringify와 동일).
 * - toJSON을 가진 값(Date 등)은 먼저 toJSON을 적용한다.
 * - NaN·Infinity는 null이 된다(JSON.stringify와 동일).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value, new WeakSet())) ?? 'null';
}

function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;

  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === 'function') {
    return normalize(withToJson.toJSON(), seen);
  }

  // 순환 참조는 JSON.stringify에서 던지는 것과 달리 여기서 먼저 잡는다.
  // 서명 단계에서 터지면 원인이 페이로드라는 게 스택만 봐도 드러난다.
  if (seen.has(value)) {
    throw new TypeError('Cannot canonicalize a value with circular references.');
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map(element => normalize(element, seen));
    }

    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      sorted[key] = normalize(source[key], seen);
    }
    return sorted;
  } finally {
    // 형제 노드가 같은 객체를 참조하는 것은 순환이 아니므로 되돌린다.
    seen.delete(value);
  }
}

/**
 * 서명 대상 문자열을 만든다.
 *
 * 이벤트 이름을 포함시키는 이유는 서명 재사용을 막기 위해서다. 이름이 빠지면
 * `service-status`용으로 만든 유효한 서명을 그대로 `command`에 붙여 보낼 수 있다.
 *
 * 개행으로 잇는 것이 안전한 이유는 각 조각이 개행을 품을 수 없기 때문이다.
 * 이벤트 이름과 nonce는 우리가 만드는 값이고, 정규화 JSON은 실제 개행을 `\n`으로
 * 이스케이프한다.
 */
export function signingMaterial(event: string, timestamp: number, nonce: string, payload: unknown): string {
  return [
    `v${SIGNATURE_SCHEME_VERSION}`,
    event,
    String(timestamp),
    nonce,
    canonicalize(stripEnvelope(payload)),
  ].join('\n');
}

/** 서명 필드는 서명 대상에서 빼야 한다(넣으면 자기 자신을 서명하는 셈이 된다). */
function stripEnvelope(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  const rest: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const field of ENVELOPE_FIELDS) delete rest[field];
  return rest;
}

/** HMAC-SHA256 다이제스트를 소문자 hex로 계산한다. */
export function digest(event: string, timestamp: number, nonce: string, payload: unknown, secret: string): string {
  return createHmac('sha256', secret)
    .update(signingMaterial(event, timestamp, nonce, payload), 'utf8')
    .digest('hex');
}

/** 재전송 방지용 nonce를 만든다. */
export function createNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * 페이로드에 서명 봉투를 붙여 돌려준다. 원본은 건드리지 않는다.
 *
 * `secret`이 없으면(최초 register처럼 아직 발급받기 전) 서명 없이 원본을 그대로 돌려준다.
 * 여기서 던지면 비밀을 받기 위한 register 자체가 불가능해진다.
 */
export function sign<T>(event: string, payload: T, secret: string | null | undefined, options: { now?: number; nonce?: string } = {}): T | Signed<T> {
  if (!secret) return payload;

  const timestamp = options.now ?? Date.now();
  const nonce = options.nonce ?? createNonce();

  return {
    ...(payload as object),
    [TIMESTAMP_FIELD]: timestamp,
    [NONCE_FIELD]: nonce,
    [SIGNATURE_FIELD]: digest(event, timestamp, nonce, payload, secret),
  } as Signed<T>;
}

/**
 * 받은 페이로드의 서명을 검증한다.
 *
 * 순서가 중요하다. 서명을 먼저 대조한 뒤에 시각과 nonce를 본다. 반대로 하면
 * 서명이 틀린 페이로드의 nonce가 가드에 등록되어, 공격자가 남의 nonce를 미리
 * 태워버리는 짓이 가능해진다.
 */
export function verify(event: string, payload: unknown, secret: string | null | undefined, options: VerifyOptions = {}): VerifyResult {
  if (!secret) return { ok: false, reason: VERIFY_FAILURE.NO_SECRET };
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: VERIFY_FAILURE.MISSING_SIGNATURE };
  }

  const envelope = payload as Partial<SignatureEnvelope>;
  const signature = envelope[SIGNATURE_FIELD];
  const timestamp = envelope[TIMESTAMP_FIELD];
  const nonce = envelope[NONCE_FIELD];

  if (typeof signature !== 'string' || signature.length === 0) {
    return { ok: false, reason: VERIFY_FAILURE.MISSING_SIGNATURE };
  }
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return { ok: false, reason: VERIFY_FAILURE.MISSING_TIMESTAMP };
  }
  if (typeof nonce !== 'string' || nonce.length === 0) {
    return { ok: false, reason: VERIFY_FAILURE.MISSING_NONCE };
  }
  if (!/^[0-9a-f]+$/i.test(signature)) {
    return { ok: false, reason: VERIFY_FAILURE.MALFORMED_SIGNATURE };
  }

  const expected = digest(event, timestamp, nonce, payload, secret);
  if (!equalsInConstantTime(signature, expected)) {
    return { ok: false, reason: VERIFY_FAILURE.INVALID_SIGNATURE };
  }

  const maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  if (maxClockSkewMs > 0) {
    const now = options.now ?? Date.now();
    if (Math.abs(now - timestamp) > maxClockSkewMs) {
      return { ok: false, reason: VERIFY_FAILURE.EXPIRED };
    }
  }

  if (options.replayGuard && !options.replayGuard.remember(nonce, timestamp)) {
    return { ok: false, reason: VERIFY_FAILURE.REPLAYED };
  }

  return { ok: true };
}

/**
 * 두 hex 문자열을 상수 시간에 비교한다.
 *
 * 일반 `===`는 첫 불일치 바이트에서 빠져나오므로, 비교에 걸린 시간이 "몇 글자까지
 * 맞았는지"를 알려준다. 서명을 한 바이트씩 맞춰가는 공격에 그대로 재료가 된다.
 */
function equalsInConstantTime(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left.toLowerCase(), 'hex');
  const rightBuffer = Buffer.from(right.toLowerCase(), 'hex');

  // 길이가 다르면 timingSafeEqual이 던진다. 길이는 비밀이 아니므로 먼저 비교해도 안전하다.
  if (leftBuffer.length !== rightBuffer.length || leftBuffer.length === 0) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * 이미 본 nonce를 기억해 재전송을 막는다.
 *
 * 서명이 유효해도 그대로 복사해 다시 보내면 같은 명령이 두 번 실행된다. 시계 오차
 * 허용 창(maxClockSkewMs) 안에서는 서명만으로 이걸 구분할 수 없으므로 nonce를 기억한다.
 * 창을 벗어난 항목은 어차피 EXPIRED로 걸리니 버려도 된다 — 그래서 메모리가 무한정
 * 자라지 않는다.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly windowMs: number = DEFAULT_MAX_CLOCK_SKEW_MS) { }

  /**
   * nonce를 기록한다. 처음 보는 nonce면 true, 이미 본 적 있으면 false.
   */
  remember(nonce: string, timestamp: number): boolean {
    this.prune(timestamp);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, timestamp);
    return true;
  }

  /** 현재 기억 중인 nonce 개수. 누수 감시용. */
  get size(): number {
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
  }

  private prune(now: number): void {
    for (const [nonce, timestamp] of this.seen) {
      if (Math.abs(now - timestamp) > this.windowMs) this.seen.delete(nonce);
    }
  }
}
