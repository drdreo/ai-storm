/**
 * End-to-end pipeline test (PRD §3.3): drives the REAL browser app against the
 * REAL Deno backend, spawning a REAL local PTY, and asserts that streamed
 * terminal text is parsed and materialised as BlockSuite blocks on the canvas.
 *
 * Usage: node e2e/pipeline.mjs [baseURL]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8790';
const MARKER = 'StreamedHeadingMarker987';

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

let pass = false;
try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('affine-editor-container', { timeout: 20000 });

  // The session defaults to launching the `claude` harness; for this pipeline
  // test (no claude in CI) override the harness to a plain shell so we can emit
  // a deterministic Markdown line through stdout.
  const harness = page.locator('as-control-hub .harness');
  await harness.fill('powershell');
  await harness.press('Tab');

  // Type a command whose stdout is a clean Markdown heading, then submit.
  const composer = page.locator('as-control-hub textarea');
  await composer.click();
  await composer.fill(`Write-Output "# ${MARKER}"`);
  await composer.press('Enter');

  // Wait for: shell spawn → stdout stream → SlicingBuffer → parser →
  // RenderScheduler (rAF) → CanvasService.applyBlocks → BlockSuite render.
  await page.waitForFunction(
    (marker) => {
      const ed = document.querySelector('affine-editor-container');
      return !!ed && (ed.textContent ?? '').includes(marker);
    },
    MARKER,
    { timeout: 25000 },
  );
  pass = true;
} catch (err) {
  console.log('FAIL -', err?.message ?? String(err));
  // Dump what the canvas actually contains to aid debugging.
  const text = await page.evaluate(
    () => document.querySelector('affine-editor-container')?.textContent ?? '(none)',
  );
  console.log('canvas text was:', JSON.stringify(text.slice(0, 400)));
} finally {
  await browser.close();
}

console.log(
  pass
    ? `ok   - streamed terminal text "${MARKER}" rendered as a BlockSuite block`
    : 'pipeline did not deliver streamed text to the canvas',
);
if (errors.length) console.log('page errors:', errors.slice(0, 5).join('\n'));
console.log(pass ? '\nPIPELINE E2E PASSED' : '\nPIPELINE E2E FAILED');
process.exit(pass ? 0 : 1);
