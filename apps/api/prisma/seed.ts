/**
 * Demo seed entry point. Run it with `pnpm db:seed` (repo root) or
 * `pnpm --filter @ops/api db:seed`; do not run this file on its own.
 *
 * The data and the logic live in `src/operations/seed/demo-seed.ts`, which creates everything
 * through the real domain services inside a Nest application context. Those services rely on
 * decorator metadata, which tsx (esbuild) does not emit, so the `db:seed` script first compiles
 * `src` with tsc into `node_modules/.cache/ops-seed` and this file loads the compiled output.
 * A separate folder is used so a running `pnpm dev` (which owns `dist/`) is not disturbed.
 *
 * Idempotent: when the demo organization already exists, nothing is changed.
 */
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFactory as NestFactoryType } from '@nestjs/core';
import type { DemoSeedResult } from '../src/operations/seed/demo-seed';

const COMPILED = join(__dirname, '..', 'node_modules', '.cache', 'ops-seed');

interface CompiledSeed {
  seedDemo(app: INestApplicationContext): Promise<DemoSeedResult>;
  DEMO_ORGANIZATION: { name: string; slug: string };
}

function load<Module>(...path: string[]): Module {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- compiled CommonJS output, see above
  return require(join(COMPILED, ...path)) as Module;
}

async function main(): Promise<void> {
  if (!existsSync(join(COMPILED, 'app.module.js'))) {
    throw new Error('The compiled seed is missing. Run it through `pnpm db:seed`.');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Run it through `pnpm db:seed`, which loads .env.');
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports -- must be the same copy the compiled code uses
  const { NestFactory } = require('@nestjs/core') as { NestFactory: typeof NestFactoryType };
  const { AppModule } = load<{ AppModule: object }>('app.module.js');
  const { seedDemo, DEMO_ORGANIZATION } = load<CompiledSeed>('operations', 'seed', 'demo-seed.js');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const result = await seedDemo(app);
    if (!result.seeded) {
      console.log(
        `Organization "${DEMO_ORGANIZATION.slug}" already exists (${result.organizationId}). ` +
          'Nothing was changed. If an earlier seed run stopped halfway, the data is incomplete: ' +
          'use `pnpm db:reset` to start again from an empty database.',
      );
      return;
    }

    console.log(`Seeded organization "${DEMO_ORGANIZATION.name}" (${result.organizationId}).`);
    console.log(
      Object.entries(result.counts)
        .map(([name, count]) => `${count} ${name}`)
        .join(', '),
    );
    console.log('\nUsers (sign in with any of the identifiers shown):');
    for (const user of result.users) {
      console.log(`  ${user.name.padEnd(14)}  ${user.roles}\n      ${user.identifiers}`);
    }
    // Never print a password: only say where they are defined.
    console.log(
      result.passwordsSet
        ? '\nDevelopment passwords: one per role, in DEV_PASSWORDS in ' +
            'src/operations/seed/demo-seed.ts (not printed).'
        : '\nNo passwords were set (production): issue activation codes with ' +
            'POST /users/:id/activation-code.',
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
