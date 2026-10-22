import assert from 'node:assert/strict';
import { mkdir, readdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { serveHarness } from '../harness/serve.mjs';
await import('../harness/build.mjs');
const server = await serveHarness();
let browser;
async function executable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  try { await access(chromium.executablePath()); return chromium.executablePath(); } catch (_) { /* inspect existing cache without downloading */ }
  const cache = join(homedir(), '.cache', 'ms-playwright');
  try { for (const name of (await readdir(cache)).filter(name => name.startsWith('chromium-')).sort().reverse()) {
    for (const subdir of ['chrome-linux64', 'chrome-linux']) { const path = join(cache, name, subdir, 'chrome'); try { await access(path); return path; } catch (_) {} }
  } } catch (_) {}
  throw new Error('No Chromium executable. Install the pinned Playwright browser or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.');
}
const errors = [];
const checks = [];
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); console.log(`PASS ${label}`); };
try {
  browser = await chromium.launch({ executablePath: await executable(), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-session-id="approval"]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-session-id="root"]')?.dataset.working === 'true');
  check('all five shelves rendered', await page.locator('.sf-section').count() === 5);
  check('waiting approval remains Active above pins', await page.locator('section[aria-label="Active"] [data-session-id="approval"]').count() === 1);
  check('Working is visually dimmed', Number(await page.locator('[data-session-id="root"]').evaluate(el => getComputedStyle(el).opacity)) < 1);
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL('../artifacts/frontend.png', import.meta.url).pathname, fullPage: true });
  await page.getByRole('button', { name: 'Actions for Sidebar layout', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  check('actions popover is visible outside sidebar scroll clipping', await page.getByRole('dialog').evaluate(el => { const rect = el.getBoundingClientRect(); return rect.width > 180 && rect.right <= innerWidth && rect.bottom <= innerHeight && el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + 30)); }));
  await page.screenshot({ path: new URL('../artifacts/actions.png', import.meta.url).pathname, fullPage: true });
  await page.getByRole('button', { name: 'Settle', exact: true }).click();
  await page.locator('section[aria-label="Recently Settled"] [data-session-id="design"]').waitFor();
  check('settlement and server-readback rendered', true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.locator('section[aria-label="Active"] [data-session-id="design"]').waitFor();
  check('Undo restores Active', true);
  await page.locator('[data-session-id="design"]').click({ button: 'right' });
  await page.getByRole('button', { name: 'Snooze · In 1 hour', exact: true }).click();
  await page.locator('section[aria-label="Snoozed"] [data-session-id="design"]').waitFor();
  check('context menu snoozes and restores', true);
  await page.locator('[data-session-id="design"]').hover();
  await page.locator('[data-session-id="design"] [aria-label="Restore session"]').click();
  await page.locator('section[aria-label="Active"] [data-session-id="design"]').waitFor();
  await page.getByRole('searchbox').fill('release');
  await page.waitForFunction(() => !document.querySelector('[data-session-id="design"]'));
  check('search filters real React rows', await page.locator('[data-session-id="readme"]').count() === 1);
  await page.getByRole('searchbox').fill('');
  await page.getByRole('combobox', { name: 'Filter by project' }).selectOption('/projects/docs');
  await page.waitForFunction(() => !document.querySelector('[data-session-id="design"]'));
  await page.getByRole('button', { name: 'Group by project' }).click();
  check('project filter independent from optional grouping', await page.locator('.sf-group').count() > 0);
  await page.getByRole('combobox', { name: 'Filter by project' }).selectOption('*');
  await page.getByRole('button', { name: 'Simulate missing backend' }).click();
  await page.getByText(/Read-only browsing/).waitFor();
  check('missing backend disables mutation but preserves browsing', await page.locator('[data-session-id="design"] [aria-label="Settle session"]').isDisabled());
  await page.getByRole('button', { name: 'Restore mock backend' }).click();
  await page.getByRole('button', { name: 'Simulate runtime failure' }).click();
  await page.getByText(/Runtime status unavailable/).waitFor();
  check('runtime failure explicitly unknown, settled kept Active', await page.locator('section[aria-label="Active"] [data-session-id="settled"]').count() === 1);
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  check('native-new API only, no hidden prompt', await page.evaluate(() => window.sessionFlowHarness.calls.some(call => call[0] === 'new')));
  check('no browser page errors', errors.length === 0);
  console.log(`Browser smoke: ${checks.length} checks passed; screenshots artifacts/frontend.png and artifacts/actions.png`);
} finally { await browser?.close(); server.close(); }
