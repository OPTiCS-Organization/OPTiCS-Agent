import { stripAnsi } from "./docker-cli";
import { DockerLogEntry } from "./types/DockerLogEntry.type";

function composeServiceName(containerName: string): string {
  return containerName.replace(/-\d+$/, '');
}

export function runtimeLogEntry(line: string, defaultContainerName?: string, stderr = false): DockerLogEntry | null {
  const parsed = parseDockerLogLine(line, defaultContainerName);
  if (!parsed.line.trim()) return null;

  return {
    ...parsed,
    source: 'runtime',
    stream: 'runtime',
    line: stderr ? `ERROR: ${parsed.line}` : parsed.line,
    stderr: stderr || undefined,
  };
}

export function parseDockerLogLine(line: string, defaultContainerName?: string): DockerLogEntry {
  const cleanLine = stripAnsi(line).trim();
  const timestampPattern = '(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2})(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})';
  const match = cleanLine.match(new RegExp(`^(?:(.*?)\\s+\\|\\s*)?${timestampPattern}(?:\\s+(.*))?$`));
  if (!match) {
    const composeLine = cleanLine.match(/^([^|\s]+)\s+\|\s*(.*)$/);
    if (composeLine) {
      const [, prefix, message] = composeLine;
      const containerName = prefix.trim();
      const nested = parseDockerLogLine(message, containerName);
      return {
        ...nested,
        containerName: nested.containerName ?? containerName,
        composeService: nested.composeService ?? composeServiceName(containerName),
      };
    }

    const composeEvent = cleanLine.match(/^([A-Za-z0-9_.-]+-\d+)\s+(exited with code .*|Killed|Aborted|Terminated)$/);
    if (composeEvent) {
      const [, containerName, message] = composeEvent;
      return { line: message, containerName, composeService: composeServiceName(containerName) };
    }

    return { line: cleanLine, containerName: defaultContainerName };
  }

  const [, prefix, base, fraction = '', zone, message = ''] = match;
  const milliseconds = fraction ? fraction.slice(0, 4).padEnd(4, '0') : '';
  const timestamp = new Date(`${base}${milliseconds}${zone}`).toISOString();
  const containerName = prefix?.trim() || defaultContainerName;
  const composeService = containerName ? composeServiceName(containerName) : undefined;

  return { line: message, timestamp, containerName, composeService };
}