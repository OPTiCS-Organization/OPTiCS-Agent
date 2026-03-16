import { IsNotEmpty, IsString } from "class-validator";

export class DeleteCommand {
  @IsString()
  @IsNotEmpty()
  targetServiceName: string;
}