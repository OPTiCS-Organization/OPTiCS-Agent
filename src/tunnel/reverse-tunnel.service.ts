/*
 * Agent가 Tunnel Server로 여는 역방향 터널입니다.
 *
 *   open()       : Hub의 tunnel-connect 명령을 받아 요청마다 새로 여는 기존 경로
 *   preconnect() : 미리 열어 둔 소켓 풀에서 꺼내 쓰는 경로
 *
 * 풀 소켓은 대부분 유휴 상태로  있는데, 유휴 TCP에서는 죽은 상대와 조용한 상대가
 * 구분되지 않습니다. FIN(종료 신호) 없이 사라지면(경로 단절, NAT 매핑 만료, 호스트 강제 종료,
 * 서버 이벤트 루프 정지) close가 안 불려 좀비가 풀에 남고, 자리를 차지하고 있으니
 * 리필도 안 됩니다. 풀은 썩는데 Agent만 멀쩡하다고 믿는 상태가 됩니다.
 *
 * 그래서 PRE ack·keepalive·하트비트 셋으로 나눠 봅니다. 각각 잡는 문제가 다릅니다.
 */
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import net from 'net';
import log from "spectra-log";
import { createNonce, digest } from "src/utility/hash.util";

type SigningSecretReader = () => string | null | undefined;

/** 프리커넥트 소켓 하나. 타이머를 소켓과 묶어 둬야 정리할 때 빠뜨리지 않는다. */
type PooledConnection = {
  socket: net.Socket;
  /** \n이 나올 때까지 모아 두는 수신 버퍼. */
  buffer: Buffer;
  /** OPEN 이후 바이트 구간으로 넘어갈 때 라인 리더를 떼는 함수. */
  detachReader?: () => void;
  heartbeat?: NodeJS.Timeout;
  /** 걸려 있으면 PONG 대기 중이라는 뜻. */
  pongDeadline?: NodeJS.Timeout;
  /** 고장 증거를 남기고 죽었는지. 정상 close와 달리 이건 백오프를 탄다. */
  unhealthy?: boolean;
};

/** 터널 서버의 프리커넥트 제어 포트. */
const PRECONNECT_PORT = 5220;
/** 유지하려는 유휴 소켓 수. */
const TARGET_POOL_COUNT = 10;
/** SYN 상한. 없으면 상대가 SYN을 삼킬 때 OS 기본값(리눅스면 2분 넘는다)까지 매달린다. */
const CONNECT_TIMEOUT_MS = 10_000;
/** PRE 줄을 보낸 뒤 ack를 기다리는 시간. */
const ACK_TIMEOUT_MS = 5_000;
/** 유휴 소켓에 PING을 보내는 주기. */
const HEARTBEAT_INTERVAL_MS = 20_000;
/** PING을 보낸 뒤 PONG을 기다리는 시간. */
const PONG_TIMEOUT_MS = 5_000;
/** OS가 유휴 연결에 keepalive 프로브를 시작하기까지의 유휴 시간. */
const KEEPALIVE_DELAY_MS = 30_000;
/** 로컬 서비스가 떠 있는 호스트. */
const LOCAL_SERVICE_HOST = 'host.docker.internal';

/**
 * 재시도로는 안 풀리는 거절. 시크릿이 만료되었거나 시계가 틀어진 경우다.
 * 같은 내용으로 서명해도 거절당하니 재등록 전까지 풀 형성을 멈춘다.
 */
const FATAL_REJECTIONS = new Set(['invalid_signature', 'expired', 'no_secret']);

/** 반복 오류를 묶는 창 길이. */
const LOG_WINDOW_MS = 60_000;

/**
 * 반복되는 터널 오류를 1분 단위로 묶어 찍는다.
 *
 * 장애가 시작되면 첫 줄은 바로 낸다. 그래야 무슨 일이 났는지 1분을 기다리지 않는다.
 * 그 뒤로는 세기만 하고 창이 끝날 때 종류별 횟수를 한 줄로 낸다. 조용한 창에서는
 * 타이머를 놓아 버리므로 평상시에는 로그도 타이머도 남지 않는다.
 */
class TunnelErrorLog {
  private readonly counts = new Map<string, { count: number; detail: string }>();
  private window?: NodeJS.Timeout;

  record(kind: string, detail: string) {
    // 창이 닫혀 있다는 건 조용하던 중이라는 뜻이다. 첫 신호는 그대로 보여 준다.
    if (!this.window) {
      log(`[Rev. Tunnel Service] {{ orange : bold : ${kind} }}\n  ${detail}`);
      this.open();
      return;
    }

    const seen = this.counts.get(kind);
    if (seen) {
      seen.count++;
      seen.detail = detail;
    } else {
      this.counts.set(kind, { count: 1, detail });
    }
  }

  private open() {
    this.window = setTimeout(() => this.flush(), LOG_WINDOW_MS);
  }

  private flush() {
    if (this.counts.size === 0) {
      this.window = undefined;
      return;
    }

    const lines = [...this.counts]
      .map(([kind, { count, detail }]) => `  ${kind} x${count} — ${detail}`)
      .join('\n');
    log(`[Rev. Tunnel Service] {{ orange : bold : PRECONN:ERRORS }}\n  last ${LOG_WINDOW_MS / 1000}s\n${lines}`);

    this.counts.clear();
    this.open();
  }
}

@Injectable()
export class ReverseTunnelService {
  hubTunnelUrl: string;

  private readonly errorLog = new TunnelErrorLog();
  private readonly pool = new Set<PooledConnection>();
  /** 연결 중이거나 ack를 기다리는 소켓 수. 아직 풀이 아니다. */
  private pending = 0;
  /**
   * 백오프 리필 타이머. 풀 전체에 하나만 둔다.
   * 소켓마다 잡으면 동시 실패 10건이 타이머 10개가 되고, 각각이 또 10개를 채우려 든다.
   */
  private refillTimer?: NodeJS.Timeout;
  /** 연속 실패 라운드 수. 백오프 계산에 쓴다. */
  private consecutiveFailures = 0;
  /** 치명적 거절을 받아 풀 형성을 멈춘 상태. */
  private suspended = false;

  private agentUuid: string | undefined = undefined;
  private readSigningSecret: SigningSecretReader | undefined = undefined;

  constructor(
    private readonly configService: ConfigService,
  ) {
    this.hubTunnelUrl = new URL(configService.getOrThrow<string>('HUB_TUNNEL_URL')).hostname;
  };

  /** 터널이 살아 있는지는 개별 소켓이 아니라 풀이 목표치를 유지하느냐로 본다. */
  get preconnectStatus() {
    return {
      pooled: this.pool.size,
      pending: this.pending,
      target: TARGET_POOL_COUNT,
      consecutiveFailures: this.consecutiveFailures,
      suspended: this.suspended,
    };
  }

  open(payload: { servicePort: number, token: string, tunnelPort: number }) {
    const tunnelSocket = net.connect(payload.tunnelPort, this.hubTunnelUrl);
    tunnelSocket.write(payload.token + '\n');

    const localSocket = net.connect(payload.servicePort, LOCAL_SERVICE_HOST);

    tunnelSocket.pipe(localSocket);
    localSocket.pipe(tunnelSocket);

    tunnelSocket.once('close', () => localSocket.end());
    localSocket.once('close', () => tunnelSocket.end());

    tunnelSocket.on('error', (error) => log(error));
    localSocket.on('error', (error) => log(error));
  }

  /**
   * 프리커넥트 풀을 시작한다. 등록이 끝나 uuid와 서명 비밀이 준비된 뒤에 부른다.
   *
   * 비밀을 값이 아니라 콜백으로 받는 이유는 재발급 때문이다. 값을 굳혀 두면
   * 이후 재발급된 비밀을 영영 못 본다.
   */
  initPreconnectPool(agentUuid: string | null, readSigningSecret: SigningSecretReader) {
    let available = true;
    if (agentUuid) {
      this.agentUuid = agentUuid;
      log('[Rev. Tunnel Serivce] {{ yellow : bold : PRECONN:UUID_SET }}');
    } else {
      log('[Rev. Tunnel Serivce] {{ red : bold : PRECONN:NO_UUID }}');
      available = false;
    }
    if (readSigningSecret && readSigningSecret() !== null && readSigningSecret() !== undefined) {
      this.readSigningSecret = readSigningSecret;
      log('[Rev. Tunnel Serivce] {{ yellow : bold : PRECONN:SIGNITURE_SET }}');
    } else {
      log('[Rev. Tunnel Service] {{ red : bold : PRECONN:NO_SIGNITURE }}');
      available = false;
    }
    if (!available) {
      log('[Rev. Tunnel Service] {{ red : bold : PRECONN:UNAVAILABLE }}\n  error: Unavailable to form preconnection pool. It may sightly increase your service latancy. to fix, try restarting your agent.');
      return;
    }

    // 재등록으로 새 비밀을 받아 다시 들어온 경우이므로 이전 거절과 백오프는 털어낸다.
    this.suspended = false;
    this.consecutiveFailures = 0;
    clearTimeout(this.refillTimer);
    this.refillTimer = undefined;
    log(`[Rev. Tunnel Service] {{ green : bold : PRECONN:ESTABLISHING }}\n  Successfully initialized preconnection settings`);
    this.formPreconnectPool();
  }

  /**
   * 부족분만큼만 채운다. 멱등하므로 소비·끊김·재시도가 동시에 불러도 초과 생성되지 않는다.
   * 소켓 하나하나가 자기 후임을 뽑는 구조였다면 여기서 중복이 났다.
   *
   * 풀이 비어 있으면 한 개만 띄워 본다. 서버가 받아준다는 증거가 없는 상태에서 10개를
   * 한꺼번에 던지면 장애 한 번에 헛된 PRE 검증이 10배로 나간다. 그 한 개가 PRE:OK를
   * 받으면 서버가 살아 있다는 뜻이므로 거기서 나머지를 채운다.
   */
  private formPreconnectPool() {
    if (this.suspended) return;

    const limit = this.pool.size === 0 ? 1 : TARGET_POOL_COUNT;
    while (this.pool.size + this.pending < limit) this.preconnect();
  }

  private preconnect() {
    this.pending++;

    // pending은 소켓당 한 번만 되돌린다. error 뒤에 close가 따라오므로 양쪽에서 빼면 음수가 된다.
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      this.pending--;
    };

    const socket = net.connect(PRECONNECT_PORT, this.hubTunnelUrl);
    const connection: PooledConnection = { socket, buffer: Buffer.alloc(0) };
    let ackDeadline: NodeJS.Timeout | undefined;

    // setTimeout()이 아니라 별도 데드라인인 이유: socket.setTimeout()은 연결 이후에도
    // 살아 있는 유휴 타임아웃이라 하트비트 간격과 부딪힌다.
    let connectDeadline: NodeJS.Timeout | undefined = setTimeout(() => {
      connectDeadline = undefined;
      connection.unhealthy = true;
      this.errorLog.record('PRECONN:CONNECT_TIMEOUT', `no handshake within ${CONNECT_TIMEOUT_MS}ms`);
      socket.destroy();
    }, CONNECT_TIMEOUT_MS);

    socket.once('connect', () => {
      clearTimeout(connectDeadline);
      connectDeadline = undefined;

      // 경로 단절과 호스트 사망용. 유휴 연결을 주기적으로 건드리니 NAT 매핑도 같이 데워진다.
      // 죽었다고 선언하는 속도는 OS 튜너블에 달려 있어 느리다. 빠른 감지는 하트비트 몫.
      socket.setKeepAlive(true, KEEPALIVE_DELAY_MS);

      const agentUuid = this.agentUuid;
      const secret = this.readSigningSecret!();
      const timestamp = Date.now();
      const nonce = createNonce();

      const signature = digest('tunnel:pre', timestamp, nonce, { agentUuid }, secret!);
      socket.write(`tunnel:pre:v1 ${agentUuid} ${timestamp} ${nonce} ${signature}\n`);

      // connect는 TCP가 이어졌다는 것뿐이라 서버가 서명을 받아줬는지는 모른다.
      // 그래서 ack 전까지는 풀에 넣지 않는다. 시계가 틀어졌으면 전부 거절당할 텐데
      // 그대로 넣으면 쓸 수 없는 소켓 10개를 정상이라고 믿게 된다.
      ackDeadline = setTimeout(() => {
        this.errorLog.record('PRECONN:ACK_TIMEOUT', 'connected but the PRE line went unanswered');
        socket.destroy();
      }, ACK_TIMEOUT_MS);
    });

    this.attachLineReader(connection, (verb, args, rest) => {
      switch (verb) {
        case 'PRE:OK': {
          clearTimeout(ackDeadline);
          settle();
          this.pool.add(connection);
          this.startHeartbeat(connection);

          // 풀이 비어 있었다면 이게 정찰용 한 개다. 받아들여졌으니 나머지를 채운다.
          this.formPreconnectPool();

          // 백오프는 목표치를 회복했을 때만 푼다. 하나 붙었다고 풀면 한 개만 붙고
          // 나머지는 계속 실패하는 반쪽 장애에서 램프가 매번 0으로 돌아간다.
          if (this.pool.size >= TARGET_POOL_COUNT) this.consecutiveFailures = 0;
          return;
        }

        case 'PRE:ERR': {
          clearTimeout(ackDeadline);
          const reason = args[0] ?? 'unknown';

          if (FATAL_REJECTIONS.has(reason)) {
            this.suspended = true;
            clearTimeout(this.refillTimer);
            this.refillTimer = undefined;
            log(`[Rev. Tunnel Service] {{ red : bold : PRECONN:REJECTED }}\n  reason: ${reason}\n  Retrying cannot fix this. Halting the pool until the agent re-registers and receives a fresh signing secret.`);
          } else {
            this.errorLog.record('PRECONN:REJECTED', `reason: ${reason}`);
          }

          settle();
          socket.destroy();
          return;
        }

        case 'PONG': {
          clearTimeout(connection.pongDeadline);
          connection.pongDeadline = undefined;
          return;
        }

        case 'OPEN': {
          // 여기서부터 라인 프로토콜을 떠나 바이트 구간이다. 리더를 안 떼고 pipe를 걸면
          // 두 리스너가 같은 스트림을 나눠 먹는다.
          connection.detachReader?.();
          socket.pause();

          this.stopHeartbeat(connection);
          this.pool.delete(connection);

          // 파이핑이 끝날 때까지 기다리면 풀 크기가 동시 요청 수에 발목잡힌다.
          this.formPreconnectPool();

          this.pipeToLocalService(socket, Number(args[0]), rest);
          return;
        }

        default: {
          this.errorLog.record('PRECONN:UNKNOWN_FRAME', `verb: ${verb}`);
          return;
        }
      }
    });

    /*
     * 정리는 close 한 곳에서만 한다. error 뒤에는 반드시 close가 따라온다.
     * 여기서는 고장 증거만 남긴다 — keepalive가 포기했거나 상대가 RST를 보낸 경우다.
     */
    socket.once('error', (error) => {
      connection.unhealthy = true;
      this.errorLog.record('PRECONN:SOCKET_ERROR', error.message);
    });

    socket.once('close', () => {
      clearTimeout(connectDeadline);
      clearTimeout(ackDeadline);
      this.stopHeartbeat(connection);
      const wasPooled = this.pool.delete(connection);

      if (!settled) {
        // ack를 받기 전에 죽었다. 서버가 없거나 거절한 경우이므로 물러서서 재시도한다.
        settle();
        this.scheduleRefill();
        return;
      }

      // 소비된 소켓은 이미 OPEN에서 리필했으므로 여기 안 걸린다.
      if (!wasPooled) return;

      // 유휴 소켓이 끊긴 경우. 정상 close면 바로 채우지만 고장 증거가 있으면 물러선다.
      // 여기서 즉시 채우면 서버가 멎었을 때 10개가 한꺼번에 재연결을 시도한다.
      if (connection.unhealthy) this.scheduleRefill();
      else this.formPreconnectPool();
    });
  }

  /**
   * TCP는 바이트 스트림이라 data 이벤트 하나가 줄 하나라는 보장이 없다. 반 줄만 올 수도,
   * 여러 줄이 붙어 올 수도 있다. handle이 detachReader를 부르면 읽기를 멈춘다.
   */
  private attachLineReader(
    connection: PooledConnection,
    handle: (verb: string, args: string[], rest: Buffer) => void,
  ) {
    let detached = false;

    const onData = (chunk: Buffer) => {
      connection.buffer = Buffer.concat([connection.buffer, chunk]);

      while (!detached) {
        const index = connection.buffer.indexOf(0x0a);  // \n
        if (index === -1) return;

        const line = connection.buffer.subarray(0, index).toString('utf8').trim();
        connection.buffer = connection.buffer.subarray(index + 1);

        const [verb, ...args] = line.split(' ');
        // 남은 바이트를 함께 넘긴다. OPEN 직후에는 이미 요청 본문이 붙어 와 있을 수 있다.
        handle(verb, args, connection.buffer);
      }
    };

    connection.detachReader = () => {
      if (detached) return;
      detached = true;
      connection.socket.off('data', onData);
    };

    connection.socket.on('data', onData);
  }

  /**
   * keepalive는 커널이 대신 응답하므로 이벤트 루프가 멎은 서버도 그대로 통과한다.
   * 앱이 아직 일하는지는 앱만 답할 수 있어서 PING을 따로 던진다.
   */
  private startHeartbeat(connection: PooledConnection) {
    connection.heartbeat = setInterval(() => {
      // 직전 PONG을 아직 기다리는 중이면 그쪽 데드라인이 판정할 때까지 둔다.
      if (connection.pongDeadline) return;

      connection.socket.write('PING\n');
      connection.pongDeadline = setTimeout(() => {
        // 소켓은 열려 있는데 앱이 답을 못 한다.
        connection.unhealthy = true;
        this.errorLog.record('PRECONN:PONG_TIMEOUT', 'socket open but the server stopped answering');
        connection.socket.destroy();
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(connection: PooledConnection) {
    clearInterval(connection.heartbeat);
    clearTimeout(connection.pongDeadline);
    connection.heartbeat = undefined;
    connection.pongDeadline = undefined;
  }

  /** OPEN을 받은 소켓을 로컬 서비스에 잇는다. */
  private pipeToLocalService(tunnelSocket: net.Socket, targetPort: number, pending: Buffer) {
    if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
      this.errorLog.record('PRECONN:BAD_TARGET_PORT', `port: ${targetPort}`);
      tunnelSocket.destroy();
      return;
    }

    const localSocket = net.connect(targetPort, LOCAL_SERVICE_HOST);

    localSocket.once('connect', () => {
      // OPEN 줄 뒤에 붙어 온 바이트가 있으면 먼저 흘려보낸 뒤 이어 붙인다.
      if (pending.length > 0) localSocket.write(pending);
      tunnelSocket.pipe(localSocket);
      localSocket.pipe(tunnelSocket);
    });

    tunnelSocket.once('close', () => localSocket.end());
    localSocket.once('close', () => tunnelSocket.end());

    tunnelSocket.on('error', (error) => this.errorLog.record('PRECONN:TUNNEL_PIPE_ERROR', error.message));
    localSocket.on('error', (error) => this.errorLog.record('PRECONN:LOCAL_PIPE_ERROR', error.message));
  }

  /**
   * 백오프를 두고 리필을 예약한다. 이미 예약돼 있으면 아무것도 안 한다.
   *
   * 이 가드가 없으면 실패 건수만큼 타이머가 생기고 각 타이머가 또 부족분 전체를
   * 채우려 들어 라운드마다 재시도가 배로 불어난다. 실패 10건이 라운드 하나여야 한다.
   * 지연을 누적 변수가 아니라 연속 실패 횟수로 계산하는 것도 마찬가지 이유로,
   * 공유 변수를 실패마다 두 배로 올리면 동시 실패 한 번에 램프가 끝까지 소진된다.
   */
  private scheduleRefill() {
    if (this.suspended || this.refillTimer) return;

    this.consecutiveFailures++;
    const backoffMs = Math.min(500 * 2 ** (this.consecutiveFailures - 1), 30_000);
    const jitter = Math.random() * backoffMs * 0.3;   // 동시 재연결 분산

    this.errorLog.record(
      'PRECONN:RETRY_SCHEDULED',
      `attempt ${this.consecutiveFailures}, in ${Math.round(backoffMs + jitter)}ms, pooled ${this.pool.size}/${TARGET_POOL_COUNT}`,
    );

    this.refillTimer = setTimeout(() => {
      this.refillTimer = undefined;
      this.formPreconnectPool();
    }, backoffMs + jitter);
  }
}
