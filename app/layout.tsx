import type { Metadata, Viewport } from 'next';
import '../src/theme.css';

export const metadata: Metadata = {
  title: 'Sydney to New York',
  description: 'An editable, nestable checklist.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

// `data-theme` seeds the token block in theme.css. The app overwrites it on
// mount from persisted state, exactly as the previous single-file build did.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="lights-out">
      <body>{children}</body>
    </html>
  );
}
