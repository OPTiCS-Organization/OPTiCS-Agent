<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

<p align="center">OPTiCS Agent // 대상 서버에 상주하며 Docker 서비스를 관리하는 NestJS 백엔드 서비스</p>

## 개요

OPTiCS Agent는 사용자가 배포 대상으로 지정한 서버(자기 PC, VPS 등)에 직접 설치되어 그 서버 위의 Docker
컨테이너 생명주기(배포·시작·중지·재시작·삭제)를 담당하는 상주 프로세스다. Agent는 외부에서 접속을 받는 서버가
아니라, 자신이 OPTiCS Hub(중앙 서버)에 Socket.IO로 **역방향 연결**을 맺고 그 소켓 위에서 Hub의 명령을 받아
로컬 Docker 데몬을 조작한다. 이 구조 덕분에 Agent가 설치된 서버는 인바운드 포트를 열 필요가 없다. Agent 곁에는
로컬 전용 대시보드(`OPTiCS-Agent-Dashboard`)가 함께 뜨며, Agent는 `/info`·`/service`·`/notification`
네임스페이스로 그 대시보드에 상태를 실시간으로 밀어준다.

## 기동 흐름

1. `OPTiCS-Infra/linux/install-agent.sh`(또는 `windows/install-agent.ps1`)가 `docker-compose.yml`과
   `.env`(최초 설치 시 `.env.example`에서 생성)를 내려받고, 선택적으로 호스트 SSH 웹 터미널용 키를 생성한 뒤
   `docker compose up -d`로 `optics-agent`·`optics-agent-dashboard` 컨테이너를 띄운다.
2. 컨테이너 엔트리포인트(`entrypoints/entrypoint.sh:1`)가 `OPTICS_AGENT_RUNTIME=container`를 강제하고
   `npx prisma db push --accept-data-loss`로 로컬 SQLite 스키마를 맞춘 뒤 `node dist/src/main.js`를 실행한다.
3. `TunnelService.onModuleInit()`(`src/tunnel/tunnel.service.ts:123`)이 로컬 DB(`AgentInfo`)에서
   이전에 발급받은 `agent-uuid`·`agent-signing-secret`을 조회하고, `${HUB_API_URL}/agent` 네임스페이스로
   Socket.IO 연결을 연다.
4. 소켓의 `connect` 이벤트에서 `register` 이벤트를 보낸다(`agentUuid`, `agentVersion`, `protocolVersion`).
   최초 연결이라 서명 비밀이 없으면 이 요청은 서명 없이 나간다.
5. Hub가 신규 Agent로 판단하면 UUID·페어링용 `agent-code`·HMAC 서명 비밀을 발급해 `register` 응답
   (`code: 'ok'`)으로 돌려주고, Agent는 이를 `AgentInfo` 테이블에 저장한 뒤
   `ReverseTunnelService.initPreconnectPool()`(`src/tunnel/reverse-tunnel.service.ts:170`)로 터널
   프리커넥트 풀 형성을 시작한다.
6. 사용자가 Hub 콘솔에서 `agent-code`를 입력해 워크스페이스 연결을 요청하면 Hub가 `connect-request`
   이벤트를 보내고, `NotifyService`가 이를 로컬에 저장하며 `NotifyGateway`가 Agent Dashboard로 push한다.
7. 사용자가 Dashboard에서 수락하면 `NotifyController`(`src/notify/notify.controller.ts:28`)가
   `${HUB_API_URL}/v1/agent/connect/accept`를 호출해 페어링을 확정한다.
8. 이후 Hub가 `command` 이벤트로 DEPLOY/START/STOP 등을 보내면 `TunnelService`가 서명을 검증한 뒤
   명령을 처리하고 결과를 `response` 이벤트로 돌려준다(아래 명령 표 참조).

## 모듈 구조

```
AppModule
├── CoreModule            AppService(메트릭 heartbeat, 자가 업데이트), DashboardGateway(/info)
├── DockerModule          Docker 조작을 맡는 10개 서비스 (아래 참조)
├── ServiceModule         ServiceLifecycleService, ServiceGateway(/service), ServiceController(/v1/service)
├── NotifyModule          NotifyService, NotifyGateway(/notification), NotifyController(/v1/notify)
├── TerminalModule        SshTerminalService (호스트 SSH 웹 터미널)
├── TunnelModule          TunnelService(Hub 소켓, 명령 디스패치), ReverseTunnelService(프리커넥트 풀)
├── PrismaModule          PrismaService (SQLite, better-sqlite3 어댑터)
└── UtilityModule         SystemMetricsUtility (CPU/메모리 표본 수집)
```

`src/global/`에는 프로토콜 버전(`protocol.ts`), Agent 자체 버전 판독(`agent-version.ts`), 명령 enum
(`Command.enum.ts`), 배포 프리셋 enum(`DeployOptionEnum.ts`)이 있다. `src/utility/hash.util.ts`는
Hub와 바이트 단위로 동일해야 하는 HMAC 서명 유틸리티의 사본이다(아래 "Hub 통신 보안" 참조).

### `docker/` 하위 10개 서비스

`DockerModule`(`src/docker/docker.module.ts:13`)이 묶는 10개 서비스는 예전의 단일
`DockerService.deployNewService()`(175줄)를 대체한 것으로, 각각 좁은 책임을 진다.

| 서비스                      | 파일                             | 책임                                                                                                                                                                                                                                                          |
| --------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DockerCli`                 | `docker-cli.service.ts`          | `docker` CLI 호출(`runSync`/`run`/`stream`)을 한 곳으로 모으는 경계. 자식 프로세스 환경에서 Agent 전용 변수(`OPTICS_*` 등)를 제거해 사용자 compose 파일의 `${VAR}` 치환 오염을 막는다.                                                                        |
| `SelfInspectService`        | `self-inspect.service.ts`        | 도커 소켓으로 자기 컨테이너를 inspect해 compose 프로젝트명·호스트 측 working_dir·서비스명을 알아낸다. 자가 업데이트에 필요한 "호스트 기준 경로"를 얻는 유일한 방법이며, 구버전 업데이터가 남긴 `/project` 라벨 오염을 형제 컨테이너에서 복구하는 로직도 있다. |
| `DeployService`             | `deploy.service.ts`              | 배포 한 건의 순서(정리 → 클론 → 빌드 → 기동)를 지휘한다. Compose/Dockerfile 분기, 실패 시 정리(현재 비활성화)를 담당한다.                                                                                                                                     |
| `BuildWorkspaceService`     | `build-workspace.service.ts`     | `alpine/git` 헬퍼 컨테이너로 소스를 클론하고, 빌드 컨텍스트 디렉터리(`rootDirectory`) 경로 탈출을 막고, 빌드 디렉터리 삭제(실패 시 헬퍼 컨테이너로 재시도)와 권한 조정을 한다.                                                                                |
| `ComposeProjectService`     | `compose-project.service.ts`     | `docker-compose.yml` 존재 확인, `.env` 파일 생성(`PORT` 주입), 무한 재시작을 막는 `restart: "no"` override 생성, `compose up -d --build`/`down` 실행.                                                                                                         |
| `ImageBuildService`         | `image-build.service.ts`         | DOCKERFILE 프리셋 전용: dockerode로 이미지를 빌드하고 포트 매핑·env·`RestartPolicy: no`로 컨테이너를 생성/기동하며, 재배포 전 기존 컨테이너를 정리한다.                                                                                                       |
| `ContainerLifeCycleService` | `container-lifecycle.service.ts` | 서비스/컨테이너 단위 start·stop·restart·delete. Dockerfile 프리셋은 dockerode로, Compose 프리셋은 `docker compose` CLI로 처리한다. `DELETE`의 `deleteScope`(`'containers' \| 'service'`)를 여기서 구현한다.                                                   |
| `ContainerInspectService`   | `container-inspect.service.ts`   | 서비스에 속한 컨테이너들의 현재 상태 스냅샷 조회. Compose는 `compose ps -a --format json`(빌드 디렉터리가 없으면 `docker ps --filter label=...`로 대체), Dockerfile은 `docker inspect` 단건.                                                                  |
| `DockerLogService`          | `docker-log.service.ts`          | 과거 로그를 배치(2000줄 단위)로 먼저 보내고 `--tail 0`으로 실시간 로그를 이어 스트리밍한다. 무한 스크롤용 `loadOlderContainerLogs`(요청당 최대 5000줄)도 제공한다.                                                                                            |
| `DockerEventService`        | `docker-event.service.ts`        | dockerode `getEvents`로 Docker 데몬 이벤트를 구독해 `die`/`stop`/`kill`/`create`/`start`/`restart`/`destroy`를 내부 상태로 환산한다. 사용자가 CLI로 컨테이너를 직접 건드려도 대시보드 상태가 따라가게 하는 장치.                                              |

### 그 외 핵심 파일

| 컴포넌트                                           | 파일                                       | 책임                                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TunnelService`                                    | `src/tunnel/tunnel.service.ts`             | Hub 소켓 연결, register 흐름, 서명 검증을 거친 이벤트 수신, `command` 디스패치                                                                                            |
| `ReverseTunnelService`                             | `src/tunnel/reverse-tunnel.service.ts`     | Hub 터널 서버에 프리커넥트 소켓 풀(기본 10개)을 유지해 사용자 요청 시 지연 없이 로컬 서비스로 파이핑한다. 하트비트(PING/PONG)·keepalive·백오프 재시도를 구현.             |
| `ServiceLifecycleService`                          | `src/service/service-lifecycle.service.ts` | Docker 상태 변화를 서비스 인덱스에 매핑, 컨테이너 스냅샷 캐시, 세션 마커·로그 이력 관리, `v1DeployService`/`v1StartService`/`v1StopService`/`v1DeleteService` 등 상위 API |
| `AppService`                                       | `src/app.service.ts`                       | 초당 heartbeat cron(CPU/메모리 DB 저장), Agent 자가 업데이트(`updateAgent`) — 별도 헬퍼 컨테이너(`docker:27-cli`)에 교체 작업을 위임                                      |
| `SshTerminalService`                               | `src/terminal/ssh-terminal.service.ts`     | `ssh2`로 호스트에 SSH 접속해 웹 터미널 세션(pty)을 중계                                                                                                                   |
| `NotifyService`/`NotifyGateway`/`NotifyController` | `src/notify/`                              | 워크스페이스 연결 요청의 저장·대시보드 실시간 통지·Hub에 수락/거절 회신                                                                                                   |
| `PrismaService`                                    | `src/share/prisma.service.ts`              | SQLite(`better-sqlite3` 어댑터) 연결. 컨테이너/호스트 실행에 따라 `DATABASE_URL` 기본값이 다르다.                                                                         |
| `SystemMetricsUtility`                             | `src/utility/systemMetric.util.ts`         | CPU(1초 주기)·메모리(250ms 주기) 표본 수집, `getMetrics()`로 구간 집계 후 드레인                                                                                          |

## 명령(COMMAND) 처리

Hub가 서명된 `command` 이벤트로 보내는 명령을 `TunnelService`(`src/tunnel/tunnel.service.ts:282`)가
`switch`로 디스패치한다. `COMMAND` enum은 `src/global/Command.enum.ts:1`에 정의되어 있다.

| 명령                    | 하는 일                                      | 구현 위치                                                                                                                               | 상태                                                                                                                                              |
| ----------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEPLOY`                | 서비스 신규 배포(클론→빌드→기동)             | `tunnel.service.ts:287` → `service-lifecycle.service.ts:339`(`v1DeployService`) → `deploy.service.ts:33`(`deploy`)                      | 구현됨                                                                                                                                            |
| `REDEPLOY`              | 기존 서비스를 같은 절차로 재배포             | `tunnel.service.ts:320` → `service-lifecycle.service.ts:326`(`v1RedeployService`)                                                       | 구현됨                                                                                                                                            |
| `ABORT`                 | 진행 중인 배포 등을 중단                     | `tunnel.service.ts:479`                                                                                                                 | **no-op** — 로그(`CMD:IGNORED`)만 남기고 아무 동작도 하지 않는다                                                                                  |
| `START`                 | 서비스(모든 컨테이너) 시작/재시작            | `tunnel.service.ts:352` → `service-lifecycle.service.ts:352`(`v1StartService`) → `container-lifecycle.service.ts:97`(`restartService`)  | 구현됨                                                                                                                                            |
| `STOP`                  | 서비스(모든 컨테이너) 중지                   | `tunnel.service.ts:377` → `service-lifecycle.service.ts:361`(`v1StopService`) → `container-lifecycle.service.ts:29`(`stopService`)      | 구현됨                                                                                                                                            |
| `CONTAINER_START`       | 컨테이너 단위 시작                           | `tunnel.service.ts:401` → `container-lifecycle.service.ts:59`(`startContainer`)                                                         | 구현됨                                                                                                                                            |
| `CONTAINER_STOP`        | 컨테이너 단위 중지                           | `tunnel.service.ts:427` → `container-lifecycle.service.ts:78`(`stopContainer`)                                                          | 구현됨                                                                                                                                            |
| `CONTAINER_RESTART`     | 컨테이너 단위 재시작                         | `tunnel.service.ts:453` → `container-lifecycle.service.ts:129`(`restartContainer`)                                                      | 구현됨                                                                                                                                            |
| `DELETE`                | 서비스 삭제. `deleteScope`로 범위 구분       | `tunnel.service.ts:482` → `service-lifecycle.service.ts:305`(`v1DeleteService`) → `container-lifecycle.service.ts:148`(`deleteService`) | 구현됨 — `deleteScope: 'containers'`면 컨테이너만(이미지·빌드 디렉터리 보존), `'service'`면 컨테이너+이미지+빌드 디렉터리+DB 레코드까지 전부 제거 |
| `DISCONNECT`            | Hub 요청으로 소켓 연결 종료                  | `tunnel.service.ts:506`                                                                                                                 | 구현됨 — `this.socket.disconnect()`                                                                                                               |
| `STREAM_LOG`            | 과거 로그 일괄 전송 후 실시간 로그 구독 시작 | `tunnel.service.ts:510` → `service-lifecycle.service.ts:250`(`streamServiceLog`) → `docker-log.service.ts:27`                           | 구현됨                                                                                                                                            |
| `LOAD_OLDER_LOG`        | 무한 스크롤용 과거 로그 추가 조회            | `tunnel.service.ts:548` → `service-lifecycle.service.ts:262`/`282`                                                                      | 구현됨                                                                                                                                            |
| `STOP_LOG`              | 실시간 로그 구독 해제                        | `tunnel.service.ts:584` → `service-lifecycle.service.ts:301`(`stopServiceLog`)                                                          | 구현됨                                                                                                                                            |
| `SYNC_CONTAINER_STATUS` | 컨테이너 상태를 즉시 재조회해 Hub로 회신     | `tunnel.service.ts:572` → `service-lifecycle.service.ts:181`(`syncContainerStatus`)                                                     | 구현됨                                                                                                                                            |

## Hub ↔ Agent 통신

Agent는 `${HUB_API_URL}/agent` 네임스페이스에 Socket.IO로 연결한다. 프로토콜 계약 자체는
`OPTiCS-Hub/docs/protocol_v1.md`에 정의되어 있고, 이 Agent가 구현하는 버전은
`src/global/protocol.ts:16`(`PROTOCOL_VERSION = 1`)이다.

### Hub 통신 보안 (HMAC 서명)

모든 이벤트가 평문으로 오가지 않는다. `src/utility/hash.util.ts`가 Hub·Agent 양쪽에 바이트 단위로
동일하게 존재하는 서명 유틸리티이며, 등록 시 발급받은 `signingSecret`을 공유 비밀로 HMAC-SHA256 서명을
붙인다.

- 송신은 전부 `createSocketEmitter`(`src/utility/createSocketEmitter.util.ts:35`)가 만든 `emitToHub`
  하나만 거친다. 비밀이 아직 없으면(최초 `register`) 서명 없이 보낸다.
- 수신은 전부 `createSocketListener`(`src/utility/createSocketListener.util.ts:43`)가 만든 `onFromHub`
  하나만 거친다. `register`/`connect`/`disconnect`를 제외한 모든 이벤트는 서명·타임스탬프(시계 오차
  허용 5분)·nonce(재전송 방지, `ReplayGuard`)를 검증하고 실패하면 핸들러를 아예 부르지 않는다.
- `socket.on`/`socket.emit`을 직접 호출하는 경로가 있으면 그 이벤트만 검증을 우회하게 되므로, 이 두
  래퍼만 쓰도록 코드로 강제되어 있다(ESLint `no-restricted-syntax`).

### Hub → Agent (수신)

| 이벤트                                                              | 용도                                                                                                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect`                                                           | 소켓 연결 성립(서명 검증 제외) → `register` 발신                                                                                                            |
| `register`                                                          | Hub의 등록 응답(서명 검증 제외). `code`에 따라 `ok`/`deprecated_protocol_version`/`unknown_protocol_version`/`invalid_signature`/`registration_failed` 분기 |
| `disconnect`                                                        | 연결 종료 통지(서명 검증 제외)                                                                                                                              |
| `command`                                                           | 위 명령 표 참조                                                                                                                                             |
| `connect-request`                                                   | 워크스페이스 페어링 요청 → 로컬 저장 + Dashboard push                                                                                                       |
| `system-metrics-request`                                            | 현재 CPU/메모리 스냅샷 요청 → `system-metrics`로 즉시 회신                                                                                                  |
| `terminal-open`/`terminal-input`/`terminal-resize`/`terminal-close` | SSH 웹 터미널 세션 제어                                                                                                                                     |
| `tunnel-connect`                                                    | 리버스 터널 오픈 요청(`{token, service_port, tunnel_port}`)                                                                                                 |
| `update-agent`                                                      | Agent 자가 업데이트 요청(`{version}`)                                                                                                                       |
| `reverse-proxy`                                                     | `RouteRequest` 처리 — 코드 주석상 "현재 Hub 버전에서 사용되지 않음"                                                                                         |

### Agent → Hub (송신)

| 이벤트                                                   | 용도                                 |
| -------------------------------------------------------- | ------------------------------------ |
| `register`                                               | 등록/재등록 요청                     |
| `response`                                               | `command` 처리 결과 회신             |
| `service-status` / `service-log`                         | 서비스·컨테이너 상태 및 로그         |
| `service-log-markers` / `service-log-history`            | 세션 마커, 과거 로그 배치            |
| `log-load-progress`                                      | 로그 히스토리 로딩 진행률            |
| `container-status`                                       | 컨테이너 스냅샷(`ContainerSnapshot`) |
| `system-metrics`                                         | `system-metrics-request` 응답        |
| `terminal-ready` / `terminal-output` / `terminal-closed` | SSH 터미널 세션 이벤트               |
| `update-log` / `update-failed`                           | 자가 업데이트 진행 로그·실패 통지    |

## Agent ↔ Dashboard (로컬 게이트웨이)

Dashboard는 Agent가 노출하는 로컬 Socket.IO 네임스페이스에 붙는다(서명 없음 — 로컬 신뢰 경계 내).

| 네임스페이스    | 게이트웨이                                         | 송신 이벤트                             |
| --------------- | -------------------------------------------------- | --------------------------------------- |
| `/info`         | `DashboardGateway`(`src/dashboard.gateway.ts`)     | `info` — CPU/메모리 메트릭(1초 주기)    |
| `/service`      | `ServiceGateway`(`src/service/service.gateway.ts`) | `service-status`, `service-log`         |
| `/notification` | `NotifyGateway`(`src/notify/notify.gateway.ts`)    | `notification` — 워크스페이스 연결 요청 |

Dashboard·기타 로컬 클라이언트가 쓰는 REST 엔드포인트:

| 메서드/경로                               | 컨트롤러            | 설명                                           |
| ----------------------------------------- | ------------------- | ---------------------------------------------- |
| `GET /connect`                            | `AppController`     | 저장된 `agent-code`/`agent-ip` 조회            |
| `GET /cpu-metrics`, `GET /memory-metrics` | `AppController`     | 기간별(`from`/`to`, 기본 최근 7일) 메트릭 조회 |
| `GET /v1/service`                         | `ServiceController` | 로컬 `Services` 테이블 목록                    |
| `POST /v1/service/deploy`                 | `ServiceController` | REST 경유 배포(테스트용 경로, 응답 콜백 없음)  |
| `GET/POST /v1/notify/connect-request*`    | `NotifyController`  | pending 조회, 수락/거절                        |

## 로컬 데이터 모델 (SQLite / Prisma)

`prisma/schema.prisma`에 정의된 모델

- **`AgentInfo`** — key-value 저장소. 실제 쓰이는 키: `agent-uuid`, `agent-signing-secret`,
  `agent-code`, `agent-ip`, `pending-connect-request`.
- **`Services`** — 배포된 서비스 메타데이터(`idx`, `serviceName`, `servicePort`, `serviceStatus`,
  `serviceLastOnline`). `serviceStatus`는 `ServiceStatus` enum(`Running`/`Stopped`/`Restart`/
  `Deleted`/`Removed`).
- **`ServiceLogSessionMarker`** — 배포/재배포/시작 이벤트가 일어난 시점을 기록하는 마커. 서비스 삭제
  (`deleteScope: 'service'`)시 해당 서비스의 마커를 전부 지운다.
- **`CpuUsage`** / **`MemoryUsage`** — 시계열 메트릭(`timestamp` BigInt ms 인덱스, `peak`/`average`/
  `min`, `MemoryUsage`는 `totalMemory` 포함).

### 메트릭 수집·집계·보존

`SystemMetricsUtility`(`src/utility/systemMetric.util.ts`)가 CPU는 1초 주기(`os-utils`의
`cpuUsage` 콜백 자체가 1초 측정 창을 씀), 메모리는 250ms 주기로 표본을 누적한다. `AppService`의
`@Cron('* * * * * *')` heartbeat(`src/app.service.ts:67`)가 **매초** `updatePerformance()`를 호출해:

1. 직전 1초 구간 표본이 있으면 `getMetrics()`로 peak/average/min을 집계하고 카운터를 드레인한다.
2. `CpuUsage`/`MemoryUsage`에 각각 한 행씩 저장한다(초당 1행).
3. `timestamp < now - 7일`인 행을 두 테이블에서 모두 삭제한다(7일 보존).
4. 집계된 스냅샷을 `DashboardGateway.sendMetric()`으로 `/info` 네임스페이스에 즉시 push한다.

(기존 문서의 "5개 샘플 축적 후 DB 집계"는 현재 코드와 다르다 — 실제로는 초당 표본 수만큼 누적된 값을
**매초** 집계·저장한다.)

## 환경변수

`.env.example`이 실제 사용되는 키의 기준이다. 아래는 `configService.get`/`process.env`로 코드에서
직접 읽는 키만 정리한 것이다.

| 키                                | 용도                                                                                                         | 필수 여부                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `PORT`                            | HTTP/WebSocket 서버 리스닝 포트 (`main.ts`)                                                                  | 선택 — 기본 `3001`. compose 배포 시 `5230`으로 설정됨                                  |
| `CORS_ORIGIN`                     | 허용할 Origin(콤마 구분)                                                                                     | 선택 — 기본 `*`                                                                        |
| `HUB_API_URL`                     | Hub REST/Socket.IO 베이스 URL (`/agent` 네임스페이스, 연결 수락/거절 API)                                    | **필수** (`getOrThrow`)                                                                |
| `HUB_TUNNEL_URL`                  | Hub 리버스 터널 서버 호스트                                                                                  | **필수** (`getOrThrow`)                                                                |
| `DATABASE_URL`                    | SQLite 파일 경로                                                                                             | 선택 — 컨테이너 실행 시 기본 `file:/app/data/data.db`, 호스트 실행 시 `./data/data.db` |
| `OPTICS_AGENT_RUNTIME`            | `container`로 설정하면 컨테이너 실행 경로를 강제(볼륨/경로 분기용). 미설정 시 `/.dockerenv` 존재로 자동 판별 | 선택                                                                                   |
| `OPTICS_BUILD_DIR`                | 빌드 워크스페이스 루트(호스트 실행 시)                                                                       | 선택 — 기본 `<cwd>/dist/build`                                                         |
| `OPTICS_BUILD_VOLUME`             | 컨테이너 실행 시 빌드 워크스페이스로 쓰는 명명 볼륨                                                          | 선택 — 기본 `optics-build`                                                             |
| `OPTICS_AGENT_IMAGE`              | 자가 업데이트 시 pull할 이미지 저장소                                                                        | 선택 — 기본 `ghcr.io/optics-organization/optics-agent`                                 |
| `HOST_SSH_HOST`                   | SSH 웹 터미널 대상 호스트                                                                                    | 선택 — 기본 `host.docker.internal`                                                     |
| `HOST_SSH_PORT`                   | SSH 포트                                                                                                     | 선택 — 기본 `22`                                                                       |
| `HOST_SSH_USERNAME`               | SSH 접속 계정                                                                                                | 웹 터미널 사용 시 필수                                                                 |
| `HOST_SSH_PRIVATE_KEY_PATH`       | 개인 키 경로(컨테이너 내부 마운트 경로)                                                                      | 비밀번호 인증을 안 쓰면 필수                                                           |
| `HOST_SSH_PASSWORD`               | SSH 비밀번호                                                                                                 | 개인 키를 안 쓰면 필수                                                                 |
| `HOST_SSH_PRIVATE_KEY_PASSPHRASE` | 개인 키 암호(있는 경우)                                                                                      | 선택                                                                                   |
| `HOST_SSH_HOST_HASH`              | 신뢰할 호스트 키의 SHA-256 해시(ed25519). 지정 시에만 호스트 검증을 수행                                     | 선택                                                                                   |

## 로컬 실행

```bash
npm install

# 개발 모드(watch)
npm run start:dev

# 테스트
npm run test        # 단위 테스트 (jest, *.spec.ts)
npm run test:cov     # 커버리지
```

Docker Compose로 Agent+Dashboard를 함께 띄우려면(레포 소스에서 직접 빌드)

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

`docker-compose.dev.yml`은 운영용 `docker-compose.yml`이 GHCR 이미지를 pull하는 것과 달리 로컬
소스(`.` 및 `../OPTiCS-Agent-Dashboard`)에서 빌드하도록 오버레이한다. `.env` 파일(`.env.example`
참조)에 최소한 `HUB_API_URL`/`HUB_TUNNEL_URL`을 로컬 Hub 주소(예: `http://host.docker.internal:3000`,
`http://host.docker.internal:5220`)로 지정해야 한다.

## 테스트 커버리지

서명/프로토콜/버전처럼 틀리면 아예 사용할 수 없게 되는 순수 로직 위주로 커버했으며,
 `TunnelService`·`DeployService`·`ContainerLifeCycleService` 등 Docker/네트워크 서비스에는 아직 테스트가 없습니다.

- `src/docker/docker-cli.service.spec.ts` — `DockerCli.runSync`/`run`/`stream`, `subprocessEnv` 격리
- `src/global/agent-version.spec.ts` — `AGENT_VERSION`이 `package.json`과 일치하는지
- `src/global/protocol.spec.ts` — `PROTOCOL_VERSION`이 `package.json`의 `optics.protocol`과 일치하는지
- `src/utility/hash.util.spec.ts` — 정규화(canonicalize)·서명·검증·리플레이 가드·고정 벡터
- `src/utility/createSocketEmitter.util.spec.ts` — 서명 봉투 부착, 비밀 없을 때 무서명 통과
- `src/utility/createSocketListener.util.spec.ts` — 서명 검증, 재전송 차단, 핸들러 예외 격리
