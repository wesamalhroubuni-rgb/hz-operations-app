/**
 * Production bootstrap: creates the deployment's real organization and its first administrator,
 * with no demo data. Run it with `pnpm db:bootstrap` (repo root) after `db:deploy`; do not run
 * this file on its own (it loads the API compiled by the script, like the demo seed).
 *
 * Inputs come from environment variables, so nothing secret is typed into a command line that a
 * shell history keeps:
 *   BOOTSTRAP_ORG_NAME, BOOTSTRAP_ORG_SLUG, BOOTSTRAP_TIME_ZONE, BOOTSTRAP_LOCALE (optional),
 *   BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD.
 * The password is never printed or logged; remove it from the environment afterwards.
 *
 * Idempotent: when the slug exists already, nothing is changed.
 */
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFactory as NestFactoryType } from '@nestjs/core';
import type {
  BootstrapInput,
  BootstrapResult,
} from '../src/operations/seed/bootstrap-organization';

const COMPILED = join(__dirname, '..', 'node_modules', '.cache', 'ops-seed');

interface CompiledBootstrap {
  bootstrapOrganization(
    app: INestApplicationContext,
    input: BootstrapInput,
  ): Promise<BootstrapResult>;
}

function load<Module>(...path: string[]): Module {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- compiled CommonJS output, see above
  return require(join(COMPILED, ...path)) as Module;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. See the comment at the top of prisma/bootstrap.ts.`);
  }
  return value;
}

async function main(): Promise<void> {
  if (!existsSync(join(COMPILED, 'app.module.js'))) {
    throw new Error('The compiled API is missing. Run it through `pnpm db:bootstrap`.');
  }
  const input: BootstrapInput = {
    organizationName: required('BOOTSTRAP_ORG_NAME'),
    organizationSlug: required('BOOTSTRAP_ORG_SLUG'),
    timeZone: required('BOOTSTRAP_TIME_ZONE'),
    locale: (process.env.BOOTSTRAP_LOCALE?.trim() || 'en') as BootstrapInput['locale'],
    adminName: required('BOOTSTRAP_ADMIN_NAME'),
    adminEmail: required('BOOTSTRAP_ADMIN_EMAIL'),
    // Read as is (a password may start or end with a space); never printed.
    adminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
  };
  if (input.adminPassword === '') {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD is not set.');
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports -- must be the same copy the compiled code uses
  const { NestFactory } = require('@nestjs/core') as { NestFactory: typeof NestFactoryType };
  const { AppModule } = load<{ AppModule: object }>('app.module.js');
  const { bootstrapOrganization } = load<CompiledBootstrap>(
    'operations',
    'seed',
    'bootstrap-organization.js',
  );

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const result = await bootstrapOrganization(app, input);
    if (!result.created) {
      console.log(
        `Organization "${input.organizationSlug}" already exists (${result.organizationId}). Nothing was changed.`,
      );
      return;
    }
    console.log(`Created organization "${input.organizationName}" (${result.organizationId}).`);
    console.log(
      `Administrator ${input.adminEmail} (${result.adminUserId}) can sign in with the password from BOOTSTRAP_ADMIN_PASSWORD (not printed).`,
    );
    console.log(
      `Set NEXT_PUBLIC_ORGANIZATION_SLUG and EXPO_PUBLIC_ORGANIZATION_SLUG to "${input.organizationSlug}".`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  // A validation error lists fields and rules only; the password itself is never part of it.
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
