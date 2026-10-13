import { defineConfig } from 'prisma/config';

// DATABASE_URL comes from the root .env, loaded by dotenv-cli in the package scripts
// (db:migrate, db:studio). `prisma generate` does not need a database, so the URL is
// only attached when it is present; that keeps `pnpm install` working on a fresh clone.
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
