/**
 * 이 Agent가 구현하는 Hub 소켓 계약의 버전.
 *
 * 계약 정의: OPTiCS-Hub/docs/protocol_v1.md
 *
 * 이벤트를 제거·개명하거나 페이로드의 의미를 바꿀 때만 올린다.
 * 이벤트나 optional 필드를 "추가"하는 것은 올리지 않는다.
 * 판단 기준은 하나다 — 구버전 Agent가 새 Hub에 붙었을 때 아무 일도 일어나지 않으면 bump가 아니다.
 *
 * 배포 환경이 아니라 코드의 속성이므로 상수로 박아둔다.
 * 환경변수로 바꿀 수 있게 하면 Hub의 버전 검증을 사용자가 우회할 수 있게 된다.
 *
 * 이 값은 package.json의 optics.protocol과 반드시 일치해야 한다.
 * (릴리즈 워크플로가 package.json 쪽을 읽어 release.json을 만든다. protocol.spec.ts가 일치를 강제한다)
 */
export const PROTOCOL_VERSION = 1;
