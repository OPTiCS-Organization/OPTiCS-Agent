import { Global, Injectable } from '@nestjs/common';
import simpleGit, { SimpleGit } from 'simple-git';
import { ConfigService } from '@nestjs/config';
import path from 'path';
import fs from 'fs';

@Global()
@Injectable()
export class GitService {
  private readonly git: SimpleGit;
  private readonly buildDir = path.join(__dirname, '../build');

  constructor (
    private readonly configService: ConfigService,
  ) {
    fs.mkdirSync(this.buildDir, { recursive: true });
    this.git = simpleGit(this.buildDir);
  }

  async clone(repoUrl: string = this.configService.getOrThrow<string>('OPTICS_SOURCE_URL'), targetDir: string) {
    return await this.git.clone(repoUrl, targetDir)
  } 
}
