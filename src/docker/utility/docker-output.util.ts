import log from "spectra-log";
import { stripAnsi } from "./docker-cli";

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
