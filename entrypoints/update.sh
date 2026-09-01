#!/bin/sh
# Agent 자기 자신을 교체하는 스크립트.
#
# Agent 컨테이너가 아니라 별도의 헬퍼 컨테이너(docker:cli)에서 실행된다.
# Agent는 이 스크립트가 도는 도중에 죽었다 살아나므로, Agent 안에서는 절대 실행하지 말 것.
#
# 이 파일은 "지금 돌고 있는 구버전"이 실행한다. 즉 스스로를 고칠 수 없는 유일한 파일이므로
# 판단(어느 버전으로 갈지, 얼마나 기다릴지)은 전부 호출자가 env로 넘기고
# 여기서는 기계적인 절차만 수행한다. 정책을 여기에 넣지 말 것.
set -eu

: "${AGENT_IMAGE:?AGENT_IMAGE is required}"
: "${TARGET_TAG:?TARGET_TAG is required}"
: "${AGENT_SERVICE:?AGENT_SERVICE is required}"
: "${HEALTH_WAIT:?HEALTH_WAIT is required}"

ENV_FILE=.env
TAG_KEY=AGENT_IMAGE_TAG

log() { echo "[updater] $*"; }

read_tag() {
  if [ -f "$ENV_FILE" ] && grep -q "^${TAG_KEY}=" "$ENV_FILE"; then
    grep "^${TAG_KEY}=" "$ENV_FILE" | head -n 1 | cut -d= -f2-
  else
    echo "latest"
  fi
}

write_tag() {
  [ -f "$ENV_FILE" ] || : > "$ENV_FILE"
  if grep -q "^${TAG_KEY}=" "$ENV_FILE"; then
    sed -i "s|^${TAG_KEY}=.*|${TAG_KEY}=$1|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$TAG_KEY" "$1" >> "$ENV_FILE"
  fi
}

agent_running() {
  cid=$(docker compose ps -q "$AGENT_SERVICE" 2>/dev/null || true)
  [ -n "$cid" ] || return 1
  [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || echo false)" = "true" ]
}

settle_and_check() {
  log "waiting ${HEALTH_WAIT}s for $1 to settle"
  sleep "$HEALTH_WAIT"
  agent_running
}

# 0. 마운트된 디렉터리가 실제 compose 프로젝트인지 먼저 확인한다.
if ! docker compose config -q >/dev/null 2>&1; then
  log "ERROR: no compose project at $(pwd), nothing changed"
  exit 1
fi

PREVIOUS_TAG=$(read_tag)
log "current=${PREVIOUS_TAG} target=${TARGET_TAG}"

rollback() {
  log "ERROR: rolling back to ${PREVIOUS_TAG}"
  # .env 복원이 실패해도 컨테이너 복구는 시도해야 하므로 set -e로 여기서 멈추지 않게 막는다.
  write_tag "$PREVIOUS_TAG" || log "ERROR: could not restore ${TAG_KEY}, trying compose anyway"
  if docker compose up -d "$AGENT_SERVICE" && settle_and_check "$PREVIOUS_TAG"; then
    log "rolled back to ${PREVIOUS_TAG}"
  else
    log "ERROR: rollback failed, manual recovery required"
  fi
  exit 1
}

# 1. 먼저 받아본다.
#    없는 태그나 미지원 아키텍처처럼 흔한 실패가 여기서 걸러지고,
#    이 시점까지는 .env도 컨테이너도 건드리지 않았으므로 실패해도 무해하다.
log "pulling ${AGENT_IMAGE}:${TARGET_TAG}"
if ! docker pull "${AGENT_IMAGE}:${TARGET_TAG}"; then
  log "ERROR: pull failed, nothing changed"
  exit 1
fi

# 2. 태그를 고정하고 교체한다. 여기서부터는 되돌릴 것이 생긴다.
#    교체 대상은 Agent 서비스뿐이다. 프로젝트 전체를 올리면 Dashboard처럼 이 업데이트와 무관한
#    서비스가 못 뜨는 것만으로 롤백이 돌아, 멀쩡한 Agent를 되돌리게 된다.
write_tag "$TARGET_TAG"
log "recreating ${AGENT_SERVICE}"
if ! docker compose up -d "$AGENT_SERVICE"; then
  log "ERROR: compose up failed"
  rollback
fi

# 3. 새 Agent가 실제로 버티는지 확인한다.
#    부팅 직후 죽는 이미지를 성공으로 처리하면 Agent가 영영 돌아오지 않고,
#    그때는 이 컨테이너의 로그가 사용자에게 남는 유일한 단서가 된다.
if ! settle_and_check "$TARGET_TAG"; then
  log "ERROR: ${TARGET_TAG} did not stay up"
  rollback
fi

log "updated to ${TARGET_TAG}"
