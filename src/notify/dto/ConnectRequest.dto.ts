import { IsDate, IsNotEmpty, IsNumber, IsString } from "class-validator";
import { Type } from "class-transformer";

export class ConnectRequest {
  @IsNotEmpty()
  @IsString()
  workspaceOwnerName: string;

  @IsNotEmpty()
  @IsString()
  workspaceName: string;

  @IsNotEmpty()
  @IsString()
  workspaceCreatedAt: string;

  @IsNotEmpty()
  @IsNumber()
  workspaceIndex: number;

  @IsNotEmpty()
  @Type(() => Date)
  @IsDate()
  requestDatetime: Date;
}