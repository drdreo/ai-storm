/**
 * Browser smoke test for the ai-storm React client (#65). Run against the dev
 * server (http://localhost:4200) or the built app served by the Node backend.
 *
 * Validates the in-browser runtime that the unit/build steps can't:
 *   - the app boots through the crash-recovery sequence (PRD §3.5)
 *   - all three panes render (PRD §3.1) and tldraw mounts (PD-013/PD-016)
 *   - a workspace can be created (+) and inline-renamed (PRD §3.4)
 *   - a real PTY session round-trips through ConPTY (data → xterm → input)
 *   - hot-switch preserves a workspace's terminal scrollback (PRD §3.4)
 *   - the tldraw + registry IndexedDB stores use the pinned name scheme (§3.5)
 *
 * Usage: node e2e/smoke.mjs [baseURL]   (default http://localhost:4200)
 */
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:4200'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} - ${name}`)
  if (!cond) failures++
}

const browser = await chromium.launch()
const page = await browser.newPage()
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(String(e)))

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })

  // Boot + shell.
  await page.getByText('ai-storm', { exact: true }).waitFor({ timeout: 20000 })
  const rows = page.locator('[data-sidebar="menu-item"]')
  await rows.first().waitFor({ timeout: 10000 })
  check('shell boots and restores >=1 workspace', (await rows.count()) >= 1)

  // tldraw canvas (the spatial surface, PD-011/PD-013).
  await page.locator('.tl-container').first().waitFor({ timeout: 15000 })
  check('tldraw canvas mounts', true)
  check('control hub renders', (await page.getByText('harness').count()) > 0)

  // Create + inline-rename.
  const before = await rows.count()
  await page.getByRole('button', { name: 'New workspace' }).click()
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-sidebar="menu-item"]').length === n,
    before + 1,
    { timeout: 5000 },
  )
  check('create (+) adds a workspace', (await rows.count()) === before + 1)

  const newRow = rows.last()
  await newRow.getByText('Untitled Project').dblclick()
  const input = newRow.getByRole('textbox', { name: 'Rename workspace' })
  await input.waitFor({ timeout: 3000 })
  await input.fill('Smoke QA')
  await input.press('Enter')
  await newRow.getByText('Smoke QA').waitFor({ timeout: 3000 })
  check('inline rename commits on Enter', true)

  // Real PTY round-trip — powershell avoids depending on the claude CLI.
  await page.getByPlaceholder('claude').fill('powershell')
  await page.getByPlaceholder('claude').press('Tab')
  await page.getByRole('button', { name: 'Start session' }).click()
  await page.locator('.xterm-rows').waitFor({ timeout: 10000 })
  await sleep(4000)
  await page.locator('.xterm').click()
  await page.keyboard.type('echo smoke-ok-42')
  await page.keyboard.press('Enter')
  await sleep(3000)
  check(
    'terminal round-trips PTY output (ConPTY)',
    /smoke-ok-42/.test(await page.locator('.xterm-rows').innerText()),
  )

  // Hot-switch preserves the session terminal.
  await rows.first().click()
  await sleep(500)
  await rows.last().click()
  await sleep(800)
  check(
    'hot-switch preserves terminal scrollback',
    /smoke-ok-42/.test(await page.locator('.xterm-rows').innerText()),
  )

  // Persistence (PRD §3.5) — the pinned tldraw DB name scheme + the registry.
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))
  check(
    'tldraw IndexedDB uses TLDRAW_DOCUMENT_v2ai-storm:ws:{id}',
    dbs.some((n) => typeof n === 'string' && n.startsWith('TLDRAW_DOCUMENT_v2ai-storm:ws:')),
  )
  check('workspace registry persisted (ai-storm-registry)', dbs.includes('ai-storm-registry'))

  check('no console/page errors', consoleErrors.length === 0)
  if (consoleErrors.length) console.log('  errors:\n   ' + consoleErrors.slice(0, 8).join('\n   '))
} finally {
  await browser.close()
}

console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
