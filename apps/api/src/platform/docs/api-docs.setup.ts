/**
 * OpenAPI document and Swagger UI (reusable platform component).
 *
 * Host requirements: `@nestjs/swagger`, and a host that decides when to call `setupApiDocs`
 * (the API calls it only when NODE_ENV is `development`). The routes are registered directly on
 * the HTTP adapter, so no guard applies to them and they need no acting user.
 */
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/** Names of the OpenAPI security schemes. */
export const BEARER_SECURITY_SCHEME = 'bearer';
export const COOKIE_SECURITY_SCHEME = 'cookie';

export interface ApiDocsSetupOptions {
  title: string;
  description?: string;
  version?: string;
  /** Path of the Swagger UI, without a leading slash. Defaults to `docs`. */
  path?: string;
  /**
   * Documents `Authorization: Bearer <access token>` as a security scheme, so the "Authorize"
   * button of the UI accepts an access token. On by default.
   */
  bearerAuth?: boolean;
  /**
   * Name of the cookie that carries the access token of browser sessions. When set, cookie
   * authentication is documented next to the bearer scheme.
   */
  accessCookieName?: string;
}

export interface ApiDocsLocation {
  /** Swagger UI. */
  uiPath: string;
  /** The OpenAPI document as JSON. */
  jsonPath: string;
  /** The OpenAPI document as YAML. */
  yamlPath: string;
}

export function buildApiDocument(
  app: INestApplication,
  options: ApiDocsSetupOptions,
): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setTitle(options.title)
    .setDescription(options.description ?? '')
    .setVersion(options.version ?? '0.1.0');

  if (options.bearerAuth !== false) {
    builder
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'The access token of a session started with `client: "mobile"` (POST /auth/login, ' +
            'then `tokens.accessToken`). It is valid for minutes; renew it with POST ' +
            '/auth/refresh.',
        },
        BEARER_SECURITY_SCHEME,
      )
      .addSecurityRequirements(BEARER_SECURITY_SCHEME);
  }

  if (options.accessCookieName) {
    builder
      .addCookieAuth(
        options.accessCookieName,
        {
          type: 'apiKey',
          in: 'cookie',
          name: options.accessCookieName,
          description:
            'Browser sessions (`client: "web"`): the access token travels in an httpOnly ' +
            'cookie set by POST /auth/login. Requests that change state must also send the ' +
            '`x-csrf-token` header and come from an allowed origin.',
        },
        COOKIE_SECURITY_SCHEME,
      )
      .addSecurityRequirements(COOKIE_SECURITY_SCHEME);
  }

  return SwaggerModule.createDocument(app, builder.build());
}

/** Serves Swagger UI and the OpenAPI document. Call before `app.listen`. */
export function setupApiDocs(app: INestApplication, options: ApiDocsSetupOptions): ApiDocsLocation {
  const path = (options.path ?? 'docs').replace(/^\/+|\/+$/g, '');
  SwaggerModule.setup(path, app, () => buildApiDocument(app, options), {
    jsonDocumentUrl: `${path}-json`,
    yamlDocumentUrl: `${path}-yaml`,
    customSiteTitle: options.title,
    swaggerOptions: { persistAuthorization: true },
  });
  return { uiPath: `/${path}`, jsonPath: `/${path}-json`, yamlPath: `/${path}-yaml` };
}
