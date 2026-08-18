import type { MetadataRoute } from 'next';

// Required by `output: 'export'`: the manifest is a Route Handler, and a
// static export has no server to evaluate it at request time.
export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Checklist',
    short_name: 'Checklist',
    description: 'Nestable lists that live in your browser.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    // The Lights-out theme, which is what the app renders before its stored
    // theme is applied. app/pwa.tsx keeps theme-color in sync after that.
    background_color: '#000000',
    theme_color: '#000000',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
