import { ContainerStatus } from "../types/ContainerState.type";

// 도커의 State/ExitCode/Health를 OPTiCS가 쓰는 6가지 상태로 환산한다.
// running이라도 헬스체크가 unhealthy면 failed로 본다.
export function normalizeContainerStatus(state?: string, exitCode?: number | null, health?: string | null): ContainerStatus {
  const normalizedState = (state ?? '').toLowerCase();
  const normalizedHealth = (health ?? '').toLowerCase();
  if (normalizedState === 'removing' || normalizedState === 'removed') return 'removed';
  if (normalizedState === 'created' || normalizedState === 'restarting') return 'starting';
  if (normalizedState === 'running') {
    if (normalizedHealth === 'unhealthy') return 'failed';
    if (normalizedHealth === 'starting') return 'starting';
    return 'running';
  }
  if (normalizedState === 'exited' || normalizedState === 'dead') return exitCode && exitCode !== 0 ? 'failed' : 'stopped';
  if (normalizedState === 'paused') return 'stopped';
  return 'stopped';
}

// docker ps의 Status 문자열("Up 3 minutes (healthy)")에서 헬스 상태만 뽑아낸다.
// 헬스체크가 없는 컨테이너는 null을 돌려준다.
export function healthFromStatus(status?: string): string | null {
  if (!status) return null;
  const lower = status.toLowerCase();
  if (lower.includes('unhealthy')) return 'unhealthy';
  if (lower.includes('health: starting') || lower.includes('(health: starting)')) return 'starting';
  if (lower.includes('healthy')) return 'healthy';
  return null;
}

// docker ps가 콤마로 이어붙여 주는 라벨 문자열을 객체로 바꾼다.
// 값에 '='가 들어갈 수 있어 첫 '=' 기준으로만 자른다.
export function labelsToRecord(labels?: string): Record<string, string> {
  if (!labels) return {};
  return Object.fromEntries(
    labels.split(',')
      .map(label => label.split('='))
      .filter(([key]) => Boolean(key))
      .map(([key, ...value]) => [key, value.join('=')]),
  );
}
