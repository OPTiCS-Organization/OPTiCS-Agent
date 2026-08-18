import { ServicePortMapping, SourceRepository } from "src/global/types/Command.dto";
import { DeployCommand } from "src/service/dtos/DeployCommand.dto";

export function resolvePortMappings(data: Pick<DeployCommand, 'servicePort' | 'serviceHostPort' | 'serviceContainerPort' | 'servicePortMappings'>): ServicePortMapping[] {
  const mappings = Array.isArray(data.servicePortMappings)
    ? data.servicePortMappings
      .map(mapping => ({
        hostPort: Number(mapping.hostPort),
        containerPort: Number(mapping.containerPort),
      }))
      .filter(mapping =>
        Number.isInteger(mapping.hostPort) &&
        Number.isInteger(mapping.containerPort) &&
        mapping.hostPort >= 1 &&
        mapping.hostPort <= 65535 &&
        mapping.containerPort >= 1 &&
        mapping.containerPort <= 65535
      )
    : [];

  if (mappings.length > 0) return mappings;
  return [{
    hostPort: data.serviceHostPort ?? data.servicePort,
    containerPort: data.serviceContainerPort ?? data.servicePort,
  }];
}

export function normalizeSourceRepositories(sourceUrl: DeployCommand['sourceUrl']): SourceRepository[] {
  const rawEntries = Array.isArray(sourceUrl) ? sourceUrl : [sourceUrl];
  return rawEntries.map((entry) => {
    if (typeof entry === 'string') {
      return { url: entry, rootDirectory: null };
    }
    return {
      url: String(entry.url ?? ''),
      rootDirectory: normalizeRootDirectory(entry.rootDirectory),
    };
  }).filter(entry => entry.url);
}

export function normalizeRootDirectory(rootDirectory: string | null | undefined): string | null {
  const value = rootDirectory?.trim().replace(/^\/+/, '') ?? '';
  return value || null;
}

export function primaryRootDirectory(data: DeployCommand): string | null {
    return normalizeSourceRepositories(data.sourceUrl)[0]?.rootDirectory ?? normalizeRootDirectory(data.rootDirectory);
  }
