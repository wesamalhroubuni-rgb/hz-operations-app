// Runs the Next.js CLI with the port taken from WEB_PORT.
//
// The root .env (loaded by dotenv-cli in the package scripts) names the port
// WEB_PORT, while Next.js reads PORT. npm scripts cannot expand "$WEB_PORT"
// portably (it fails on Windows), so this launcher maps one to the other.
//
// Usage: node scripts/next.mjs <dev|build|start> [...next args]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nextBin = require.resolve('next/dist/bin/next');

const env = { ...process.env };
if (env.WEB_PORT) {
  env.PORT = env.WEB_PORT;
}

const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
