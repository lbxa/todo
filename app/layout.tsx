import type { Metadata, Viewport } from 'next';
import '../src/theme.css';
import Pwa from './pwa';

// Link previews need absolute URLs baked in at build time. Override with
// NEXT_PUBLIC_SITE_URL for preview deployments on another origin.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://todo.lbxa.net';

const TITLE = 'Checklist';
const DESCRIPTION = 'Nestable lists that live in your browser.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: TITLE,
  manifest: '/manifest.webmanifest',
  icons: {
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    title: TITLE,
    statusBarStyle: 'black-translucent',
  },
  openGraph: {
    type: 'website',
    siteName: TITLE,
    title: TITLE,
    description: DESCRIPTION,
    url: '/',
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Keeps the standalone status bar flush with the page instead of letting the
  // browser paint its own chrome colour.
  themeColor: '#000000',
  // The app fills the display and manages its own scrolling; without this the
  // installed PWA leaves unpainted bars above and below on notched devices.
  viewportFit: 'cover',
};

// `data-theme` seeds the token block in theme.css. The app overwrites it on
// mount from persisted state, exactly as the previous single-file build did.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="lights-out">
      <body>
        {children}
        <Pwa />
      </body>
    </html>
  );
}
