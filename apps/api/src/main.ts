import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DEV_USER_HEADER, REQUEST_ID_HEADER } from '@ops/shared';
import { AppModule } from './app.module';
import { type Env, logLevelsFrom, validateEnv } from './config/env';
import { isDevAuthEnabled } from './platform/dev-auth/dev-auth.policy';
import { setupApiDocs } from './platform/docs/api-docs.setup';
import { createRequestContextMiddleware } from './platform/request-context/request-context.middleware';

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
  const logger = new Logger('Bootstrap');

  // Do not advertise the web framework in every response.
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  // First in the chain, ahead of the body parser, so even a request with a malformed body gets
  // a correlation id and a log line. PlatformModule installs it again after the body parser.
  app.use(createRequestContextMiddleware());

  app.enableCors({
    origin: env.CORS_ORIGINS,
    allowedHeaders: ['Content-Type', 'Accept', 'Authorization', DEV_USER_HEADER, REQUEST_ID_HEADER],
    exposedHeaders: [REQUEST_ID_HEADER],
  });
  app.enableShutdownHooks();

  // API documentation is a development tool: it is not served in any other environment.
  let docsPath: string | null = null;
  if (env.NODE_ENV === 'development') {
    const devAuth = isDevAuthEnabled({
      nodeEnv: env.NODE_ENV,
      devAuthEnabled: env.DEV_AUTH_ENABLED,
    });
    docsPath = setupApiDocs(app, {
      title: 'Operations API',
      description:
        'REST API of the Operations App. Every error answers with the standard error body; ' +
        `every response carries the ${REQUEST_ID_HEADER} header.`,
      ...(devAuth ? { devUserHeader: DEV_USER_HEADER } : {}),
    }).uiPath;
  }

  await app.listen(env.API_PORT, env.API_HOST);
  logger.log(`API listening on http://${env.API_HOST}:${env.API_PORT}`);
  if (docsPath) {
    logger.log(`API docs on http://localhost:${env.API_PORT}${docsPath}`);
  }
}

void bootstrap();
