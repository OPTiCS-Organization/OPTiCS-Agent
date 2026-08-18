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

// docker CLI의 --format json 출력을 배열로 파싱한다.
// 단일 JSON과 줄바꿈으로 이어진 JSON Lines 두 형식을 모두 받는다.
export function parseJsonOutput<T = Record<string, unknown>>(output: string): T[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as T | T[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed.split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .flatMap(line => {
        try { return [JSON.parse(line) as T]; } catch { return []; }
      });
  }
}
