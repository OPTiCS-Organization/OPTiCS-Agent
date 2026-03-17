import { Global, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Docker from "dockerode";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import log from "spectra-log";
import { DeployCommand } from "./service/dtos/DeployCommand.dto";
import { DeployOption } from "./service/enums/PresetMode.enum";
import { GitService } from "./git.service";

@Global()
@Injectable()
export class DockerService {
  private docker: Docker;
  constructor(
    private readonly configService: ConfigService,
    private readonly gitService: GitService,
  ) {
    this.docker = new Docker({
      socketPath: '/var/run/docker.sock'
      // For Remote Docker Connection
      // host: this.configService.getOrThrow<string>('REMOTE_DOCKER_HOST'),
      // port: this.configService.getOrThrow<number>('REMOTE_DOCKER_PORT')
    });
  }

  // 컨테이너 이름을 받아 시작 하는 함수
  async runService(serviceName: string, serviceVersion: string, servicePort: number, env?: Record<string, string>) {
    const container = await this.docker.createContainer({
      Image: `${serviceName.toLowerCase()}:${serviceVersion}`,
      name: serviceName.toLowerCase(),
      Env: env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : undefined,
      HostConfig: {
        PortBindings: {
          [`${servicePort}/tcp`]: [{ HostPort: String(servicePort) }]
        },
        RestartPolicy: { Name: 'unless-stopped' },
        ExtraHosts: ['host.docker.internal:host-gateway']
      }
    });

    await container.start();
    log('Started Service')
  }

  // 이미지로 빌드하는 함수
  async deployNewService(data: DeployCommand) {
    try {
      log(`Creating new Service '${data.serviceName.toLowerCase()}@${data.serviceVersion}'...\n → Deploy Option: ${data.deployPreset}`);
      log(`Cloning from '${data.sourceUrl}...'`)
      await this.gitService.clone(data.sourceUrl, path.join(__dirname, `../build`, data.serviceName.toLowerCase()));
      log('Done.');

      const buildDir = path.join(__dirname, "../build", data.serviceName.toLowerCase());
      fs.chmodSync(buildDir, 0o755);
      fs.readdirSync(buildDir).forEach(file => {
        try { fs.chmodSync(path.join(buildDir, file), 0o755); } catch { /* skip non-chmodable */ }
      });
      log(`Build dir: ${buildDir}`);

      const composeFileExists = fs.existsSync(path.join(buildDir, 'docker-compose.yml'))
        || fs.existsSync(path.join(buildDir, 'docker-compose.yaml'));

      if (data.deployPreset === DeployOption.COMPOSE && !composeFileExists) {
        throw new Error('docker-compose.yml not found. Change deploy option to DOCKERFILE or add docker-compose.yml to the repository.');
      }

      const hasCompose = data.deployPreset === DeployOption.COMPOSE
        || (data.deployPreset !== DeployOption.DOCKERFILE && composeFileExists);

      if (hasCompose) {
        log('Detected docker-compose, Starting build with Docker Compose...')
        if (data.env) {
          const envContent = Object.entries(data.env).map(([k, v]) => `${k}=${v}`).join('\n');
          fs.writeFileSync(path.join(buildDir, '.env'), envContent);
        }
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', 'up', '-d', '--build'], { cwd: buildDir });
          proc.stdout.on('data', (chunk: Buffer) => log(chunk.toString().trim()));
          proc.stderr.on('data', (chunk: Buffer) => log(chunk.toString().trim()));
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker compose exited with code ${code}`)));
        });
      } else {
        log('Detected Dockerfile, Starting build with Dockerfile...')
        const stream = await this.docker.buildImage({
          context: buildDir,
          src: fs.readdirSync(buildDir)
        }, { t: `${data.serviceName.toLowerCase()}:${data.serviceVersion}` });

        await new Promise((resolve, reject) => {
          type BuildEvent = { stream?: string; error?: string };
          this.docker.modem.followProgress(stream, (err: Error, res: BuildEvent[]) => {
            if (err) return reject(err);
            const failed = res.find(r => r.error);
            if (failed) return reject(new Error(failed.error));
            resolve(res);
          }, (event: BuildEvent) => {
            if (event.stream) log(event.stream.trim());
            if (event.error) log(`BUILD ERROR: ${event.error}`);
          });
        });
        log('Done.')

        log(`Now Starting Service '${data.serviceName.toLowerCase()}:${data.serviceVersion}' at Port ${data.servicePort}`)
        await this.runService(data.serviceName, data.serviceVersion, data.servicePort, data.env);
      }
      log('Success.')
    } catch (error) {
      fs.rmSync(path.join(__dirname, '../build', data.serviceName.toLowerCase()), { recursive: true, force: true });
      log(error);
    }
  }

}