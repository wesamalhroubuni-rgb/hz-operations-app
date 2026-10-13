import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { type Env, logLevelsFrom, validateEnv } from './config/env';

async function bootstrap(): Promise<void> {
  // Fail fast, before Nest starts, with a readable message if the environment is wrong.
  let env: Env;
  try {
    env = validateEnv(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule, {
    logger: logLevelsFrom(env.LOG_LEVEL),
  });

  app.enableCors({ origin: env.CORS_ORIGINS });
  app.enableShutdownHooks();

  await app.listen(env.API_PORT, env.API_HOST);
  new Logger('Bootstrap').log(`API listening on http://${env.API_HOST}:${env.API_PORT}`);
}

void bootstrap();
