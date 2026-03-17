export enum DeployOption {
  // 직접 작성한 파일
  DOCKERFILE = 'DOCKERFILE',
  COMPOSE = 'COMPOSE',
  
  // OPTiCS에서 제공하는 프리셋 파일
  PRESET_NEST = 'PRESET_NEST',
}