import type { NextConfig } from 'next';

// Static export: the product ships as files, with no server runtime to trust.

/**
 * Fully static export — no server, no SSR, everything client-side by design
 * (the prover runs in a Web Worker in the visitor's browser).
 *
 * BASE_PATH handles subpath hosting:
 *   GitHub Pages project site: BASE_PATH=/witness-list  (set in .github/workflows/ci.yml)
 *   GitLab Pages project site: BASE_PATH=/$CI_PROJECT_NAME  (set in .gitlab-ci.yml)
 *   Custom domain / root deploys: leave unset.
 * Shareable state (circuit + proof) lives in the URL hash, which is basePath-agnostic.
 */
const basePath = process.env.BASE_PATH ?? '';

const nextConfig: NextConfig = {
  output: 'export',
  basePath,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;
