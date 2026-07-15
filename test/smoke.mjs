// Headless-WebGPU browser smoke for the EdgeReg app.
//
// Boots `vite preview` on the production build, drives it in headless Chromium
// with WebGPU via SwiftShader (the recipe niivue's own e2e suite uses:
// --use-gl=angle --enable-unsafe-swiftshader), and asserts the full path that
// node smoke can't reach: WebGPU / three-panel NiiVue attach, Vite worker URLs,
// the default moving+template load, automatic niimath `-allineate` registration
// (the resliced panel populates), the header (ⓘ) dialog, and that nothing throws
// to the page / logs to console.error.
//
// Usage:  npm run test:e2e
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PORT = 4173
const URL = `http://localhost:${PORT}/EdgeReg/`

// --- boot vite preview ---
// detached so the child is its own process-group leader; killing -pid then reaps
// the whole group (vite + its esbuild children). A plain preview.kill() would only
// signal the `npx` wrapper and orphan the actual server, leaking port 4173.
const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'inherit',
  detached: true,
})
let cleaned = false
const cleanup = () => {
  if (cleaned) return
  cleaned = true
  try { process.kill(-preview.pid, 'SIGTERM') } catch { /* already gone */ }
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

// --strictPort makes vite exit non-zero on a port clash; catch that so the test
// fails fast instead of polling a port served by some other (stale) process.
let previewExited = false
let previewExitCode = null
preview.on('exit', (code) => { previewExited = true; previewExitCode = code })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
// poll the server until it answers
async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (previewExited) {
      throw new Error(`vite preview exited (code ${previewExitCode}) before ready — port ${PORT} clash?`)
    }
    let ok = false
    try {
      ok = (await fetch(URL)).ok
    } catch { /* not up yet */ }
    if (ok) {
      // The port answered — but confirm it's OUR preview, not a STALE server that won the
      // port and forced our --strictPort child to exit (which would silently validate a
      // stale build). A strictPort bind failure exits the child within a few hundred ms,
      // so settle briefly and re-check before trusting the server.
      await wait(500)
      if (previewExited) {
        throw new Error(
          `port ${PORT} is served by another process — our --strictPort preview exited (code ${previewExitCode}); refusing to test a stale server`,
        )
      }
      return
    }
    await wait(300)
  }
  throw new Error('vite preview did not come up')
}

let browser
const fail = async (msg, page) => {
  console.error('\n❌ SMOKE FAIL:', msg)
  if (page) await page.screenshot({ path: join(here, 'smoke-fail.png') }).catch(() => {})
  if (browser) await browser.close().catch(() => {})
  cleanup()
  process.exit(1)
}

// Wait until the status label CONTAINS `m`. Passed as a real function (+ arg) so
// Playwright actually evaluates the predicate each poll — a STRING `() => …` would
// be evaluated to a truthy function object and pass immediately (a silent no-op).
const waitStatus = (page, m, timeout) =>
  page.waitForFunction(
    (needle) => (document.getElementById('statusMsg')?.textContent || '').includes(needle),
    m,
    { timeout },
  )

try {
  await waitForServer()
  // Use the system Google Chrome (channel) rather than Playwright's bundled
  // browser — it has full WebGPU and avoids a separate browser download. The
  // swiftshader/angle flags are a software-rendering fallback for headless.
  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--window-size=1280,960'],
  })
  const page = await browser.newPage()
  const consoleErrors = []
  const pageErrors = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(e.message))

  await page.goto(URL, { waitUntil: 'domcontentloaded' })

  // 1. App initialized + default registration completed. init() attaches all three
  // NiiVue panels, loads the default moving + template, and auto-runs the niimath
  // `-allineate` registration — which reports "Registered" and populates the resliced
  // panel. This one wait subsumes WebGPU/NiiVue attach + the default loads (init failure
  // leaves the status on the WebGPU/error message and this fails with a clear msg).
  await waitStatus(page, 'Registered', 120000)
    .catch(() => fail('default registration never completed (NiiVue attach / default loads / allineate not ready)', page))
  // The output canvas must be present and visible after registration.
  const reslicedCanvasVisible = await page.evaluate(() => {
    const c = document.getElementById('glResliced')
    return !!c && c.getBoundingClientRect().width > 0
  })
  if (!reslicedCanvasVisible) await fail('resliced panel canvas not visible after registration', page)
  await page.screenshot({ path: join(here, 'smoke-registered.png') })
  console.log('✓ App initialized (3 NiiVue panels attached) and default registration completed')

  // 2. The View selector re-lays out all three panels without error.
  await page.selectOption('#sliceType', '0') // Axial
  await page.waitForTimeout(300)
  console.log('✓ View selector switched slice layout')

  // 3. The header (ⓘ) dialog opens with real header text for a panel.
  await page.click('#infoStationary')
  const hdrOpen = await page.evaluate(() => {
    const d = document.getElementById('infoDialog')
    const t = document.getElementById('infoText')?.textContent || ''
    return d?.open === true && t.length > 20
  })
  if (!hdrOpen) await fail('header info dialog did not open with header text', page)
  await page.click('#infoDialog button') // dismiss
  console.log('✓ Header info dialog shows NIfTI header text')

  // 3b. Crosshair readout: clicking in the template panel must show BOTH the template
  // and resliced intensity (the yoked pair), and the permanent drag hint must persist.
  const box = await page.locator('#glStationary').boundingBox()
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.25)
  await page.waitForTimeout(300)
  const loc = await page.evaluate(() => document.getElementById('location')?.textContent || '')
  if (!(loc.includes('Template') && loc.includes('Resliced'))) {
    await fail(`crosshair readout should show both intensities, got: "${loc}"`, page)
  }
  const hint = await page.evaluate(() => document.querySelector('.drophint')?.textContent || '')
  if (!hint.includes('Drag')) await fail('permanent drag hint was overwritten', page)
  console.log('✓ Crosshair readout shows both Template + Resliced; drag hint persists')

  // 4. Save → must produce a browser download (enabled once registration completed).
  if (await page.isDisabled('#saveBtn')) await fail('Save disabled after a completed registration', page)
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#saveBtn'),
  ]).catch(() => fail('Save did not produce a download', page))
  console.log('✓ Save produced a download:', download.suggestedFilename())

  // 4b. Replacing an input must invalidate the old output immediately; Save becomes
  // available again only after the replacement registration has completed.
  await page.selectOption('#stationarySelect', 'avg152')
  if (!(await page.isDisabled('#saveBtn'))) {
    await fail('Save remained enabled while replacing the template', page)
  }
  await page.waitForFunction(
    () => {
      const status = document.getElementById('statusMsg')?.textContent || ''
      const save = document.getElementById('saveBtn')
      return status.startsWith('Registered') && save?.disabled === false
    },
    undefined,
    { timeout: 120000 },
  ).catch(() => fail('replacement registration did not complete and re-enable Save', page))
  console.log('✓ replacing an input invalidated then refreshed the resliced output')

  // 4c. Robust FOV is a distinct niimath chain. Its rerun must remove the old output
  // before processing, then restore Save only after the fresh result loads.
  await page.check('#robustfovCheck')
  await waitStatus(page, 'robustfov', 5000)
    .catch(() => fail('Robust FOV registration did not start', page))
  await page.click('#infoResliced')
  const robustClearedOutput = await page.evaluate(() =>
    (document.getElementById('infoText')?.textContent || '').includes('(no image loaded)'),
  )
  if (!robustClearedOutput) {
    await fail('Robust FOV rerun left the previous resliced output visible', page)
  }
  await page.click('#infoDialog button')
  await page.waitForFunction(
    () => {
      const status = document.getElementById('statusMsg')?.textContent || ''
      const save = document.getElementById('saveBtn')
      return status.startsWith('Registered') && save?.disabled === false
    },
    undefined,
    { timeout: 120000 },
  ).catch(() => fail('Robust FOV registration did not complete and re-enable Save', page))
  console.log('✓ Robust FOV invalidated then refreshed the resliced output')

  // 5. Fatal on any uncaught page error OR console.error. The app is expected to
  // run clean (niimath chatter is buffered, the favicon 404 is suppressed); a
  // console error means a real regression. If a benign third-party error ever
  // appears, narrow it with an explicit allowlist here rather than downgrading.
  if (pageErrors.length) await fail('uncaught page errors:\n  ' + pageErrors.join('\n  '), page)
  if (consoleErrors.length) await fail('console.error output:\n  ' + consoleErrors.join('\n  '), page)
  console.log('✓ no console.error output')

  // 6. The friendly unsupported-WebGPU path must stay inert: after init returns,
  // queue cleanup must not re-enable controls that would call unattached viewers.
  const noGpuPage = await browser.newPage()
  await noGpuPage.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined })
  })
  await noGpuPage.goto(URL, { waitUntil: 'domcontentloaded' })
  await waitStatus(noGpuPage, 'needs a recent desktop', 5000)
    .catch(() => fail('unsupported-WebGPU message was not shown', noGpuPage))
  const unsupportedControlsDisabled = await noGpuPage.evaluate(() =>
    ['movingSelect', 'stationarySelect', 'sliceType', 'robustfovCheck', 'dicomPick'].every(
      (id) => document.getElementById(id)?.disabled === true,
    ),
  )
  if (!unsupportedControlsDisabled) {
    await fail('image controls were enabled without WebGPU', noGpuPage)
  }
  await noGpuPage.close()
  console.log('✓ unsupported-WebGPU path stays friendly and inert')

  console.log('\n✅ SMOKE PASS')
  await browser.close()
  cleanup()
  process.exit(0)
} catch (e) {
  await fail(e?.stack || String(e))
}
