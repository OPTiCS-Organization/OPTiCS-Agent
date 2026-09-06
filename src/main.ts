import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import log from 'spectra-log';
import { installProcessGuards } from './utility/processGuard.util';

async function bootstrap() {
  installProcessGuards();

  const app = await NestFactory.create(AppModule);

  log.setDebugLevel('INFO');
  log.setDisplayStandBy(false);

  app.useGlobalPipes(new ValidationPipe());
  app.enableVersioning({ type: VersioningType.URI });

  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? '*',
    credentials: true,
  });

  await app.listen(process.env.PORT ?? 3001);
}

bootstrap().catch((error: unknown) => {
  log(`[Process] {{ red : bold : BOOTSTRAP_FAILED }}\n  ${error instanceof Error ? error.message : String(error)}`, 500, 'ERROR');
  process.exit(1);
});
