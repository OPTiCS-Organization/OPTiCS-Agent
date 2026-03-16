import { IsNotEmpty, IsString } from "class-validator";

export class StopCommand {
  @IsString()
  @IsNotEmpty()
  targetServiceName: string;
}