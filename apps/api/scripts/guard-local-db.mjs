// Refuses to continue unless DATABASE_URL points at a database on this computer. Runs before
// `db:reset` (which wipes whatever DATABASE_URL names and has no guard of its own), so a wrong
// .env can never wipe a shared or production database. Prints the host and database name only,
// never the URL (it holds the password).
//
// Usage: node scripts/guard-local-db.mjs   (DATABASE_URL and NODE_ENV from the environment)

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function refuse(reason) {
  console.error(
    `Refusing to reset: ${reason} db:reset only runs against a local development database.`,
  );
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) refuse('DATABASE_URL is not set.');
let parsed;
try {
  parsed = new URL(url);
} catch {
  refuse('DATABASE_URL is not a valid URL.');
}
if (process.env.NODE_ENV === 'production') refuse('NODE_ENV is production.');
if (!LOCAL_HOSTS.has(parsed.hostname)) {
  refuse(`the database host "${parsed.hostname}" is not this computer.`);
}
console.log(
  `Local database "${parsed.pathname.replace(/^\//, '')}" on ${parsed.hostname}: reset allowed.`,
);
