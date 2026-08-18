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

  // socket.io로 JSON 역직렬화되어 들어오므로 문자열만 성립한다.
  // (브라우저 전역 타입인 BodyInit은 Node 런타임에 존재하지 않는다)
  @IsOptional()
  @IsString()
  body?: string | null;
}