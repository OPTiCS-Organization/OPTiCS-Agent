// 에이전트 자기 자신용 환경변수가 자식 docker compose 프로세스로 누출되어
// 사용자 compose 파일의 ${VAR} 치환을 오염시키는 것을 방지한다.
export function subprocessEnv(): NodeJS.ProcessEnv {
  const reserved = new Set([
    'PORT',
    'SERVER_PORT',
    'HUB_URL',
    'CENTRAL_SERVER_URL',
    'OPTICS_SOURCE_URL',
    'REMOTE_DOCKER_HOST',
    'REMOTE_DOCKER_PORT',
    'DATABASE_URL',
    'CORS_ORIGIN',
  ]);
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!reserved.has(key) && !key.startsWith('OPTICS_')) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}
