import { Agent } from "src/types/Agent.type";

export type RegisterPayload =
  | { code: 'ok'; data: Agent }
  | { code: 'unsupported_protocol'; data: { minimum: number, maximum: number } }
  | { code: 'registration_failed'; data: { reason: string } }
