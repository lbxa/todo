/**
 * Regression suite. Selectors use data-t hooks so styling changes can't break it.
 *
 * Runs against the built static export (see tests/server.ts), which is what
 * makes hydration problems in the real deploy artefact observable.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { originOf, startServer } from './server';

/*
 * End/Home are OS-defined, not browser-defined: on macOS they scroll the
 * document rather than moving the caret, and end/start-of-line are Cmd+arrow.
 * Hard-coding End/Home silently pins the suite to Linux.
 */
const IS_MAC = process.platform === 'darwin';
const LINE_END = IS_MAC ? 'Meta+ArrowRight' : 'End';
const LINE_START = IS_MAC ? 'Meta+ArrowLeft' : 'Home';

const server = startServer();
const URL = originOf(server);

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

/** A page plus the console/page errors it emitted, matching the original harness. */
async function openPage(): Promise<{ ctx: BrowserContext; p: Page; errs: string[] }> {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errs: string[] = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text());
  });
  await p.goto(URL);
  await p.waitForTimeout(600);
  return { ctx, p, errs };
}

describe('core editing', () => {
  let ctx: BrowserContext, p: Page, errs: string[];
  let rows: ReturnType<Page['locator']>;
  const txt = (n: number) => rows.nth(n).locator('> [data-t=row] [data-t=txt]');

  beforeAll(async () => {
    ({ ctx, p, errs } = await openPage());
    rows = p.locator('section').first().locator('> ul > [data-t=node]');
  }, 30_000);

  afterAll(async () => await ctx.close());

  test('renders', async () => {
    expect(await p.locator('[data-t=node]').count()).toBeGreaterThan(80);
  });

  test('typing keeps caret order', async () => {
    await txt(0).click();
    await p.keyboard.press(LINE_END);
    await p.keyboard.type('XYZ');
    await p.waitForTimeout(80);
    expect(await txt(0).textContent()).toEndWith('XYZ');
  });

  test('Enter creates a sibling', async () => {
    const n0 = await rows.count();
    await p.keyboard.press('Enter');
    await p.waitForTimeout(80);
    expect(await rows.count()).toBe(n0 + 1);
  });

  test('new row is focused', async () => {
    await p.keyboard.type('brand new');
    await p.waitForTimeout(80);
    expect(await txt(1).textContent()).toBe('brand new');
  });

  test('Tab indents', async () => {
    await p.keyboard.press('Tab');
    await p.waitForTimeout(100);
    const last = rows.nth(0).locator('[data-t=kids] [data-t=txt]').last();
    expect(await last.textContent()).toBe('brand new');
  });

  test('depth capped at 1', async () => {
    await p.keyboard.press('Tab');
    await p.waitForTimeout(80);
    const maxDepth = await p.evaluate(() =>
      Math.max(
        ...[...document.querySelectorAll('[data-t=kids]')].map((u) => {
          let d = 0;
          let n = u.parentElement;
          while (n) {
            if ((n as HTMLElement).dataset?.t === 'kids') d++;
            n = n.parentElement;
          }
          return d + 1;
        }),
      ),
    );
    expect(maxDepth).toBe(1);
  });

  test('Shift+Tab outdents', async () => {
    await p.keyboard.press('Shift+Tab');
    await p.waitForTimeout(100);
    expect(await txt(1).textContent()).toBe('brand new');
  });

  test('Enter splits at the caret', async () => {
    await p.keyboard.press(LINE_START);
    for (let i = 0; i < 5; i++) await p.keyboard.press('ArrowRight');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(100);
    expect(await txt(1).textContent()).toBe('brand');
    expect(await txt(2).textContent()).toBe(' new');
  });

  test('Backspace merges up', async () => {
    await p.keyboard.press(LINE_START);
    await p.keyboard.press('Backspace');
    await p.waitForTimeout(100);
    expect(await txt(1).textContent()).toBe('brand new');
  });

  test('parent cascades to children', async () => {
    const parent = rows.nth(0);
    await parent.locator('> [data-t=row] .tick').click();
    await p.waitForTimeout(80);
    const ticked = await parent.locator('[data-t=kids] .tick.on').count();
    expect(ticked).toBeGreaterThan(0);
    expect(ticked).toBe(await parent.locator('[data-t=kids] [data-t=node]').count());
  });

  test('partial state shows', async () => {
    const parent = rows.nth(0);
    await parent.locator('[data-t=kids] .tick').first().click();
    await p.waitForTimeout(80);
    expect(await parent.locator('> [data-t=row] .tick.part').count()).toBe(1);
  });

  test('undo works', async () => {
    const before = await p.textContent('[data-t=count]');
    await p.keyboard.down('Control');
    await p.keyboard.press('KeyZ');
    await p.keyboard.up('Control');
    await p.waitForTimeout(120);
    expect(await p.textContent('[data-t=count]')).not.toBe(before);
  });

  test('Shift+Enter opens a description', async () => {
    await txt(1).click();
    await p.keyboard.press('Shift+Enter');
    await p.keyboard.type('a note');
    await p.waitForTimeout(100);
    expect(await rows.nth(1).locator('> [data-t=row] [data-t=note]').textContent()).toBe('a note');
  });

  test('Add item works and focuses', async () => {
    await p.locator('section').first().locator('[data-t=add]').click();
    await p.waitForTimeout(120);
    await p.keyboard.type('via add button');
    await p.waitForTimeout(80);
    const last = rows.last().locator('> [data-t=row] [data-t=txt]');
    expect(await last.textContent()).toBe('via add button');
  });

  test('Add item is visible unhovered', async () => {
    const add = p.locator('section').first().locator('[data-t=add]');
    expect(await add.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
  });

  test('persists across reload', async () => {
    await p.waitForTimeout(400);
    await p.reload();
    await p.waitForTimeout(600);
    expect(await txt(1).textContent()).toBe('brand new');
  });

  test('no console errors', () => {
    expect(errs).toEqual([]);
  });
});

describe('themes', () => {
  let ctx: BrowserContext, p: Page, errs: string[];
  const bg = () => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const seen: Array<[string | null, string]> = [];

  beforeAll(async () => {
    ({ ctx, p, errs } = await openPage());
  }, 30_000);

  afterAll(async () => await ctx.close());

  test('default theme is Lights out', async () => {
    expect(await p.getAttribute('html', 'data-theme')).toBe('lights-out');
    expect(await bg()).toBe('rgb(0, 0, 0)');
  });

  test('four themes offered', async () => {
    await p.locator('[title=More]').first().click();
    await p.waitForTimeout(200);
    expect(await p.locator('.swatch').count()).toBe(4);
  });

  test('themes are distinct', async () => {
    const sw = p.locator('.swatch');
    for (let i = 0; i < 4; i++) {
      await sw.nth(i).click();
      await p.waitForTimeout(200);
      seen.push([await p.getAttribute('html', 'data-theme'), await bg()]);
    }
    expect(new Set(seen.map((s) => s[1])).size).toBe(4);
  });

  test('theme ids as expected', () => {
    expect(seen.map((s) => s[0]).join()).toBe('lights-out,off-white,pastel,red-eye');
  });

  test('tokens follow the theme', async () => {
    // accent + text must actually re-theme, not just the background
    const [ink, accent] = await p.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return [cs.getPropertyValue('--color-ink').trim(), cs.getPropertyValue('--color-accent').trim()];
    });
    expect(ink).toBe('#efe4d6');
    expect(accent).toBe('#e9a03c');
  });

  test('theme persists', async () => {
    await p.locator('body').click({ position: { x: 5, y: 5 } });
    await p.waitForTimeout(400);
    await p.reload();
    await p.waitForTimeout(600);
    expect(await p.getAttribute('html', 'data-theme')).toBe('red-eye');
  });

  test('no errors', () => {
    expect(errs).toEqual([]);
  });
});

describe('context menu', () => {
  let ctx: BrowserContext, p: Page, errs: string[];
  let rows: ReturnType<Page['locator']>;
  let menu: ReturnType<Page['locator']>;

  beforeAll(async () => {
    ({ ctx, p, errs } = await openPage());
    rows = p.locator('section').first().locator('> ul > [data-t=node]');
    menu = p.locator('[data-t=ctx]');
  }, 30_000);

  afterAll(async () => await ctx.close());

  test('menu reopens on any row after closing', async () => {
    // opening on rows at different scroll positions (the scroll-close regression)
    for (const i of [0, 2, 4, 1]) {
      await rows.nth(i).locator('> [data-t=row]').click({ button: 'right' });
      await p.waitForTimeout(200);
      expect(await menu.count()).toBe(1);
      await p.keyboard.press('Escape');
      await p.waitForTimeout(150);
    }
  });

  test('menu offers a description action', async () => {
    await rows.nth(3).locator('> [data-t=row]').click({ button: 'right' });
    await p.waitForTimeout(200);
    const labels = (await menu.locator('button').allTextContents()).map((s) =>
      s.replace(/[⇧⌘⌥↵⇥⌫↑↓]/g, '').trim(),
    );
    expect(labels.some((l) => /description/i.test(l))).toBe(true);
  });

  test('description is editable from the menu', async () => {
    await menu.locator('button').filter({ hasText: /description/i }).first().click();
    await p.waitForTimeout(200);
    await p.keyboard.type('from the right-click menu');
    await p.waitForTimeout(120);
    const note = await rows.nth(3).locator('> [data-t=row] [data-t=note]').textContent();
    expect(note).toEndWith('from the right-click menu');
  });

  test('menu disables Indent on a sub-item, enables Outdent', async () => {
    await rows.nth(0).locator('[data-t=kids] [data-t=row]').first().click({ button: 'right' });
    await p.waitForTimeout(200);
    expect(await menu.locator('button').filter({ hasText: 'Indent' }).first().isDisabled()).toBe(true);
    expect(await menu.locator('button').filter({ hasText: 'Outdent' }).first().isEnabled()).toBe(true);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(150);
  });

  test('Delete from the menu works', async () => {
    const n = await rows.count();
    await rows.nth(2).locator('> [data-t=row]').click({ button: 'right' });
    await p.waitForTimeout(200);
    await menu.locator('button').filter({ hasText: 'Delete' }).first().click();
    await p.waitForTimeout(200);
    expect(await rows.count()).toBe(n - 1);
  });

  test('clicking away closes the menu', async () => {
    await rows.nth(2).locator('> [data-t=row]').click({ button: 'right' });
    await p.waitForTimeout(200);
    await p.mouse.click(20, 300);
    await p.waitForTimeout(200);
    expect(await menu.count()).toBe(0);
  });

  test('no errors', () => {
    expect(errs).toEqual([]);
  });
});

describe('pwa', () => {
  let ctx: BrowserContext, p: Page, errs: string[];

  beforeAll(async () => {
    ({ ctx, p, errs } = await openPage());
  }, 30_000);

  afterAll(async () => await ctx.close());

  test('manifest is served and installable', async () => {
    const res = await p.request.get(`${URL}/manifest.webmanifest`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('manifest+json');

    const m = await res.json();
    expect(m.name).toBe('Checklist');
    expect(m.short_name).toBe('Checklist');
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');

    // Installability needs both a 192 and a 512, plus a maskable variant so
    // Android crops to its own shape instead of adding a white backdrop.
    const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(m.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true);
  });

  test('every declared icon resolves at its stated size', async () => {
    const m = await (await p.request.get(`${URL}/manifest.webmanifest`)).json();
    const declared: Array<{ src: string; sizes: string }> = m.icons;

    for (const { src, sizes } of [...declared, { src: '/icons/apple-touch-icon.png', sizes: '180x180' }]) {
      const [w, h] = sizes.split('x').map(Number);
      const actual = await p.evaluate(
        (url) =>
          new Promise<[number, number]>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
            img.onerror = () => reject(new Error(`failed to load ${url}`));
            img.src = url;
          }),
        src,
      );
      expect(actual).toEqual([w, h]);
    }
  });

  test('head carries the install and sharing tags', async () => {
    const meta = await p.evaluate(() => {
      const get = (sel: string, attr = 'content') =>
        document.querySelector(sel)?.getAttribute(attr) ?? null;
      return {
        manifest: get('link[rel=manifest]', 'href'),
        apple: get('link[rel=apple-touch-icon]', 'href'),
        appleTitle: get('meta[name="apple-mobile-web-app-title"]'),
        themeColor: get('meta[name=theme-color]'),
        ogTitle: get('meta[property="og:title"]'),
        ogImage: get('meta[property="og:image"]'),
        ogWidth: get('meta[property="og:image:width"]'),
        twitterCard: get('meta[name="twitter:card"]'),
        title: document.title,
      };
    });

    expect(meta.manifest).toBe('/manifest.webmanifest');
    expect(meta.apple).toBe('/icons/apple-touch-icon.png');
    expect(meta.appleTitle).toBe('Checklist');
    expect(meta.title).toBe('Checklist');
    expect(meta.ogTitle).toBe('Checklist');
    expect(meta.ogImage).toContain('opengraph-image');
    expect(meta.ogWidth).toBe('1200');
    expect(meta.twitterCard).toBe('summary_large_image');
  });

  test('the share card is a real 1200x630 image', async () => {
    const src = await p.evaluate(
      () => document.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? '',
    );
    // Built with a localhost metadataBase unless NEXT_PUBLIC_SITE_URL is set,
    // so compare paths rather than origins.
    const path = new global.URL(src).pathname + new global.URL(src).search;
    const size = await p.evaluate(
      (u) =>
        new Promise<[number, number]>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
          img.onerror = () => reject(new Error('og image failed to load'));
          img.src = u;
        }),
      path,
    );
    expect(size).toEqual([1200, 630]);
  });

  test('theme-color follows the selected theme', async () => {
    const colour = () =>
      p.evaluate(() => document.querySelector('meta[name=theme-color]')?.getAttribute('content'));
    // Compare against the computed token, not a literal: production CSS is
    // minified, so #000000 arrives as #000.
    const canvas = () =>
      p.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim(),
      );

    const before = await colour();
    expect(before).toBe(await canvas());

    await p.locator('[title=More]').first().click();
    await p.waitForTimeout(200);
    await p.locator('.swatch').nth(1).click(); // off-white
    await p.waitForTimeout(250);

    const after = await colour();
    expect(after).toBe(await canvas());
    expect(after).not.toBe(before);
  });

  test('service worker takes control, so the app works offline', async () => {
    const controlled = await p.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return { scope: reg.scope, controlled: navigator.serviceWorker.controller !== null };
    });
    expect(controlled.scope).toEndWith('/');
    expect(controlled.controlled).toBe(true);
  });

  test('no console errors', () => {
    expect(errs).toEqual([]);
  });
});

describe('offline', () => {
  let ctx: BrowserContext, p: Page;

  beforeAll(async () => {
    ({ ctx, p } = await openPage());
    // Wait for the worker to control the page, otherwise the reload below
    // would race the very first install.
    await p.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
      }
    });
  }, 30_000);

  afterAll(async () => {
    await ctx.setOffline(false);
    await ctx.close();
  });

  test('the app still loads with the network cut', async () => {
    await ctx.setOffline(true);
    await p.reload();
    await p.waitForTimeout(600);

    expect(await p.locator('[data-t=node]').count()).toBeGreaterThan(80);
    expect(await p.textContent('[data-t=count]')).toBeTruthy();
  });

  test('edits still persist offline', async () => {
    const first = p.locator('section').first().locator('> ul > [data-t=node]').nth(0)
      .locator('> [data-t=row] [data-t=txt]');
    await first.click();
    await p.keyboard.press(LINE_END);
    await p.keyboard.type(' OFFLINE');
    await p.waitForTimeout(400);

    await p.reload();
    await p.waitForTimeout(600);
    expect(await first.textContent()).toEndWith(' OFFLINE');
  });
});
