import { Agent } from "src/types/Agent.type";

/**
 * Hub의 register 응답. code로 분기한다.
 *
 * 코드 문자열은 OPTiCS-Hub/src/agent/types/ResultCode.type.ts의 PROTOCOL_RESULT_CODE와
 * 같은 값이어야 한다. 여기에 없는 코드가 오면 Agent는 아무 분기도 타지 않고 무시한다.
 */
export type RegisterPayload =
  | { code: 'ok'; data: Agent }
  /** Agent의 프로토콜이 너무 낡음 → Agent를 올려야 한다. */
  | { code: 'deprecated_protocol_version'; data: { minimum: number, maximum: number } }
  /** Hub가 모르는(더 앞선) 프로토콜 → Hub를 올려야 한다. */
  | { code: 'unknown_protocol_version'; data: { minimum: number, maximum: number } }
  /** 저장된 서명 비밀이 Hub의 것과 다름 → 재등록이 필요하다. */
  | { code: 'invalid_signature'; data: { reason: string } }
  | { code: 'registration_failed'; data: { reason: string } }
