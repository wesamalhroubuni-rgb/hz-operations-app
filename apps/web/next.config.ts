import path from 'node:path';
import type { NextConfig } from 'next';

// The monorepo root (where pnpm-lock.yaml lives). Setting it explicitly stops
// Next.js from guessing the workspace root.
const monorepoRoot = path.join(__dirname, '..', '..');

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Sent with every response. The app has a sign-in page, so it must never be framed by another
 * site (clickjacking): `frame-ancestors 'none'` is the current control and `X-Frame-Options` the
 * one older browsers understand.
 *
 * The Content-Security-Policy is deliberately limited to directives that need no nonce.
 * `script-src` and `style-src` are left out: Next.js injects inline scripts (and, in development,
 * uses `eval` for hot reload), so restricting them needs a per-request nonce from a proxy. That
 * is worth doing before production and is not done here.
 */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  // Browsers ignore this header over plain http, so it is harmless on localhost; it is still
  // left out of development to keep the dev server's responses plain.
  ...(isProduction
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
    : []),
];

/**
 * For the pages where credentials are typed or arrive in the URL. `/activate` can be opened with
 * a one-time code in its query string: `no-referrer` keeps that URL out of the Referer header of
 * anything the page requests or links to, and `no-store` keeps the page out of shared and disk
 * caches. For the same path, a later entry in `headers()` overrides an earlier one.
 */
const credentialPageHeaders = [
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Cache-Control', value: 'no-store' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Do not advertise the framework.
  poweredByHeader: false,
  // Project documentation is maintained by hand; stop `next dev` from
  // generating an AGENTS.md file in this folder.
  agentRules: false,
  outputFileTracingRoot: monorepoRoot,
  turbopack: {
    root: monorepoRoot,
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/login', headers: credentialPageHeaders },
      { source: '/activate', headers: credentialPageHeaders },
    ];
  },
};

export default nextConfig;
