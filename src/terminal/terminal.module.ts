import { Module } from '@nestjs/common';
import { SshTerminalService } from './ssh-terminal.service';

@Module({
  providers: [SshTerminalService],
  exports: [SshTerminalService],
})
export class TerminalModule {}
