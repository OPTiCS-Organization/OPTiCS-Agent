/**
 * Hub에서 들어오는 이벤트의 HMAC 서명을 검증하고 통과한 것만 핸들러로 넘기는 팩토리입니다.
 *
 * `createSocketEmitter`의 반대 방향입니다. Agent 입장에서 `command`는 "이 코드를 받아
 * 실행하라"는 지시이므로, 보낸 쪽이 정말 Hub인지 확인할 수단이 없으면 소켓을 가로챈
 * 쪽이 그대로 원격 실행 권한을 얻습니다.
 *
 * Hub 쪽은 socket.io 서버의 `socket.use()`로 모든 수신 패킷을 한 지점에서 막을 수
 * 있지만, socket.io-client에는 그에 해당하는 미들웨어가 없습니다. `onAny`·`prependAny`는
 * 관찰만 할 뿐 원래 리스너의 실행을 막지 못합니다. 그래서 리스너 등록 자체를 감싸는
 * 방식으로 같은 효과를 냅니다.
 *
 * 이 방식의 약점은 `socket.on`을 직접 부르면 검증을 우회할 수 있다는 점입니다.
 * eslint의 no-restricted-syntax로 직접 호출을 막아 그 구멍을 닫습니다.
 */
import type { Socket } from 'socket.io-client';
import log from 'spectra-log';
import { ReplayGuard, verify } from './hash.util';

/** 검증을 거쳐 리스너를 등록하는 함수. `socket.on`을 대체한다. */
export type HubListener = <T = unknown>(event: string, handler: (payload: T) => void | Promise<void>) => void;

type SigningSecretReader = () => string | null | undefined;

/**
 * 서명 검증 없이 등록되는 이벤트.
 *
 * `register`는 비밀을 받아오는 응답이라 검증할 수 없다. 최초 등록에서는 Agent에게
 * 아직 비밀이 없고, Hub가 그 응답에 서명을 붙여봐야 대조할 재료가 없다.
 * 이 부트스트랩 구간은 TLS(Hub 인증서 검증)에 기대는 수밖에 없다.
 *
 * `connect`·`disconnect`는 socket.io 자체의 수명주기 이벤트이지 Hub가 보낸
 * 페이로드가 아니다.
 */
const UNVERIFIED_EVENTS = new Set(['register', 'connect', 'disconnect']);

/**
 * 소켓을 받아 서명 검증을 거치는 리스너 등록 함수를 만든다.
 *
 * @param socket Hub에 연결된 socket.io 클라이언트
 * @param readSigningSecret 호출 시점의 서명 비밀을 돌려주는 콜백
 */
export function createSocketListener(socket: Socket, readSigningSecret: SigningSecretReader): HubListener {
  /**
   * 재전송 가드는 소켓이 아니라 이 팩토리에 매단다.
   *
   * 소켓이 재연결되어도 같은 인스턴스가 유지되므로, 재연결 직후에 이전 연결에서
   * 가로챈 명령을 다시 밀어넣는 시도까지 막힌다. 창을 벗어난 항목은 스스로 정리된다.
   */
  const replayGuard = new ReplayGuard();

  /**
   * 핸들러의 실패가 프로세스 밖으로 새지 않게 감싼다.
   *
   * 등록된 핸들러 상당수가 async라 거절이 그대로 unhandledRejection이 되고,
   * Node는 기본값으로 그때 프로세스를 죽인다. 명령 하나가 실패했다고 Agent 전체가
   * 내려가면 그 호스트의 모든 서비스가 함께 관리 불능이 된다.
   */
  const invoke = (event: string, handler: (payload: never) => void | Promise<void>, payload: unknown) => {
    const onFailure = (error: unknown) => {
      log(`[Socket Listener] {{ red : bold : HANDLER:FAILED }}\n  event: ${event}\n  reason: ${error instanceof Error ? error.message : String(error)}`, 500, 'ERROR');
    };

    try {
      const result = handler(payload as never);
      if (result instanceof Promise) result.catch(onFailure);
    } catch (error) {
      onFailure(error);
    }
  };

  return (event, handler) => {
    socket.on(event, (payload: unknown) => {
      if (UNVERIFIED_EVENTS.has(event)) {
        invoke(event, handler as (payload: never) => void | Promise<void>, payload);
        return;
      }

      /**
       * 비밀이 없으면 검증할 수 없고, 검증할 수 없으면 실행하지 않는다.
       *
       * 정상 경로에서는 register 응답으로 비밀을 받은 뒤에야 Hub가 명령을 보내므로
       * 이 분기에 걸리지 않는다. 걸린다면 등록이 끝나기 전에 명령이 왔다는 뜻이다.
       */
      const secret = readSigningSecret();
      if (!secret) {
        log(`[Socket Listener] {{ red : bold : SIGNATURE:NO_SECRET }}\n  event: ${event}\n  This event was dropped: the agent has no signing secret yet.`, 401, 'ERROR');
        return;
      }

      const verification = verify(event, payload, secret, { replayGuard });
      if (!verification.ok) {
        log(`[Socket Listener] {{ red : bold : SIGNATURE:REJECTED }}\n  event: ${event}\n  reason: ${verification.reason}\n  This event was dropped and never reached its handler.`, 401, 'ERROR');
        return;
      }

      invoke(event, handler as (payload: never) => void | Promise<void>, payload);
    });
  };
}
