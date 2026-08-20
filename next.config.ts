import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // PGlite ships a WASM build that must not be bundled.
  serverExternalPackages: [
    '@electric-sql/pglite',
    '@electric-sql/pglite-pgvector',
    '@huggingface/transformers',
  ],
  typedRoutes: true,
};

export default nextConfig;
