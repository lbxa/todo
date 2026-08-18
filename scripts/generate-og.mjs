/**
 * Renders the OpenGraph share card to app/opengraph-image.png, which Next's
 * file convention picks up and wires into the page metadata automatically.
 *
 *   bun run og
 */
import { chromium } from 'playwright';
import { join } from 'node:path';
import { iconSvg, CANVAS, ACCENT } from './icon.mjs';

const OUT = join(import.meta.dirname, '..', 'app', 'opengraph-image.png');
const W = 1200;
const H = 630;

const rows = [
  ['Passport and visa documents', true],
  ['Sort the international SIM', true],
  ['Ship the winter coats', false],
  ['Book the movers', false],
];

const html = `<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:${W}px;height:${H}px;background:${CANVAS};display:flex;align-items:center;gap:80px;
       padding:0 88px;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif;
       -webkit-font-smoothing:antialiased}
  .left{flex:1;min-width:0}
  .mark{width:112px;height:112px;margin-bottom:44px}
  .mark svg{display:block;width:100%;height:100%;border-radius:26px}
  h1{font-size:86px;line-height:1;letter-spacing:-.04em;color:#f5f5f7;font-weight:600}
  p{margin-top:26px;font-size:30px;line-height:1.42;letter-spacing:-.012em;color:#86868b;max-width:16ch}
  ul{list-style:none;display:flex;flex-direction:column;gap:26px;flex:none;width:430px}
  li{display:flex;align-items:center;gap:20px;font-size:27px;letter-spacing:-.01em;color:#f5f5f7}
  .tick{width:30px;height:30px;border-radius:999px;border:2px solid #2c2c2e;flex:none;position:relative}
  .tick.on{background:${ACCENT};border-color:${ACCENT}}
  .tick.on:after{content:"";position:absolute;left:9.5px;top:5px;width:6px;height:13px;
                 border:solid #fff;border-width:0 2.6px 2.6px 0;transform:rotate(45deg)}
  li.on{color:#48484a;text-decoration:line-through;text-decoration-color:#48484a}
</style>
<div class="left">
  <div class="mark">${iconSvg()}</div>
  <h1>Checklist</h1>
  <p>Nestable lists that live in your browser.</p>
</div>
<ul>${rows
  .map(
    ([label, done]) =>
      `<li class="${done ? 'on' : ''}"><span class="tick ${done ? 'on' : ''}"></span>${label}</li>`,
  )
  .join('')}</ul>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.setContent(html);
await page.screenshot({ path: OUT });
await browser.close();
console.log(`app/opengraph-image.png  ${W}x${H}`);
