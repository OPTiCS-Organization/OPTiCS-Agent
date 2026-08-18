import { log } from "console";
import { stripAnsi } from "./docker-cli";
import fs from 'fs';

export function emitOutputLines(chunk: Buffer | string, sendLog: (line: string) => void, mirrorToAgentLog = false) {
  outputLines(chunk).forEach((line) => {
    if (mirrorToAgentLog) log(line);
    sendLog(line);
  });
}

export function outputLines(chunk: Buffer | string): string[] {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
  return text.split(/\r?\n|\r/).map(line => stripAnsi(line).trim()).filter(Boolean);
}

export function cloneWorkspaceMount() {
  if (isContainerRuntime()) {
    return process.env.OPTICS_BUILD_VOLUME ?? 'optics-build';
  }

  fs.mkdirSync(this.buildRoot, { recursive: true });
  return this.buildRoot;
}

export function isContainerRuntime() {
  return process.env.OPTICS_AGENT_RUNTIME === 'container' || fs.existsSync('/.dockerenv');
}
