import { createHash } from "crypto";

// 서비스 이름을 도커 식별자로 안전한 형태로 바꾼다.
// 컨테이너 이름 / 이미지 태그 / compose 프로젝트명 세 규칙을 동시에 만족해야 해서
// 셋의 교집합인 [a-z0-9_]만 남기고 나머지는 하이픈으로 접는다.
// (공백이 섞인 이름은 도커 API URL 경로에 그대로 실려 요청 자체가 터진다.)
export function toDockerName(rawName: string): string {
  const normalized = (rawName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/[-_]{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');

  if (normalized) return normalized;

  // 한글처럼 전부 걸러지는 이름이면 남는 글자가 없다.
  // 호출부가 여러 곳에서 각자 계산하므로 같은 입력이면 반드시 같은 결과가 나와야 한다.
  return `service-${createHash('sha1').update(rawName ?? '').digest('hex').slice(0, 8)}`;
}
