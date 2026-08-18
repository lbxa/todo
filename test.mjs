/* Regression suite. Selectors use data-t hooks so styling changes can't break it. */
import { chromium } from 'playwright';
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL = 'file:///home/claude/move-checklist.html';
let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS  ' : 'FAIL  ') + n); };

const b = await chromium.launch({ executablePath: EXE });

/* ---------- core editing ---------- */
{
  const ctx = await b.newContext(); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(URL); await p.waitForTimeout(600);

  const S = p.locator('section').first();
  const rows = S.locator('> ul > [data-t=node]');
  const txt = (n) => rows.nth(n).locator('> [data-t=row] [data-t=txt]');

  ok('renders', await p.locator('[data-t=node]').count() > 80);
  console.log('      ' + await p.textContent('[data-t=count]'));

  await txt(0).click(); await p.keyboard.press('End'); await p.keyboard.type('XYZ');
  await p.waitForTimeout(80);
  ok('typing keeps caret order', (await txt(0).textContent()).endsWith('XYZ'));

  const n0 = await rows.count();
  await p.keyboard.press('Enter'); await p.waitForTimeout(80);
  ok('Enter creates a sibling', await rows.count() === n0 + 1);
  await p.keyboard.type('brand new'); await p.waitForTimeout(80);
  ok('new row is focused', await txt(1).textContent() === 'brand new');

  await p.keyboard.press('Tab'); await p.waitForTimeout(100);
  ok('Tab indents', await rows.nth(0).locator('[data-t=kids] [data-t=txt]').last().textContent() === 'brand new');
  await p.keyboard.press('Tab'); await p.waitForTimeout(80);
  ok('depth capped at 1', await p.evaluate(() => Math.max(...[...document.querySelectorAll('[data-t=kids]')]
    .map(u => { let d = 0, n = u.parentElement; while (n) { if (n.dataset?.t === 'kids') d++; n = n.parentElement } return d + 1 }))) === 1);
  await p.keyboard.press('Shift+Tab'); await p.waitForTimeout(100);
  ok('Shift+Tab outdents', await txt(1).textContent() === 'brand new');

  await p.keyboard.press('Home');
  for (let i = 0; i < 5; i++) await p.keyboard.press('ArrowRight');
  await p.keyboard.press('Enter'); await p.waitForTimeout(100);
  ok('Enter splits at the caret', await txt(1).textContent() === 'brand' && await txt(2).textContent() === ' new');
  await p.keyboard.press('Home'); await p.keyboard.press('Backspace'); await p.waitForTimeout(100);
  ok('Backspace merges up', await txt(1).textContent() === 'brand new');

  const parent = rows.nth(0);
  await parent.locator('> [data-t=row] .tick').click(); await p.waitForTimeout(80);
  const kt = await parent.locator('[data-t=kids] .tick.on').count();
  ok('parent cascades to children', kt > 0 && kt === await parent.locator('[data-t=kids] [data-t=node]').count());
  await parent.locator('[data-t=kids] .tick').first().click(); await p.waitForTimeout(80);
  ok('partial state shows', await parent.locator('> [data-t=row] .tick.part').count() === 1);

  const c1 = await p.textContent('[data-t=count]');
  await p.keyboard.down('Control'); await p.keyboard.press('KeyZ'); await p.keyboard.up('Control');
  await p.waitForTimeout(120);
  ok('undo works', await p.textContent('[data-t=count]') !== c1);

  await txt(1).click(); await p.keyboard.press('Shift+Enter'); await p.keyboard.type('a note');
  await p.waitForTimeout(100);
  ok('Shift+Enter opens a description',
    await rows.nth(1).locator('> [data-t=row] [data-t=note]').textContent() === 'a note');

  await S.locator('[data-t=add]').click(); await p.waitForTimeout(120);
  await p.keyboard.type('via add button'); await p.waitForTimeout(80);
  ok('Add item works and focuses', (await rows.last().locator('> [data-t=row] [data-t=txt]').textContent()) === 'via add button');
  ok('Add item is visible unhovered',
    await S.locator('[data-t=add]').evaluate(e => getComputedStyle(e).opacity) === '1');

  await p.waitForTimeout(400); await p.reload(); await p.waitForTimeout(600);
  ok('persists across reload', await txt(1).textContent() === 'brand new');
  ok('no console errors', errs.length === 0);
  if (errs.length) console.log(errs.slice(0, 4));
  await ctx.close();
}

/* ---------- themes ---------- */
{
  const ctx = await b.newContext(); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(URL); await p.waitForTimeout(600);
  const bg = () => p.evaluate(() => getComputedStyle(document.body).backgroundColor);

  ok('default theme is Lights out', await p.getAttribute('html', 'data-theme') === 'lights-out' && await bg() === 'rgb(0, 0, 0)');
  await p.locator('[title=More]').first().click(); await p.waitForTimeout(200);
  const sw = p.locator('.swatch');
  ok('four themes offered', await sw.count() === 4);

  const seen = [];
  for (let i = 0; i < 4; i++) { await sw.nth(i).click(); await p.waitForTimeout(200); seen.push([await p.getAttribute('html', 'data-theme'), await bg()]); }
  ok('themes are distinct', new Set(seen.map(s => s[1])).size === 4);
  ok('theme ids as expected', seen.map(s => s[0]).join() === 'lights-out,off-white,pastel,red-eye');
  seen.forEach(([t, c]) => console.log('      ' + t.padEnd(11) + c));

  // accent + text must actually re-theme, not just the background
  const inkAccent = await p.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return [cs.getPropertyValue('--color-ink').trim(), cs.getPropertyValue('--color-accent').trim()];
  });
  ok('tokens follow the theme', inkAccent[0] === '#efe4d6' && inkAccent[1] === '#e9a03c');

  await p.locator('body').click({ position: { x: 5, y: 5 } }); await p.waitForTimeout(400);
  await p.reload(); await p.waitForTimeout(600);
  ok('theme persists', await p.getAttribute('html', 'data-theme') === 'red-eye');
  ok('no errors', errs.length === 0);
  await ctx.close();
}

/* ---------- context menu ---------- */
{
  const ctx = await b.newContext(); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(URL); await p.waitForTimeout(600);
  const S = p.locator('section').first();
  const rows = S.locator('> ul > [data-t=node]');
  const menu = p.locator('[data-t=ctx]');

  // opening on rows at different scroll positions (the scroll-close regression)
  for (const i of [0, 2, 4, 1]) {
    await rows.nth(i).locator('> [data-t=row]').click({ button: 'right' });
    await p.waitForTimeout(200);
    const open = await menu.count() === 1;
    if (!open) { ok('menu opens on row ' + i, false); break; }
    await p.keyboard.press('Escape'); await p.waitForTimeout(150);
  }
  ok('menu reopens on any row after closing', true);

  await rows.nth(3).locator('> [data-t=row]').click({ button: 'right' });
  await p.waitForTimeout(200);
  const labels = (await menu.locator('button').allTextContents()).map(s => s.replace(/[⇧⌘⌥↵⇥⌫↑↓]/g, '').trim());
  console.log('      ' + labels.join(' · '));
  ok('menu offers a description action', labels.some(l => /description/i.test(l)));

  await menu.locator('button').filter({ hasText: /description/i }).first().click();
  await p.waitForTimeout(200);
  await p.keyboard.type('from the right-click menu'); await p.waitForTimeout(120);
  ok('description is editable from the menu',
    (await rows.nth(3).locator('> [data-t=row] [data-t=note]').textContent()).endsWith('from the right-click menu'));

  // indent / outdent enablement respects depth
  await rows.nth(0).locator('[data-t=kids] [data-t=row]').first().click({ button: 'right' });
  await p.waitForTimeout(200);
  const dis = await menu.locator('button').filter({ hasText: 'Indent' }).first().isDisabled();
  const en = await menu.locator('button').filter({ hasText: 'Outdent' }).first().isEnabled();
  ok('menu disables Indent on a sub-item, enables Outdent', dis && en);
  await p.keyboard.press('Escape'); await p.waitForTimeout(150);

  const n = await rows.count();
  await rows.nth(2).locator('> [data-t=row]').click({ button: 'right' }); await p.waitForTimeout(200);
  await menu.locator('button').filter({ hasText: 'Delete' }).first().click(); await p.waitForTimeout(200);
  ok('Delete from the menu works', await rows.count() === n - 1);

  await rows.nth(2).locator('> [data-t=row]').click({ button: 'right' }); await p.waitForTimeout(200);
  await p.mouse.click(20, 300); await p.waitForTimeout(200);
  ok('clicking away closes the menu', await menu.count() === 0);

  ok('no errors', errs.length === 0);
  if (errs.length) console.log(errs.slice(0, 4));
  await ctx.close();
}

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
