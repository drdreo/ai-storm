/**
 * Browser smoke test for the ai-storm client (run against the built app served
 * by the Node backend, e.g. on http://127.0.0.1:8790).
 *
 * Validates the in-browser runtime that the unit/build steps can't:
 *   - the app boots through the crash-recovery sequence (PRD §3.5)
 *   - all three panes render (PRD §3.1)
 *   - BlockSuite mounts as a web component (PRD §4.1)
 *   - the CRDT IndexedDB stores are created (PRD §3.5)
 *   - doc/edgeless mode toggle works (PRD §3.1)
 *   - a second workspace can be created and hot-switched (PRD §3.4)
 *
 * Usage: node e2e/smoke.mjs [baseURL]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8790';
const results = [];
let failures = 0;

function check(name, cond) {
  results.push(`${cond ? 'ok  ' : 'FAIL'} - ${name}`);
  if (!cond) failures++;
}

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });

  // Boot + shell panes.
  await page.waitForSelector('as-sidebar', { timeout: 20000 });
  check('sidebar renders', !!(await page.$('as-sidebar')));
  check('canvas pane renders', !!(await page.$('as-canvas-pane')));
  check('control hub renders', !!(await page.$('as-control-hub')));

  // BlockSuite editor mounted as a custom element.
  await page.waitForSelector('affine-editor-container', { timeout: 20000 });
  const upgraded = await page.evaluate(() => {
    const el = document.querySelector('affine-editor-container');
    return !!el && el.constructor?.name !== 'HTMLElement';
  });
  check('affine-editor-container present', !!(await page.$('affine-editor-container')));
  check('editor custom element upgraded (Lit registered)', upgraded);

  // CRDT IndexedDB persistence stores created (PRD §3.5).
  const dbs = await page.evaluate(async () => {
    const list = (await indexedDB.databases?.()) ?? [];
    return list.map((d) => d.name);
  });
  check('canvas IndexedDB store created', dbs.includes('ai-storm-canvas'));
  check('registry IndexedDB store created', dbs.includes('ai-storm-registry'));

  // Mode toggle: Document -> Canvas -> Document (PRD §3.1).
  // The mode switch is now an @angular/aria tablist, so the controls expose
  // role="tab" (not role="button").
  await page.getByRole('tab', { name: 'Canvas' }).click();
  await page.waitForTimeout(400);
  const edgeless = await page.evaluate(
    () => document.querySelector('affine-editor-container')?.mode,
  );
  check('toggled to edgeless mode', edgeless === 'edgeless');
  await page.getByRole('tab', { name: 'Document' }).click();
  await page.waitForTimeout(300);
  const pageMode = await page.evaluate(
    () => document.querySelector('affine-editor-container')?.mode,
  );
  check('toggled back to page mode', pageMode === 'page');

  // Multi-workspace create + hot-switch (PRD §3.4).
  const before = await page.$$eval('as-sidebar .item', (n) => n.length);
  await page.click('as-sidebar .add');
  await page.waitForTimeout(300);
  const after = await page.$$eval('as-sidebar .item', (n) => n.length);
  check('new workspace added to sidebar', after === before + 1);
  const activeCount = await page.$$eval('as-sidebar .item.active', (n) => n.length);
  check('exactly one active workspace after switch', activeCount === 1);

  // Switch back to the first workspace and time the transition (PRD §3.4 <100ms).
  const t = await page.evaluate(async () => {
    const items = [...document.querySelectorAll('as-sidebar .item')];
    const start = performance.now();
    items[0].click();
    await new Promise((r) => requestAnimationFrame(() => r()));
    return performance.now() - start;
  });
  check(`hot-switch under 100ms (measured ${t.toFixed(1)}ms)`, t < 100);

  check('no uncaught console/page errors', consoleErrors.length === 0);
} catch (err) {
  results.push('FAIL - exception: ' + (err?.message ?? String(err)));
  failures++;
} finally {
  await browser.close();
}

console.log(results.join('\n'));
if (consoleErrors.length) {
  console.log('\n--- console/page errors ---');
  console.log(consoleErrors.slice(0, 10).join('\n'));
}
console.log(`\n${failures === 0 ? 'ALL BROWSER CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
