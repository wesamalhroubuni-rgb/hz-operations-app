/**
 * OpenAPI document and Swagger UI (reusable platform component).
 *
 * Host requirements: `@nestjs/swagger`, and a host that decides when to call `setupApiDocs`
 * (the API calls it only when NODE_ENV is `development`). The routes are registered directly on
 * the HTTP adapter, so no guard applies to them and they need no acting user.
 */
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/** Name of the OpenAPI security scheme for the development-only acting-user header. */
export const DEV_USER_SECURITY_SCHEME = 'dev-user';

export interface ApiDocsSetupOptions {
  title: string;
  description?: string;
  version?: string;
  /** Path of the Swagger UI, without a leading slash. Defaults to `docs`. */
  path?: string;
  /**
   * TEMPORARY (until real sign-in): name of the header that carries the acting user. When set,
   * it is documented as an apiKey scheme, so the "Authorize" button of the UI can send it.
   */
  devUserHeader?: string;
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

  if (options.devUserHeader) {
    builder
      .addApiKey(
        {
          type: 'apiKey',
          in: 'header',
          name: options.devUserHeader,
          description:
            'TEMPORARY, development only: the id (UUID) of the user to act as. ' +
            'Replaced by real sign-in.',
        },
        DEV_USER_SECURITY_SCHEME,
      )
      .addSecurityRequirements(DEV_USER_SECURITY_SCHEME);
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
