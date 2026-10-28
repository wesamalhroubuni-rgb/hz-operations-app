import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  AUTH_ACCESS_COOKIE,
  CLIENT_SYNC_HEADER,
  CSRF_HEADER,
  DEVICE_TIME_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  REQUEST_ID_HEADER,
} from '@ops/shared';
import { AppModule } from './app.module';
import { type Env, logLevelsFrom, validateEnv } from './config/env';
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
  if (env.TRUST_PROXY_HOPS > 0) {
    // Read the client address from X-Forwarded-For, trusting exactly this many proxies.
    app.getHttpAdapter().getInstance().set('trust proxy', env.TRUST_PROXY_HOPS);
  }

  // First in the chain, ahead of the body parser, so even a request with a malformed body gets
  // a correlation id and a log line. PlatformModule installs it again after the body parser.
  app.use(createRequestContextMiddleware());

  // Only the configured origins may call from a browser, and only they may send the session
  // cookies (`credentials`). The same list is the allow-list of the CSRF Origin check.
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Authorization',
      CSRF_HEADER,
      REQUEST_ID_HEADER,
      IDEMPOTENCY_KEY_HEADER,
      CLIENT_SYNC_HEADER,
      DEVICE_TIME_HEADER,
    ],
    exposedHeaders: [REQUEST_ID_HEADER, 'Retry-After', IDEMPOTENT_REPLAYED_HEADER],
    maxAge: 600,
  });
  app.enableShutdownHooks();

  // API documentation is a development tool: it is not served in any other environment.
  let docsPath: string | null = null;
  if (env.NODE_ENV === 'development') {
    docsPath = setupApiDocs(app, {
      title: 'Operations API',
      description:
        'REST API of the Operations App. Every error answers with the standard error body; ' +
        `every response carries the ${REQUEST_ID_HEADER} header. To call the routes from this ` +
        'page: POST /auth/login with "client": "mobile", then paste `tokens.accessToken` into ' +
        'Authorize.',
      accessCookieName: AUTH_ACCESS_COOKIE,
    }).uiPath;
  }

  await app.listen(env.API_PORT, env.API_HOST);
  logger.log(`API listening on http://${env.API_HOST}:${env.API_PORT}`);
  if (docsPath) {
    logger.log(`API docs on http://localhost:${env.API_PORT}${docsPath}`);
  }
}

void bootstrap();
