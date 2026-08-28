/**
 * Hub로 나가는 emit에 HMAC 서명을 자동으로 붙여주는 팩토리입니다.
 *
 * 서명을 호출부마다 손으로 넣게 두면 언젠가 빠뜨리는 곳이 생기고, 그 한 곳이
 * 서명 도입의 의미를 통째로 지웁니다(Hub가 미서명 이벤트를 계속 받아줘야 하므로).
 * 그래서 "서명해서 보내는 방법"을 하나로 만들고 TunnelService는 그것만 쓰게 합니다.
 *
 * 소켓 자체를 감싸 돌려주지 않는 이유는, 소켓을 돌려주면 `.on`·`.io`·`.connected`
 * 같은 나머지 표면까지 함께 위임해야 하고 호출부가 원본 소켓과 래핑된 소켓 중
 * 무엇을 들고 있는지 헷갈리기 때문입니다. 필요한 건 emit 하나뿐입니다.
 */
import type { Socket } from 'socket.io-client';
import log from 'spectra-log';
import { sign } from './hash.util';

/** TunnelService가 들고 다니는 발신 함수의 형태. ServiceLifecycleService의 registerHubEmit과 호환된다. */
export type HubEmitter = (event: string, payload?: unknown) => void;

/**
 * 서명 비밀을 읽어오는 콜백.
 *
 * 문자열을 직접 받지 않고 콜백으로 받는다. 이 함수는 소켓을 만드는 시점
 * (onModuleInit)에 호출되는데, 그때는 아직 register 응답을 받기 전이라 비밀이
 * 존재하지 않는다. 값을 스냅숏으로 굳히면 영영 null인 채로 남는다.
 * 재등록으로 비밀이 재발급되는 경우까지 콜백 하나로 자연스럽게 따라간다.
 */
export type SigningSecretReader = () => string | null | undefined;

/**
 * 소켓을 받아 Hub로 서명된 페이로드를 보내는 emit 함수를 만든다.
 *
 * @param socket Hub에 연결된 socket.io 클라이언트
 * @param readSigningSecret 호출 시점의 서명 비밀을 돌려주는 콜백
 */
export function createSocketEmitter(socket: Socket, readSigningSecret: SigningSecretReader): HubEmitter {
  return (event, payload) => {
    /**
     * 비밀이 아직 없으면 서명 없이 그대로 보낸다.
     *
     * 최초 `register`가 정확히 이 경우다. 비밀을 받기 위한 요청이라 서명할 수단이
     * 없고, 여기서 막으면 Agent는 영원히 비밀을 발급받지 못한다.
     * "서명이 없으면 거절"을 판단하는 것은 Hub의 몫이지 발신부의 몫이 아니다.
     */
    const secret = readSigningSecret();
    if (!secret) {
      socket.emit(event, payload);
      return;
    }

    /**
     * 서명 봉투는 객체에만 붙는다.
     *
     * 계약상 모든 이벤트 페이로드는 객체지만, `response`처럼 타입이 unknown인
     * 통로가 있어 문자열이나 배열이 들어올 수 있다. 그런 값에 봉투를 얹으면
     * 모양이 바뀌어 Hub의 파싱을 깨뜨리므로 그대로 통과시킨다.
     */
    if (payload === null || payload === undefined || typeof payload !== 'object' || Array.isArray(payload)) {
      socket.emit(event, payload);
      return;
    }

    try {
      socket.emit(event, sign(event, payload, secret));
    } catch (error) {
      /**
       * 정규화가 실패하는 경우는 사실상 순환 참조뿐이고, 이는 페이로드를 조립한
       * 코드의 버그다. 서명 없이 대신 보내면 서명을 강제하는 의미가 사라지고,
       * 그대로 던지면 터미널 스트림 같은 콜백 안에서 Agent를 통째로 세운다.
       * 그래서 크게 남기고 그 이벤트만 버린다.
       */
      log(`[Socket Emitter] {{ red : bold : EMIT:SIGNING_FAILED }}\n  event: ${event}\n  reason: ${error instanceof Error ? error.message : String(error)}\n  This event was dropped and never reached the Hub.`, 500, 'ERROR');
    }
  };
}
