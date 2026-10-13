import path from 'node:path';
import type { NextConfig } from 'next';

// The monorepo root (where pnpm-lock.yaml lives). Setting it explicitly stops
// Next.js from guessing the workspace root.
const monorepoRoot = path.join(__dirname, '..', '..');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Project documentation is maintained by hand; stop `next dev` from
  // generating an AGENTS.md file in this folder.
  agentRules: false,
  outputFileTracingRoot: monorepoRoot,
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
