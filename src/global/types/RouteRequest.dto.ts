import { IsEnum, IsNotEmpty, IsObject, IsOptional, IsString } from "class-validator";
import { HttpMethod } from "../HttpMethod.enum";

export class RouteRequest {
  @IsEnum(HttpMethod)
  method: HttpMethod;

  @IsString()
  @IsNotEmpty()
  targetServiceName: string;

  @IsString()
  @IsNotEmpty()
  path: string;

  @IsObject()
  headers: Record<string, string>;

  @IsOptional()
  body?: any;
}