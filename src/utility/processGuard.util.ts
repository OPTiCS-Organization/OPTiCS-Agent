import log from 'spectra-log';

let installed = false;

/**
 * 프로세스를 끝내버리는 두 이벤트를 가로채 에이전트를 살려둔다.
 *
 * dockerode/docker-modem처럼 내부 .then() 안에서 동기 throw를 하는 라이브러리가 있다.
 * 그 예외는 호출부가 await하는 Promise와 연결되어 있지 않아 try/catch를 그냥 지나치고,
 * Node의 기본 정책(--unhandled-rejections=throw)이 프로세스를 종료시킨다.
 * 에이전트가 죽으면 허브 터널과 모든 서비스 상태 추적이 함께 끊기므로 로그만 남기고 계속 돈다.
 */
export function installProcessGuards(): void {
  if (installed) return;
  installed = true;

  process.on('unhandledRejection', (reason: unknown) => {
    log(`[Process] {{ red : bold : UNHANDLED_REJECTION }}\n  ${describeFailure(reason)}\n  The agent kept running, but whatever awaited this promise will never settle.`, 500, 'ERROR');
  });

  process.on('uncaughtException', (error: unknown) => {
    log(`[Process] {{ red : bold : UNCAUGHT_EXCEPTION }}\n  ${describeFailure(error)}\n  The agent kept running; its state may be inconsistent.`, 500, 'ERROR');
  });
}

// 스택까지 남겨야 어느 라이브러리 안에서 샜는지 추적할 수 있다.
function describeFailure(reason: unknown): string {
  if (!(reason instanceof Error)) return String(reason);

  const stack = reason.stack?.split('\n').slice(1).map(line => `  ${line.trim()}`).join('\n');
  return stack ? `${reason.message}\n${stack}` : reason.message;
}
