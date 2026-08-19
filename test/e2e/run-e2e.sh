#!/usr/bin/env bash
# OPTiCS Agent 로컬 E2E 하네스.
#
# Hub를 띄우지 않고 /agent 소켓만 흉내내는 스텁으로 배포/중지/재시작/삭제 전 주기를 검증한다.
# 외부로 나가는 요청이 없다: 소스는 로컬 bare 저장소를 마운트 경유로 클론하고,
# 베이스 이미지는 에이전트가 이미 쓰는 alpine:3.20만 사용한다.
#
# 사용법:
#   test/e2e/run-e2e.sh              # 두 프리셋 전부
#   test/e2e/run-e2e.sh compose      # COMPOSE만
#   test/e2e/run-e2e.sh dockerfile   # DOCKERFILE만
#   E2E_KEEP=1 test/e2e/run-e2e.sh   # 종료 후에도 워크스페이스/로그 보존

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_ROOT="$(cd "$HERE/../.." && pwd)"
WORK="${E2E_WORK:-$HERE/.work}"

STUB_PORT="${E2E_STUB_PORT:-5599}"
AGENT_PORT="${E2E_AGENT_PORT:-5231}"
COMPOSE_PORT="${E2E_COMPOSE_PORT:-8099}"
DF_PORT="${E2E_DF_PORT:-8098}"
BASE_IMAGE="alpine:3.20"

EVENTS="$WORK/events.jsonl"
PASS=0
FAIL=0

log()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
info() { printf '       %s\n' "$*"; }

cleanup() {
  [ -n "${AGENT_PID:-}" ] && kill "$AGENT_PID" 2>/dev/null
  [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null
  sleep 0.5
  # PID로 못 잡은 잔여가 있으면 이 하네스가 띄운 것만 골라 정리한다.
  ps -eo pid,cmd | grep -E "$WORK/dist/src/main|$HERE/hub-stub.mjs" | grep -v grep \
    | awk '{print $1}' | xargs -r kill -9 2>/dev/null
  docker ps -a --filter "label=com.docker.compose.project=e2e-compose" -q | xargs -r docker rm -f >/dev/null 2>&1
  docker rm -f e2e-dockerfile >/dev/null 2>&1
  docker rmi -f e2e-dockerfile:0.0.1 >/dev/null 2>&1
  if [ -z "${E2E_KEEP:-}" ]; then
    rm -rf "$WORK"
  else
    info "보존됨: $WORK"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------- 사전 점검
command -v docker >/dev/null || { echo "docker가 필요합니다."; exit 1; }
docker info >/dev/null 2>&1 || { echo "docker 데몬에 접근할 수 없습니다."; exit 1; }
docker image inspect "$BASE_IMAGE" >/dev/null 2>&1 || {
  info "$BASE_IMAGE 가 없어 받아옵니다."
  docker pull -q "$BASE_IMAGE" >/dev/null || { echo "$BASE_IMAGE pull 실패"; exit 1; }
}

port_busy() { ss -ltn 2>/dev/null | grep -q ":$1 "; }
for p in "$STUB_PORT" "$AGENT_PORT" "$COMPOSE_PORT" "$DF_PORT"; do
  if port_busy "$p"; then
    echo "포트 $p 가 이미 사용 중입니다. 이전 실행이 남아 있으면 정리한 뒤 다시 시도하세요."
    echo "  (E2E_STUB_PORT / E2E_AGENT_PORT / E2E_COMPOSE_PORT / E2E_DF_PORT 로 변경 가능)"
    exit 1
  fi
done

# ---------------------------------------------------------------- 준비
log "환경 준비"
rm -rf "$WORK"
mkdir -p "$WORK/build"
: > "$EVENTS"

# 픽스처를 로컬 bare 저장소로 만든다. 빌드 워크스페이스 안에 두면
# 클론 컨테이너가 마운트를 통해 접근하므로 네트워크가 전혀 필요 없다.
make_repo() { # <fixture_dir> <repo_name>
  local src="$1"
  local name="$2"
  local tmp="$WORK/fixture-$name"
  mkdir -p "$tmp" && cp -r "$src/." "$tmp/"
  ( cd "$tmp" && git init -q -b main . \
      && git add -A \
      && git -c user.email=e2e@local -c user.name=e2e commit -qm "e2e fixture" ) || return 1
  git clone -q --bare "$tmp" "$WORK/build/$name.git" || return 1
  ( cd "$WORK/build/$name.git" && git update-server-info )
}
make_repo "$HERE/fixtures/compose" compose-repo    || { echo "compose 픽스처 준비 실패"; exit 1; }
make_repo "$HERE/fixtures/dockerfile" df-repo      || { echo "dockerfile 픽스처 준비 실패"; exit 1; }
info "픽스처 저장소 생성 완료"

# 에이전트를 별도 outDir로 빌드한다. nest build는 dist/를 지워서 개발 중인
# 인스턴스를 죽이므로 tsc를 직접 쓰고, 경로 별칭은 NODE_PATH로 해결한다.
info "에이전트 빌드 중..."
( cd "$AGENT_ROOT" && npx tsc -p tsconfig.build.json --outDir "$WORK/dist" --noEmit false ) \
  || { echo "빌드 실패"; exit 1; }
ln -sfn "$AGENT_ROOT/node_modules" "$WORK/dist/node_modules"

# 전용 SQLite. 운영 data.db는 건드리지 않는다.
( cd "$AGENT_ROOT" && npx prisma db push --url "file:$WORK/agent.db" >/dev/null 2>&1 ) \
  || { echo "테스트 DB 생성 실패"; exit 1; }
info "격리된 DB 생성 완료"

# ---------------------------------------------------------------- 기동
log "Hub 스텁 및 에이전트 기동"
STUB_PORT="$STUB_PORT" E2E_EVENTS="$EVENTS" node "$HERE/hub-stub.mjs" > "$WORK/stub.log" 2>&1 &
STUB_PID=$!
stub_up=""
for _ in $(seq 30); do
  if ! kill -0 "$STUB_PID" 2>/dev/null; then
    echo "스텁이 기동 직후 종료됐습니다. 로그: $WORK/stub.log"; exit 1
  fi
  curl -sf "http://127.0.0.1:$STUB_PORT/status" >/dev/null 2>&1 && { stub_up=1; break; }
  sleep 0.2
done
[ -n "$stub_up" ] || { echo "스텁이 응답하지 않습니다. 로그: $WORK/stub.log"; exit 1; }

# HUB_API_URL을 반드시 덮어써야 한다. .env는 운영 Hub를 가리킨다.
# exec를 써야 $! 가 서브셸이 아니라 node의 PID가 된다. 그렇지 않으면
# 종료 시 서브셸만 죽고 에이전트가 포트를 잡은 채 남는다.
(
  cd "$AGENT_ROOT" || exit 1
  exec env \
    NODE_PATH="$WORK/dist:$AGENT_ROOT/node_modules" \
    PORT="$AGENT_PORT" \
    HUB_API_URL="http://127.0.0.1:$STUB_PORT" \
    HUB_TUNNEL_URL="http://127.0.0.1:$STUB_PORT" \
    DATABASE_URL="file:$WORK/agent.db" \
    OPTICS_BUILD_DIR="$WORK/build" \
    CORS_ORIGIN="http://127.0.0.1:$AGENT_PORT" \
    node "$WORK/dist/src/main"
) > "$WORK/agent.log" 2>&1 &
AGENT_PID=$!

connected=""
for _ in $(seq 60); do
  if curl -sf "http://127.0.0.1:$STUB_PORT/status" 2>/dev/null | grep -q '"connected":true'; then
    connected=1; break
  fi
  sleep 0.5
done
[ -n "$connected" ] || { bad "에이전트가 스텁에 연결되지 않음 (로그: $WORK/agent.log)"; exit 1; }
ok "에이전트가 스텁에 연결됨"

# ---------------------------------------------------------------- 헬퍼
# 명령을 보내기 직전의 이벤트 줄 수를 기록해 둔다. 이후 검증은 이 지점 이후만 본다.
# 이렇게 하지 않으면 STOP 뒤의 START를 기다릴 때 DEPLOY 때 남은 running을 보고
# 즉시 통과해 버린다.
MARK=0
send() { # <json>
  MARK=$(wc -l < "$EVENTS")
  curl -sf -X POST "http://127.0.0.1:$STUB_PORT/cmd" \
    -H 'content-type: application/json' -d "$1" >/dev/null
}

# 특정 서비스가 원하는 상태에 도달할 때까지 기다린다. sleep 고정 대기를 쓰지 않는 이유는
# 이미지 pull 여부에 따라 배포 시간이 크게 달라지기 때문이다.
wait_status() { # <serviceIndex> <status> [timeout_sec]
  local idx="$1" want="$2" timeout="${3:-180}" start=$SECONDS
  while [ $((SECONDS - start)) -lt "$timeout" ]; do
    if python3 - "$EVENTS" "$idx" "$want" "$MARK" <<'PY'
import json, sys
path, idx, want, mark = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4])
try:
    for lineno, line in enumerate(open(path), start=1):
        if lineno <= mark: continue
        try: rec = json.loads(line)
        except ValueError: continue
        if rec.get('event') != 'service-status': continue
        p = rec.get('payload') or {}
        if p.get('serviceIndex') == idx and p.get('status') == want:
            sys.exit(0)
except FileNotFoundError:
    pass
sys.exit(1)
PY
    then return 0; fi
    sleep 1
  done
  return 1
}

http_is() { # <port> <expected body>
  local body; body="$(curl -sf --max-time 5 "http://127.0.0.1:$1" 2>/dev/null)"
  [ "$body" = "$2" ]
}

statuses_of() { # <serviceIndex>
  python3 - "$EVENTS" "$1" <<'PY'
import json, sys
path, idx = sys.argv[1], int(sys.argv[2])
seen = []
for line in open(path):
    try: rec = json.loads(line)
    except ValueError: continue
    if rec.get('event') != 'service-status': continue
    p = rec.get('payload') or {}
    if p.get('serviceIndex') != idx: continue
    s = p.get('status')
    if not seen or seen[-1] != s: seen.append(s)
print(' -> '.join(seen))
PY
}

# ---------------------------------------------------------------- 시나리오
run_compose() {
  log "COMPOSE 프리셋"
  send "{\"command\":\"DEPLOY\",\"serviceIndex\":1,\"serviceName\":\"e2e-compose\",\"serviceVersion\":\"0.0.1\",
        \"deployPreset\":\"COMPOSE\",\"sourceUrl\":\"/workspace/compose-repo.git\",\"servicePort\":3000,
        \"servicePortMappings\":[{\"hostPort\":$COMPOSE_PORT,\"containerPort\":3000}],\"env\":{}}"
  if wait_status 1 running; then ok "DEPLOY -> running"; else bad "DEPLOY가 running에 도달하지 못함"; return; fi
  if http_is "$COMPOSE_PORT" "optics-e2e-ok"; then ok "서비스가 HTTP 응답"; else bad "HTTP 응답 없음 (:$COMPOSE_PORT)"; fi

  send '{"command":"STOP","serviceIndex":1,"serviceName":"e2e-compose","deployPreset":"COMPOSE"}'
  if wait_status 1 stopped 60; then ok "STOP -> stopped"; else bad "STOP이 stopped에 도달하지 못함"; fi

  send '{"command":"START","serviceIndex":1,"serviceName":"e2e-compose","deployPreset":"COMPOSE"}'
  if wait_status 1 running 90 && http_is "$COMPOSE_PORT" "optics-e2e-ok"; then
    ok "START -> running + HTTP 응답"
  else bad "START 후 서비스가 살아나지 않음"; fi

  send '{"command":"DELETE","serviceIndex":1,"serviceName":"e2e-compose","deployPreset":"COMPOSE","deleteScope":"service"}'
  if wait_status 1 removed 90; then ok "DELETE -> removed"; else bad "DELETE가 removed에 도달하지 못함"; fi
  if [ "$(docker ps -a --filter 'label=com.docker.compose.project=e2e-compose' -q | wc -l)" -eq 0 ]; then
    ok "컨테이너 잔여 없음"
  else bad "컨테이너가 남아 있음"; fi
  info "상태 전이: $(statuses_of 1)"
}

run_dockerfile() {
  log "DOCKERFILE 프리셋"
  send "{\"command\":\"DEPLOY\",\"serviceIndex\":2,\"serviceName\":\"e2e-dockerfile\",\"serviceVersion\":\"0.0.1\",
        \"deployPreset\":\"DOCKERFILE\",\"sourceUrl\":\"/workspace/df-repo.git\",\"servicePort\":3000,
        \"servicePortMappings\":[{\"hostPort\":$DF_PORT,\"containerPort\":3000}],\"env\":{}}"
  if wait_status 2 running; then ok "DEPLOY -> running"; else bad "DEPLOY가 running에 도달하지 못함"; return; fi
  if http_is "$DF_PORT" "optics-df-ok"; then ok "서비스가 HTTP 응답"; else bad "HTTP 응답 없음 (:$DF_PORT)"; fi
  if docker image inspect e2e-dockerfile:0.0.1 >/dev/null 2>&1; then
    ok "이미지 e2e-dockerfile:0.0.1 생성됨"
  else bad "이미지가 생성되지 않음"; fi

  send '{"command":"DELETE","serviceIndex":2,"serviceName":"e2e-dockerfile","deployPreset":"DOCKERFILE","deleteScope":"service"}'
  if wait_status 2 removed 90; then ok "DELETE -> removed"; else bad "DELETE가 removed에 도달하지 못함"; fi
  info "상태 전이: $(statuses_of 2)"
}

# ---------------------------------------------------------------- 로그 계약 점검
check_log_payload() {
  log "service-log payload 필드"
  python3 - "$EVENTS" <<'PY'
import json, sys
need = ['serviceIndex', 'log', 'timestamp', 'source', 'stream', 'containerName']
for line in open(sys.argv[1]):
    try: rec = json.loads(line)
    except ValueError: continue
    if rec.get('event') != 'service-log': continue
    p = rec.get('payload') or {}
    missing = [k for k in need if k not in p]
    if missing:
        print(f"  \033[31mFAIL\033[0m 누락 필드 {missing} : {str(p)[:80]}")
        sys.exit(1)
    print(f"  \033[32mPASS\033[0m 모든 service-log에 {len(need)}개 필드 존재")
    sys.exit(0)
print("  \033[31mFAIL\033[0m service-log 이벤트가 없음")
sys.exit(1)
PY
  if [ $? -eq 0 ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
}

case "${1:-all}" in
  compose)    run_compose ;;
  dockerfile) run_dockerfile ;;
  all)        run_compose; run_dockerfile ;;
  *) echo "사용법: $0 [all|compose|dockerfile]"; exit 1 ;;
esac
check_log_payload

log "결과"
printf '  통과 %d / 실패 %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
