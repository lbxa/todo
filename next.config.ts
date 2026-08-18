import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The app is entirely client-side, so there is no server to run:
  // emit a plain static bundle for Cloudflare Workers assets.
  output: 'export',
  images: { unoptimized: true },
};

export default nextConfig;
