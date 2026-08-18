# Sydney to New York

An editable, nestable checklist. Static Next.js app on Cloudflare Workers.

## Commands

```bash
bun install          # install dependencies
bun run dev          # dev server on :3000
bun run build        # static export to ./out
bun run test         # build, then run the regression suite
bun run preview      # build, then serve ./out through Wrangler locally
bun run deploy       # build, then deploy to Cloudflare
```

First run only: `bunx playwright install chromium`.

## Layout

```
app/       Next.js shell — layout, page, client boundary
src/       the product: app.js (the checklist) and theme.css (Tailwind tokens)
tests/     Playwright regression suite, run by `bun test`
```

`src/` is the application itself and is deliberately left as plain JavaScript —
it uses `htm` tagged templates rather than JSX, so it needs no compile step of
its own. `theme.css` scans it via `@source "./app.js"`; that relative path is
why both files stay in `src/` together.

## Two things worth knowing before changing anything

**The checklist is rendered client-only** (`app/checklist.tsx`), and that is
load-bearing rather than lazy. `seedDoc()` mints ids with `Math.random()`, so a
build-time render and a browser render can never agree on React keys. Zustand's
usual Next.js remedy — `skipHydration` plus a manual `rehydrate()` — does not
help here, because the mismatch is in the seeded ids rather than in the storage
read. Rendering client-side only sidesteps it and needs no change to the
storage layer.

**The test suite maps end/start-of-line per platform.** `End` and `Home` are
OS-defined: on macOS they scroll the document instead of moving the caret. The
`LINE_END`/`LINE_START` constants in `tests/checklist.test.ts` keep the suite
working on both macOS and Linux CI.

## Storage

State persists to `localStorage` under `sydney-nyc-checklist`. The adapter in
`src/app.js` feature-probes storage and falls back to an in-memory map when it
is unavailable (private mode, sandboxed iframes), so the app never throws — it
just stops persisting.

## Deploying

`wrangler.jsonc` publishes `./out` as static assets with no Worker script,
since the app has no server-side code. Run `bun run deploy` once `wrangler` is
authenticated (`bunx wrangler login`).
