import { HubEmit } from "../types/HubEmit.type";
import { LogEmitContext } from "../types/LogEmitContext.type";
import { StatusEmitContext } from "../types/StatusEmitContext";
import { ServiceStatus } from "../types/ServiceStatus.type";

// sendLog 클로저 생성 팩토리 함수
export function createServiceLogEmitter(emit: HubEmit, context: LogEmitContext) {
  return {
    sendLog: (line: string) => emit('service-log', {
      serviceIndex: context.serviceIndex,
      log: line,
      timestamp: new Date().toISOString(),
      source: 'agent',
      stream: context.stream,
      containerName: context.containerName,
    }),
  }
}

export function createServiceStatusEmitter(emit: HubEmit, context: StatusEmitContext) {
  return {
    sendStatus: (status: ServiceStatus) => emit('service-status', {
      serviceIndex: context.serviceIndex,
      status,
    })
  }
}
