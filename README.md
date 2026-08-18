# Checklist

Nestable, editable lists that live in your browser. An installable PWA, built
as a static Next.js export and served from Cloudflare Workers.

## Commands

```bash
bun install          # install dependencies
bun run dev          # dev server on :3000
bun run build        # static export to ./out, then generate the service worker
bun run test         # build, then run the regression suite
bun run preview      # build, then serve ./out through Wrangler locally
bun run deploy       # build, then deploy to Cloudflare
bun run icons        # regenerate public/icons/ and app/icon.svg
bun run og           # regenerate app/opengraph-image.png
```

First run only: `bunx playwright install chromium`.

## Deploying

`wrangler.jsonc` publishes `./out` as static assets with no Worker script,
since the app has no server-side code, and binds the custom domain
`todo.lbxa.net`. Run `bun run deploy` once `wrangler` is authenticated
(`bunx wrangler login`).

That origin is also baked into the OpenGraph tags at build time, so link
previews resolve. Set `NEXT_PUBLIC_SITE_URL` only to override it for a preview
deployment on another origin (see `.env.example`).

## Layout

```
app/       Next.js shell — layout, page, client boundary, manifest, PWA glue
src/       the product: app.js (the checklist) and theme.css (Tailwind tokens)
scripts/   icon, share-card and service-worker generators
tests/     Playwright regression suite, run by `bun test`
public/    generated PWA icons
```

`src/` is the application itself and is deliberately left as plain JavaScript —
it uses `htm` tagged templates rather than JSX, so it needs no compile step of
its own. `theme.css` scans it via `@source "./app.js"`; that relative path is
why both files stay in `src/` together.

## Things worth knowing before changing anything

**The checklist is rendered client-only** (`app/checklist.tsx`), and that is
load-bearing rather than lazy. `seedDoc()` mints ids with `Math.random()`, so a
build-time render and a browser render can never agree on React keys. Zustand's
usual Next.js remedy — `skipHydration` plus a manual `rehydrate()` — does not
help here, because the mismatch is in the seeded ids rather than in the storage
read. Rendering client-side only sidesteps it and needs no change to the
storage layer.

**The service worker's precache list is generated, never hand-written.** Next
emits content-hashed filenames that change every build, so `scripts/generate-sw.mjs`
walks `./out` after each build and embeds a content hash in the cache name. That
hash is what makes each deploy produce a byte-different `sw.js`, which is what
tells the browser to install the new version.

**The test suite maps end/start-of-line per platform.** `End` and `Home` are
OS-defined: on macOS they scroll the document instead of moving the caret. The
`LINE_END`/`LINE_START` constants in `tests/checklist.test.ts` keep the suite
working on both macOS and Linux CI.

**Icons and the share card are generated, not hand-drawn.** Both derive their
geometry and colours from `scripts/icon.mjs`, which reuses the theme tokens, so
the icon cannot drift away from the app's own tick mark. They render through the
Playwright Chromium the tests already depend on, so there is no image toolchain.

## Storage and offline

State persists to `localStorage` under `sydney-nyc-checklist`. The adapter in
`src/app.js` feature-probes storage and falls back to an in-memory map when it
is unavailable (private mode, sandboxed iframes), so the app never throws — it
just stops persisting.

The service worker precaches the whole export, so the installed app opens and
edits with no network at all. Navigations are stale-while-revalidate, so a
deploy is picked up on the next load rather than requiring a hard refresh.
