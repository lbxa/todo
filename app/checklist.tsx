'use client';

import dynamic from 'next/dynamic';

/*
 * Client-only on purpose.
 *
 * `seedDoc()` mints ids with `uid()` (Math.random + Date.now), so a build-time
 * render and a browser render can never agree on React keys. Zustand's usual
 * Next.js remedy (skipHydration + a manual rehydrate) does not help, because
 * the mismatch is in the seeded ids rather than in the storage read.
 *
 * Rendering client-side only reproduces what the previous build did — an empty
 * root that React fills in the browser — and needs no change to the storage
 * layer. theme.css styles `body`, so the correct background paints from CSS
 * before JS arrives.
 */
export default dynamic(() => import('../src/app.js'), { ssr: false });
