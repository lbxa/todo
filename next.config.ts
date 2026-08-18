import type { NextConfig } from 'next';

// Link previews need absolute URLs baked in at build time. Warn rather than
// fail, so local builds and tests still work without any configuration.
if (!process.env.NEXT_PUBLIC_SITE_URL) {
  console.warn(
    '\n  ! NEXT_PUBLIC_SITE_URL is not set — OpenGraph URLs will point at localhost.\n' +
      '    Set it to the deployed origin before shipping (see .env.example).\n',
  );
}

const nextConfig: NextConfig = {
  // The app is entirely client-side, so there is no server to run:
  // emit a plain static bundle for Cloudflare Workers assets.
  output: 'export',
  images: { unoptimized: true },
};

export default nextConfig;
