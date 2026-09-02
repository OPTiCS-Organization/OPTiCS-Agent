import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Docker from "dockerode";
import fs from "fs";
import log from "spectra-log";
import { ServicePortMapping } from "src/global/types/Command.dto";

type BuildEvent = { stream?: string; error?: string };

@Injectable()
export class ImageBuildService {
  private docker: Docker;

  constructor(
    private readonly configService: ConfigService,
  ) {
    this.docker = new Docker({
      socketPath: '/var/run/docker.sock'
    });
  }

  // Dockerfile로 이미지를 빌드하며 진행 로그를 그대로 흘려보낸다.
  // 빌드 이벤트에 error가 하나라도 있으면 실패로 처리한다.
  async buildImage(buildDir: string, tag: string, sendLog: (line: string) => void): Promise<void> {
    const stream = await this.docker.buildImage({
      context: buildDir,
      src: fs.readdirSync(buildDir),
    }, { t: tag });

    await new Promise((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null, res: BuildEvent[]) => {
        if (err) return reject(err);
        const failed = res.find(event => event.error);
        if (failed) return reject(new Error(failed.error ?? 'Build failed'));
        resolve(res);
      }, (event: BuildEvent) => {
        if (event.stream) {
          const line = event.stream.trim();
          log(line);
          sendLog(line);
        }
        if (event.error) {
          log(`BUILD ERROR: ${event.error}`);
          sendLog(`BUILD ERROR: ${event.error}`);
        }
      });
    });
  }

  // 빌드한 이미지로 컨테이너를 만들어 시작한다.
  // 재시작 정책은 no로 고정해 실패 상태가 그대로 드러나게 한다.
  async runContainer(
    serviceName: string,
    serviceVersion: string,
    portMappings: ServicePortMapping[],
    env?: Record<string, string>,
  ): Promise<void> {
    const portBindings: Record<string, { HostPort: string }[]> = {};
    const exposedPorts: Record<string, object> = {};
    for (const mapping of portMappings) {
      const key = `${mapping.containerPort}/tcp`;
      portBindings[key] = [{ HostPort: String(mapping.hostPort) }];
      exposedPorts[key] = {};
    }

    const container = await this.docker.createContainer({
      Image: `${serviceName.toLowerCase()}:${serviceVersion}`,
      name: serviceName.toLowerCase(),
      Env: env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : undefined,
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        RestartPolicy: { Name: 'no' },
        ExtraHosts: ['host.docker.internal:host-gateway'],
      },
    });

    await container.start();
    log('Started Service');
  }

  // 기존 컨테이너가 있으면 멈추고 지운다. 없으면 넘어간다.
  // 재배포 시 이름 충돌을 없애기 위한 사전 정리다.
  async removeExistingContainer(serviceName: string, sendLog: (line: string) => void): Promise<void> {
    try {
      const existing = this.docker.getContainer(serviceName);
      const info = await existing.inspect() as { State: { Running: boolean } };
      if (info.State.Running) {
        sendLog(`Stopping existing container '${serviceName}'...`);
        await existing.stop();
      }
      sendLog(`Removing existing container '${serviceName}'...`);
      await existing.remove();
    } catch {
      sendLog('No running container found. Proceeding deploy.');
    }
  }
}
