import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DEPLOY_OPTION } from "src/global/DeployOptionEnum";
import { spawn } from "child_process";
import { subprocessEnv } from "./utility/docker-cli";
import { BuildWorkspaceService } from "./build-workspace.service";
import Docker from 'dockerode';
import path from "path";
import log from "spectra-log";
import { emitOutputLines } from "./utility/docker-output.util";
import { createServiceLogEmitter } from "./utility/emitters";

@Injectable()
export class ContainerLifeCycleService {
  private docker: Docker;
  private buildRoot: string;

  constructor (
    private readonly configService: ConfigService,
    private readonly buildWorkspaceService: BuildWorkspaceService,
  ) {
    this.buildRoot = configService.get<string>('OPTICS_BUILD_DIR') ?? path.join(process.cwd(), 'dist/build');
    this.docker = new Docker({
      socketPath: '/var/run/docker.sock'
    })
  }

  async stopService(
    serviceName: string,
    deployPreset: DEPLOY_OPTION,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const sendLog = (line: string) => emit('service-log', {
      serviceName,
      log: line,
      timestamp: new Date().toISOString(),
      source: 'agent',
      stream: 'lifecycle',
      containerName: serviceName,
    });
    const sendStatus = (status: string) => emit('service-status', { serviceName, status });
    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;

    try {
      sendLog(`Stopping service '${serviceName}'...`);
      if (isCompose) {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', '-p', serviceName, 'stop']);
          proc.stderr.on('data', (chunk: Buffer) => emitOutputLines(chunk, sendLog));
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker compose stop exited with code ${code}`)));
        });
      } else {
        await this.docker.getContainer(serviceName).stop();
      }
      sendStatus('stopped');
      sendLog(`Service '${serviceName}' stopped successfully.`);
      log(`[DockerService] stopService success | name=${serviceName}`);
    } catch (e) {
      sendStatus('failed');
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] stopService failed | name=${serviceName} | ${String(e)}`);
    }
  }

  async startContainer(
    containerName: string,
    _deployPreset: DEPLOY_OPTION,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const sendLog = (line: string) => emit('service-log', {
      serviceName: containerName,
      log: line,
      timestamp: new Date().toISOString(),
      source: 'agent',
      stream: 'lifecycle',
      containerName,
    });

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
    containerName: string,
    _deployPreset: DEPLOY_OPTION,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const sendLog = (line: string) => emit('service-log', {
      serviceName: containerName,
      log: line,
      timestamp: new Date().toISOString(),
      source: 'agent',
      stream: 'lifecycle',
      containerName,
    });

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
    serviceName: string,
    deployPreset: DEPLOY_OPTION,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const si = serviceName.toLowerCase();
    const sendLog = (line: string) => emit('service-log', {
      serviceName,
      log: line,
      timestamp: new Date().toISOString(),
      source: 'agent',
      stream: 'lifecycle',
      containerName: si,
    });
    const sendStatus = (status: string) => emit('service-status', { serviceName, status });
    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;

    try {
      sendStatus('restarting');
      sendLog(`Restarting service '${si}'...`);
      if (isCompose) {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('docker', ['compose', '-p', si, 'restart']);
        proc.stderr.on('data', (chunk: Buffer) => emitOutputLines(chunk, sendLog));
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker compose restart exited with code ${code}`)));
        });
      } else {
        await this.docker.getContainer(si).restart();
      }
      sendStatus('running');
      sendLog(`Service '${si}' restarted successfully.`);
      log(`[DockerService] restartService success | name=${si}`);
    } catch (e) {
      sendStatus('failed');
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] restartService failed | name=${si} | ${String(e)}`);
    }
  }

  async restartContainer(
    containerName: string,
    _deployPreset: DEPLOY_OPTION,
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const sendLog = (line: string) => emit('service-log', {
      serviceName: containerName,
      log: line,
      timestamp: new Date().toISOString(),
      source: 'agent',
      stream: 'lifecycle',
      containerName,
    });

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
    serviceName: string,
    deployPreset: DEPLOY_OPTION,
    deleteScope: 'containers' | 'service',
    emit: (event: 'service-status' | 'service-log', payload: object) => void,
  ) {
    const si = serviceName.toLowerCase();
    const sendLog = (line: string) => emit('service-log', {
      serviceName,
      log: line,
      timestamp: new Date().toISOString(),
      source: 'agent',
      stream: 'lifecycle',
      containerName: si,
    });
    const sendStatus = (status: string) => emit('service-status', { serviceName, status });
    const isCompose = (deployPreset.toUpperCase() as DEPLOY_OPTION) !== DEPLOY_OPTION.DOCKERFILE;

    try {
      sendLog(`Deleting service '${si}'...`);
      if (isCompose) {
        await new Promise<void>((resolve, reject) => {
          const args = deleteScope === 'service'
            ? ['compose', '-p', si, 'down', '--rmi', 'all', '--volumes']
            : ['compose', '-p', si, 'down'];
          const proc = spawn('docker', args, { env: subprocessEnv() });
          proc.stdout.on('data', (chunk: Buffer) => emitOutputLines(chunk, sendLog));
          proc.stderr.on('data', (chunk: Buffer) => emitOutputLines(chunk, sendLog));
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker compose down exited with code ${code}`)));
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
      sendStatus('removed');
      sendLog(`Service '${si}' deleted successfully.`);
      log(`[DockerService] deleteService success | name=${si}`);
    } catch (e) {
      sendStatus('failed');
      sendLog(`ERROR: ${String(e)}`);
      log(`[DockerService] deleteService failed | name=${si} | ${String(e)}`);
    }
  }
}
