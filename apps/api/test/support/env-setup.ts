import { redirectDatabaseUrl } from './test-database';

// Runs in every test worker before any test file is loaded. It fails the file at once when the
// target is not a safe test database, and points DATABASE_URL at the test database so nothing
// in the worker can open the development database by accident.
redirectDatabaseUrl();
