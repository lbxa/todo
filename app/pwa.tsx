'use client';

import { useEffect } from 'react';

/**
 * Two small pieces of PWA housekeeping that belong to the shell, not the app:
 * registering the service worker, and keeping the browser/status-bar colour in
 * step with the theme the user picked.
 *
 * The colour is read back off the document rather than duplicating the theme
 * table from src/app.js, so adding a fifth theme needs no change here.
 */
export default function Pwa() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // A failed registration costs offline support, nothing else.
      });
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) return;

    const sync = () => {
      const canvas = getComputedStyle(root).getPropertyValue('--color-canvas').trim();
      if (canvas) meta.content = canvas;
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return null;
}
