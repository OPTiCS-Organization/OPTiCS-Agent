# Agent E2E 하네스

Hub를 띄우지 않고 Agent의 서비스 생명주기(배포 → 중지 → 재시작 → 삭제)를 검증한다.

```bash
test/e2e/run-e2e.sh              # 두 프리셋 전부
test/e2e/run-e2e.sh compose      # COMPOSE만
test/e2e/run-e2e.sh dockerfile   # DOCKERFILE만
E2E_KEEP=1 test/e2e/run-e2e.sh   # 종료 후 작업 디렉토리 보존 (디버깅용)
```

성공하면 exit 0, 하나라도 실패하면 exit 1.

## 왜 Hub를 안 띄우는가

`STOP` / `START` / `DELETE`는 REST로 노출돼 있지 않고 Hub의 `/agent` 소켓으로만 들어온다.
그런데 실제 Hub를 띄우면 Cloudflare DNS·메일·Sentry로 **실제 외부 요청이 나간다.**
그래서 `/agent` 네임스페이스만 흉내내는 최소 스텁(`hub-stub.mjs`)을 쓴다.

이 하네스는 **외부로 나가는 요청이 없다**:

- 소스는 `.work/build/` 안에 만든 로컬 bare 저장소를 클론한다.
  클론 컨테이너가 빌드 워크스페이스를 마운트하므로 네트워크를 타지 않는다.
- 베이스 이미지는 `alpine:3.20` 하나만 쓴다. Agent가 정리 헬퍼로 이미 쓰는 이미지라
  보통 로컬에 있고, 없으면 스크립트가 한 번만 받는다.

## 구성

| 파일 | 역할 |
|---|---|
| `run-e2e.sh` | 준비 → 기동 → 시나리오 → 정리 전 과정 |
| `hub-stub.mjs` | `/agent` 소켓 스텁. 명령 주입(`POST /cmd`)과 이벤트 캡처 |
| `fixtures/compose/` | COMPOSE 프리셋 픽스처 |
| `fixtures/dockerfile/` | DOCKERFILE 프리셋 픽스처 |
| `.work/` | 실행 중 생성 (빌드 결과, DB, 로그, 이벤트). 종료 시 삭제 |

## 격리

운영 환경을 건드리지 않도록 전부 덮어쓴다:

| 변수 | 값 | 이유 |
|---|---|---|
| `HUB_API_URL` | `http://127.0.0.1:5599` | **`.env`는 운영 Hub를 가리킨다.** 안 덮으면 운영에 등록된다 |
| `DATABASE_URL` | `.work/agent.db` | 운영 `data/data.db` 미사용 |
| `OPTICS_BUILD_DIR` | `.work/build` | 개발 빌드 디렉토리와 분리 |
| `PORT` | `5231` | 개발 인스턴스(5230)와 분리 |

에이전트는 `tsc`로 `.work/dist`에 따로 빌드한다. `nest build`는 `dist/`를 지워서
개발 중인 `nest start --watch` 인스턴스를 죽이기 때문이다. 경로 별칭(`src/...`)은
`nest build`만 상대 경로로 바꿔주므로, `tsc`를 쓸 때는 `NODE_PATH`로 해결한다.

## 검증 항목

- COMPOSE: DEPLOY → running + HTTP 응답, STOP → stopped, START → running + HTTP,
  DELETE → removed + 컨테이너 잔여 없음
- DOCKERFILE: DEPLOY → running + HTTP 응답 + 이미지 생성, DELETE → removed
- 모든 `service-log` payload에 `serviceIndex` `log` `timestamp` `source` `stream`
  `containerName` 6개 필드가 있는지

상태 도달은 고정 `sleep`이 아니라 `.work/events.jsonl`을 폴링해서 확인한다.
이미지 pull 여부에 따라 배포 시간이 크게 달라지기 때문이다.

## 알려진 제약

- **컨테이너가 SIGKILL로 죽으면 상태가 잠깐 `failed`로 튄다.**
  `normalizeContainerStatus`가 exitCode≠0을 실패로 보기 때문이고, 픽스처의 `nc`가
  SIGTERM을 처리하지 않아 재현된다. 최종 상태는 정상이라 판정에는 영향이 없다.
- `DELETE`(scope=service)는 `--rmi all`로 **베이스 이미지까지 지운다.**
  `alpine:3.20`이 사라질 수 있고, 그러면 다음 실행에서 한 번 다시 받는다.
- 포트 5599 / 5231 / 8099 / 8098을 쓴다. 점유돼 있으면 스크립트가 먼저 멈춘다.
  `E2E_STUB_PORT` 등으로 바꿀 수 있다.
- Docker 데몬이 containerd 이미지 스토어를 쓰면 dockerode의 classic builder가
  로컬 이미지를 다시 받아 DOCKERFILE 배포가 느려질 수 있다.
