/**
 * Renders the PWA icon set to public/icons/ using the Playwright Chromium that
 * the test suite already depends on, so icon generation adds no new tooling.
 *
 *   bun run icons
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { iconSvg, CANVAS } from './icon.mjs';

const OUT = join(import.meta.dirname, '..', 'public', 'icons');

// `any` icons are shown as drawn; `maskable` ones get cropped to a platform
// shape, so their content sits inside the middle 80% safe zone.
const TARGETS = [
  { file: 'icon-192.png', size: 192, radiusRatio: 0.293 },
  { file: 'icon-512.png', size: 512, radiusRatio: 0.293 },
  { file: 'icon-maskable-192.png', size: 192, radiusRatio: 0.229 },
  { file: 'icon-maskable-512.png', size: 512, radiusRatio: 0.229 },
  { file: 'apple-touch-icon.png', size: 180, radiusRatio: 0.293 },
];

const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });

for (const { file, size, radiusRatio } of TARGETS) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const svg = iconSvg(radiusRatio);
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:${CANVAS}}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await page.screenshot({ path: join(OUT, file), omitBackground: false });
  await page.close();
  console.log(`${file.padEnd(26)} ${size}x${size}`);
}
await browser.close();

// A vector favicon for the browser tab; Next serves app/icon.svg automatically.
await writeFile(join(import.meta.dirname, '..', 'app', 'icon.svg'), iconSvg() + '\n');
console.log('app/icon.svg'.padEnd(26) + 'vector');
