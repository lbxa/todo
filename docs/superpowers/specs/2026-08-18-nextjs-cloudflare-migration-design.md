# Migrating the checklist to Bun + Next.js on Cloudflare

**Date:** 2026-08-18
**Status:** Approved design, pending implementation plan

## Goal

Turn the pasted-in single-file checklist app into a production-ready Bun +
Next.js application deployed to Cloudflare, without changing product behaviour.

## Starting point

`src/app.js` (1281 lines) is a nested editable checklist, layered as
storage → model → store → bindings → view. It has no build step: it uses `htm`
tagged templates bound to `React.createElement` rather than JSX, and reads
React, ReactDOM, Zustand and htm off the window as UMD globals. State lives in a
Zustand vanilla store with `persist` writing to localStorage under
`sydney-nyc-checklist`. It is entirely client-side — no server, no fetch, no API.

`build.py` compiled Tailwind v4 over `src/theme.css` and inlined the CSS plus
five UMD bundles into one offline HTML file. It is superseded by this migration
and is being deleted; the offline `file://` capability is explicitly dropped.

## Constraint

**The product is not to be modified.** Interpreted as: `src/app.js` changes only
in its module preamble and its final mount line. All model, store, storage and
view logic — and every `htm` template — stays byte-for-byte identical.

## Decisions

### 1. ESM preamble swap, not a JSX rewrite

The UMD globals are the only genuine incompatibility with a bundler, which needs
`import` statements to resolve dependencies. Replacing the ~6 lines of global
destructuring with real imports is the minimum change that lets Next.js do its
job. Converting `htm` templates to JSX was rejected: it rewrites ~1270 lines and
puts the uncontrolled-contenteditable and caret handling at regression risk.

### 2. Static export on Cloudflare Workers

The app has no server-side behaviour, so `output: 'export'` emits plain
HTML/CSS/JS served by Workers static assets. No runtime, no cold start, free
tier. OpenNext was rejected as machinery for capabilities the app does not use;
switching to it later is a config change, not a rewrite.

### 3. Browser storage via client-only rendering

Persistence stays on the browser storage API exactly as written. The existing
`createSafeStorage` adapter already follows best practice — it feature-probes
localStorage, degrades to an in-memory `Map` rather than throwing in private mode
or a sandboxed iframe, and coalesces write bursts into one write per ~200ms. It
is not modified.

The Next.js-specific problem is hydration, not storage. With `output: 'export'`,
client components are still rendered at build time to produce static HTML. The
usual Zustand-on-Next.js remedy (`skipHydration: true` plus a manual
`rehydrate()` in an effect) **cannot work here**: `seedDoc()` generates ids via
`uid()` (`Math.random()` + `Date.now()`), so a build-time render and a browser
render produce different React keys regardless of how the storage read is
sequenced.

The component is therefore mounted client-only with
`dynamic(() => import('../src/app.js'), { ssr: false })`. This is the standard
pattern for local-first apps whose entire state lives in the browser, it
reproduces exactly what the single-file build did (an empty `#root` filled by
React in the browser), and it requires zero edits to the storage layer.

Because `theme.css` styles `body` directly, the correct background paints from
CSS before JS loads, so the pre-hydration frame is a clean empty page.

### 4. `bun test` as the test runner

`test.mjs`'s ~20 assertions are preserved verbatim; only the harness changes,
from a hand-rolled `ok(name, cond)` counter to `describe`/`test`/`expect` from
`bun:test`, with Playwright driving its managed Chromium. Hardcoded values
(`file:///home/claude/...`, `/opt/pw-browsers/...`) are removed.

Accepted tradeoff: Playwright's own runner offers trace viewer, auto-retries and
parallel workers, which `bun test` does not. Worth it for a conventional project
shape at this suite size.

Because the suite asserts on `data-t` hooks rather than styling, a green run is
the evidence that the ESM port changed no behaviour.

## Target layout

Product files stay in `src/` so that `@source "./app.js"` in `theme.css` — a
relative path Tailwind uses for static class scanning — keeps resolving.

```
app/
  layout.tsx          <html lang="en" data-theme="lights-out">, imports ../src/theme.css
  page.tsx            server component, renders the client shell
  checklist.tsx       'use client' + dynamic(..., { ssr: false })
src/
  app.js              THE PRODUCT — preamble and final line only
  theme.css           untouched
tests/
  checklist.test.ts   bun test + playwright
next.config.ts        output: 'export'
wrangler.jsonc        static assets → ./out
postcss.config.mjs    @tailwindcss/postcss
tsconfig.json         allowJs for src/app.js
```

The Next.js shell uses no Tailwind classes, so `@source "./app.js"` remains
sufficient and `theme.css` needs no edit. `layout.tsx` reproduces `build.py`'s
shell: `data-theme="lights-out"` on `<html>` (overridden at runtime by the
existing effect that sets `document.documentElement.dataset.theme`) and the
title "Sydney to New York".

## Diff to the product

Top of `src/app.js`, below the existing architecture comment:

```js
'use client';
import React, { useSyncExternalStore, useRef, useEffect, useLayoutEffect,
                useState, useCallback, useMemo, memo, Fragment } from 'react';
import { createStore } from 'zustand/vanilla';
import { persist, createJSONStorage } from 'zustand/middleware';
import htmModule from 'htm';
const html = htmModule.bind(React.createElement);
```

Bottom: `ReactDOM.createRoot(...).render(...)` becomes `export default App;`.

## Scripts

Bun is package manager and script runner: `bun install`, `bun run dev`,
`bun run build`, `bun test`, `bun run deploy`.

## Dead code removed

- `build.py` — superseded by `next build`
- `src/styles.css` — unreferenced, and its tokens (`--bg`, `--text`) belong to an
  earlier design pass that does not match the app's (`--color-canvas`, `--color-ink`)
- `test.mjs` — replaced by `tests/checklist.test.ts`

## Risk

React 19 is the main one: `app.js` drives an uncontrolled contenteditable and
sets the caret by hand, the kind of code React version bumps disturb. The ported
suite has explicit caret-order assertions to catch it. Fallback is Next.js 14 +
React 18, which the code was written against.

Zustand is low-risk: the app uses only `zustand/vanilla` and `zustand/middleware`
and builds its own `useStore` from `useSyncExternalStore`, so it never touches
Zustand's React bindings.

Versions are pinned at install time against the registry rather than assumed.

## Success criteria

1. `bun run dev` serves the checklist, behaving as the single-file build did.
2. `bun test` passes every ported assertion.
3. `bun run build` produces a static `./out` with no hydration errors in console.
4. `bun run deploy` publishes to Cloudflare and the deployed app persists state
   across reloads.
5. `git diff` on `src/app.js` shows only the preamble and the final line.
