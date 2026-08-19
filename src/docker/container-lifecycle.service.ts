import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DEPLOY_OPTION } from "src/global/DeployOptionEnum";
import { BuildWorkspaceService } from "./build-workspace.service";
import Docker from 'dockerode';
import path from "path";
import log from "spectra-log";
import { DockerCli } from "./docker-cli.service";
import { createServiceLogEmitter, createServiceStatusEmitter } from "./utility/emitters";
import { HubEmit } from "./types/HubEmit.type";
import { ServiceStatus } from "./types/ServiceStatus.type";

@Injectable()
export class ContainerLifeCycleService {
  private docker: Docker;
  private buildRoot: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly buildWorkspaceService: BuildWorkspaceService,
    private readonly dockerCli: DockerCli,
  ) {
    this.buildRoot = configService.get<string>('OPTICS_BUILD_DIR') ?? path.join(process.cwd(), 'dist/build');
    this.docker = new Docker({
      socketPath: '/var/run/docker.sock'
    })
  }

  async stopService(
    serviceIndex: number,
    serviceName: string,
    deployPreset: DEPLOY_OPTION,
    emit: HubEmit,
  ) {
    const { sendLog } = createServiceLogEmitter(emit, { serviceIndex, containerName: serviceName, stream: 'lifecycle' })
    const { sendStatus } = createServiceStatusEmitter(emit, { serviceIndex });
    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;

    try {
      sendLog(`Stopping service '${serviceName}'...`);
      if (isCompose) {
        await this.dockerCli.run(['compose', '-p', serviceName, 'stop'], {
          label: 'docker compose stop',
          onLine: sendLog,
        });
      } else {
        await this.docker.getContainer(serviceName).stop();
      }
      sendStatus(ServiceStatus.STOPPED);
      sendLog(`Service '${serviceName}' stopped successfully.`);
      log(`[DockerService] stopService success | name=${serviceName}`);
    } catch (e) {
      sendStatus('failed');
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] stopService failed | name=${serviceName} | ${String(e)}`);
    }
  }

  async startContainer(
    serviceIndex: number,
    containerName: string,
    _deployPreset: DEPLOY_OPTION,
    emit: HubEmit,
  ) {
    const { sendLog } = createServiceLogEmitter(emit, { serviceIndex, containerName, stream: 'lifecycle' });

    try {
      sendLog(`Starting container '${containerName}'...`);
      await this.docker.getContainer(containerName).start();
      sendLog(`Container '${containerName}' started successfully.`);
      log(`[DockerService] startContainer success | name=${containerName}`);
    } catch (e) {
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] startContainer failed | name=${containerName} | ${String(e)}`);
    }
  }

  async stopContainer(
    serviceIndex: number,
    containerName: string,
    _deployPreset: DEPLOY_OPTION,
    emit: HubEmit,
  ) {
    const { sendLog } = createServiceLogEmitter(emit, { serviceIndex, containerName, stream: 'lifecycle' });

    try {
      sendLog(`Stopping container '${containerName}'...`);
      await this.docker.getContainer(containerName).stop();
      sendLog(`Container '${containerName}' stopped successfully.`);
      log(`[DockerService] stopContainer success | name=${containerName}`);
    } catch (e) {
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] stopContainer failed | name=${containerName} | ${String(e)}`);
    }
  }

  async restartService(
    serviceIndex: number,
    serviceName: string,
    deployPreset: DEPLOY_OPTION,
    emit: HubEmit,
  ) {
    const si = serviceName.toLowerCase();
    const { sendLog } = createServiceLogEmitter(emit, { serviceIndex, containerName: si, stream: 'lifecycle' });
    const { sendStatus } = createServiceStatusEmitter(emit, { serviceIndex });
    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;

    try {
      sendStatus(ServiceStatus.RESTARTING);
      sendLog(`Restarting service '${si}'...`);
      if (isCompose) {
        await this.dockerCli.run(['compose', '-p', si, 'restart'], {
          label: 'docker compose restart',
          onLine: sendLog,
        });
      } else {
        await this.docker.getContainer(si).restart();
      }
      sendStatus(ServiceStatus.RUNNING);
      sendLog(`Service '${si}' restarted successfully.`);
      log(`[DockerService] restartService success | name=${si}`);
    } catch (e) {
      sendStatus(ServiceStatus.FAILED);
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] restartService failed | name=${si} | ${String(e)}`);
    }
  }

  async restartContainer(
    serviceIndex: number,
    containerName: string,
    _deployPreset: DEPLOY_OPTION,
    emit: HubEmit,
  ) {
    const { sendLog } = createServiceLogEmitter(emit, { serviceIndex, containerName, stream: 'lifecycle' });

    try {
      sendLog(`Restarting container '${containerName}'...`);
      await this.docker.getContainer(containerName).restart();
      sendLog(`Container '${containerName}' restarted successfully.`);
      log(`[DockerService] restartContainer success | name=${containerName}`);
    } catch (e) {
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] restartContainer failed | name=${containerName} | ${String(e)}`);
    }
  }

  async deleteService(
    serviceIndex: number,
    serviceName: string,
    deployPreset: DEPLOY_OPTION,
    deleteScope: 'containers' | 'service',
    emit: HubEmit,
  ) {
    const si = serviceName.toLowerCase();
    const { sendLog } = createServiceLogEmitter(emit, { serviceIndex, containerName: si, stream: 'lifecycle' });
    const { sendStatus } = createServiceStatusEmitter(emit, { serviceIndex });
    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;

    try {
      sendLog(`Deleting service '${si}'...`);
      if (isCompose) {
        const args = deleteScope === 'service'
          ? ['compose', '-p', si, 'down', '--rmi', 'all', '--volumes']
          : ['compose', '-p', si, 'down'];
        await this.dockerCli.run(args, {
          label: 'docker compose down',
          onLine: sendLog,
        });
      } else {
        const container = this.docker.getContainer(si);
        const info = await container.inspect() as { State: { Running: boolean } };
        if (info.State.Running) {
          sendLog(`Stopping container '${si}'...`);
          await container.stop();
        }
        await container.remove();
        sendLog(`Container '${si}' removed.`);
        if (deleteScope === 'service') {
          try {
            await this.docker.getImage(si).remove();
            sendLog(`Image '${si}' removed.`);
          } catch {
            sendLog(`No image found for '${si}', skipping.`);
          }
        }
      }
      if (deleteScope === 'service') {
        this.buildWorkspaceService.removeBuildDir(path.join(this.buildRoot, si), sendLog);
      }
      sendStatus(ServiceStatus.REMOVED);
      sendLog(`Service '${si}' deleted successfully.`);
      log(`[DockerService] deleteService success | name=${si}`);
    } catch (e) {
      sendStatus(ServiceStatus.FAILED);
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] deleteService failed | name=${si} | ${String(e)}`);
    }
  }
}
