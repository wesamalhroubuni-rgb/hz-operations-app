import { applyMigrations, ensureTestDatabase, redirectDatabaseUrl } from './test-database';

/**
 * Runs once before the integration suite: checks that the target is a safe test database,
 * creates it when missing and brings its schema up to date. No data is written here.
 */
export default async function globalSetup(): Promise<void> {
  const target = redirectDatabaseUrl();
  const created = await ensureTestDatabase(target);
  applyMigrations(target);
  if (created) {
    console.log(`\nCreated the test database "${target.database}" and applied the migrations.`);
  }
}
