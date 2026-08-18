import { HubEmit } from "../types/HubEmit.type";
import { LogEmitContext } from "../types/LogEmitContext.type";

// sendLog 클로저 생성 팩토리 함수
export function createServiceLogEmitter(emit: HubEmit, context: LogEmitContext) {
  return {
    sendLog: (line) => emit('service-log', { serviceIndex: context.serviceIndex, log: line, })
  }
  // const sendLog = (line: string) => emit('service-log', {
  //   serviceIndex: si,
  //   log: line,
  //   timestamp: new Date().toISOString(),
  //   source: 'agent',
  //   stream: 'deploy',
  //   containerName: data.serviceName.toLowerCase(),
  // });
}
