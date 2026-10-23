import assert from 'node:assert/strict';
import { mkdir, readdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const screenshotDir = join(process.env.TMPDIR || '/home/hermes/.hermes/cache/scratch', 't3-sidebar-ui-verification');
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
  check('waiting approval remains Ready despite settlement and pin metadata', await page.locator('section[aria-label="Active"] [data-session-id="approval"]').count() === 1);
  check('Working is visually dimmed', Number(await page.locator('[data-session-id="root"]').evaluate(el => getComputedStyle(el).opacity)) < 1);
  await mkdir(screenshotDir, { recursive: true });
  const design = page.locator('[data-session-id="design"]');
  const snooze = design.getByRole('button', { name: 'Snooze session', exact: true });
  const settle = design.getByRole('button', { name: 'Settle session', exact: true });
  await page.mouse.move(1100, 850);
  check('Snooze and Settle hidden without hover', !await snooze.isVisible() && !await settle.isVisible());
  await design.locator('.sf-open').focus();
  check('card focus alone does not reveal hover buttons', !await snooze.isVisible() && !await settle.isVisible());
  await design.hover();
  check('hover reveals clock Snooze and labeled Settle', await snooze.isVisible() && await settle.isVisible() && await settle.textContent() === 'Settle');
  await snooze.click();
  await page.getByRole('dialog', { name: 'Snooze session', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Snooze · In 1 hour', exact: true }).click();
  await page.locator('section[aria-label="Snoozed"] [data-session-id="design"]').waitFor();
  check('hover Snooze saves the selected time', true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.locator('section[aria-label="Active"] [data-session-id="design"]').waitFor();
  await design.hover();
  await settle.click();
  await page.locator('section[aria-label="Settled"] [data-session-id="design"]').waitFor();
  check('hover Settle saves reversible settlement', true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.locator('section[aria-label="Active"] [data-session-id="design"]').waitFor();
  await page.mouse.move(1100, 850);
  check('buttons hide again after pointer leaves', !await snooze.isVisible() && !await settle.isVisible());
  await page.screenshot({ path: join(screenshotDir, 'frontend.png'), fullPage: true });
  await design.click({ button: 'right' });
  await page.getByRole('dialog').waitFor();
  check('actions popover is visible outside sidebar scroll clipping', await page.getByRole('dialog').evaluate(el => { const rect = el.getBoundingClientRect(); return rect.width > 180 && rect.right <= innerWidth && rect.bottom <= innerHeight && el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + 30)); }));
  await page.screenshot({ path: join(screenshotDir, 'actions.png'), fullPage: true });
  await page.getByRole('button', { name: 'Settle', exact: true }).click();
  await page.locator('section[aria-label="Settled"] [data-session-id="design"]').waitFor();
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
  await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
  await page.getByRole('combobox', { name: 'Filter by project' }).selectOption('/projects/docs');
  await page.waitForFunction(() => !document.querySelector('[data-session-id="design"]'));
  await page.getByRole('button', { name: 'Group by project' }).click();
  check('project filter independent from optional grouping', await page.locator('.sf-group').count() > 0);
  await page.getByRole('combobox', { name: 'Filter by project' }).selectOption('*');
  await page.getByRole('button', { name: 'Use flat list', exact: true }).click();
  await page.getByRole('button', { name: 'Close session actions', exact: true }).click();
  await page.getByRole('button', { name: 'Simulate missing backend' }).click();
  await page.getByText(/Read-only browsing/).waitFor();
  check('missing backend disables mutation but preserves browsing', await page.locator('[data-session-id="design"] [aria-label="Settle session"]').isDisabled());
  await page.getByRole('button', { name: 'Restore mock backend' }).click();
  await page.getByRole('button', { name: 'Simulate runtime failure' }).click();
  await page.getByText(/Runtime status unavailable/).waitFor();
  check('runtime failure explicitly unknown, settled kept Active', await page.locator('section[aria-label="Active"] [data-session-id="settled"]').count() === 1);
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByRole('button', { name: 'New session in Home', exact: true }).waitFor();
  await page.getByRole('button', { name: 'New session in Home', exact: true }).click();
  await page.getByText(/Home creation is unavailable:/).waitFor();
  check('Home shown but unavailable without session creation', !await page.evaluate(() => window.hermesT3SidebarHarness.calls.some(call => call[0] === 'requestProfile' && call[2] === 'session.create')));
  await page.getByRole('button', { name: 'New session in Synthetic Sidebar', exact: true }).click();
  await page.waitForFunction(() => window.hermesT3SidebarHarness.control.composerCwd === '/projects/hermes-t3sidebar');
  check('named project public create/open/cwd handoff; no hidden prompt', await page.evaluate(() => {
    const calls = window.hermesT3SidebarHarness.calls;
    const create = calls.find(c => c[0] === 'requestProfile' && c[2] === 'session.create');
    const open = calls.find(c => c[0] === 'open' && c[1] === 'fixture-created');
    return create[3].cwd_explicit && !create[3].close_on_disconnect && open[2].awaitHydration && open[2].expectHistory === false && !calls.some(c => c[0] === 'new' || /prompt/.test(c[2] || ''));
  }));
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Adding projects is unavailable' }).waitFor();
  check('folder plus explicitly explains unavailable public action', true);
  // Reset into large labeled synthetic data, never a live history.
  await page.evaluate(() => window.hermesT3SidebarHarness.loadDenseFixtures());
  await page.locator('[data-session-id="synthetic-active-000"]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-session-id="synthetic-working-000"]')?.dataset.working === 'true');
  for (const height of [400, 650]) {
    await page.locator('.harness-sidebar').evaluate((el, height) => { el.style.height = `${height}px`; }, height);
    await page.mouse.move(1100, 850);
    const layout = await page.locator('.sf').evaluate(el => {
      const rect = e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
      const scroll = el.querySelector('.sf-scroll');
      return { root: rect(el), list: rect(scroll), overflow: getComputedStyle(scroll).overflowY, listScrollHeight: scroll.scrollHeight, listHeight: scroll.clientHeight,
        toolbar: [...el.querySelector('.sf-header').children].map(rect), sections: [...el.querySelectorAll('.sf-section')].map(s => ({ name: s.dataset.section, rect: rect(s), header: s.querySelector('.sf-section-toggle') ? rect(s.querySelector('.sf-section-toggle')) : null, body: rect(s.querySelector('.sf-section-body')), scrollHeight: s.querySelector('.sf-section-body').scrollHeight, count: s.querySelectorAll('.sf-row').length })) };
    });
    check(`${height}px: 100 Ready plus 20 rows in each priority shelf`, layout.sections.find(s => s.name === 'active').count === 100 && layout.sections.filter(s => s.name !== 'active').every(s => s.count === 20));
    check(`${height}px: Pinned before headerless Ready, secondary headings fixed and visible`, layout.sections.map(s => s.name).join(',') === 'pinned,active,working,snoozed,settled' && layout.sections.slice(0, 2).every(s => !s.header) && layout.sections.slice(2).every(s => s.header.height === 24 && s.header.top >= layout.list.top && s.header.bottom <= layout.root.bottom && s.body.top >= s.header.bottom));
    check(`${height}px: no whole-list scrolling; all five bodies constrained`, layout.overflow === 'hidden' && layout.listScrollHeight <= layout.listHeight + 1 && layout.sections.every(s => s.body.height >= 56 && s.body.bottom <= layout.list.bottom + 1 && s.scrollHeight > s.body.height));
    check(`${height}px: priority shelf bodies receive space before Ready`, layout.sections.filter(s => s.name !== 'active').every(s => s.rect.height >= 56) && layout.sections.find(s => s.name === 'active').rect.height >= 56);
    check(`${height}px: toolbar single line and Search left of 3 right actions`, layout.toolbar.length === 4 && layout.toolbar.every(r => Math.abs((r.top + r.bottom) / 2 - (layout.toolbar[0].top + layout.toolbar[0].bottom) / 2) < 2) && layout.toolbar.every((r, i, arr) => !i || arr[i-1].right <= r.left));
    // Scroll each body in turn: every other category's scrollTop AND geometry stay fixed.
    for (const section of ['pinned', 'active', 'working', 'snoozed', 'settled']) {
      await page.locator('.sf-section-body').evaluateAll(els => els.forEach(el => { el.scrollTop = 0; }));
      const before = await page.locator('.sf-section-body').evaluateAll(els => els.map(el => ({ top: el.getBoundingClientRect().top, scroll: el.scrollTop })));
      const body = page.locator(`[data-section="${section}"] .sf-section-body`);
      await body.hover(); await page.mouse.wheel(0, 280);
      await page.waitForFunction(section => document.querySelector(`[data-section="${section}"] .sf-section-body`).scrollTop > 0, section);
      const after = await page.locator('.sf-section-body').evaluateAll(els => els.map(el => ({ top: el.getBoundingClientRect().top, scroll: el.scrollTop })));
      const index = ['pinned', 'active', 'working', 'snoozed', 'settled'].indexOf(section);
      check(`${height}px: ${section} wheel scroll isolated`, after[index].scroll > 0 && after.every((r, i) => Math.abs(r.top - before[i].top) < 1 && (i === index || r.scroll === before[i].scroll)));
    }
    await page.locator('.sf-section-body').evaluateAll(els => els.forEach(el => { el.scrollTop = 0; }));
    const first = page.locator('[data-session-id="synthetic-active-000"] .sf-open');
    await first.focus();
    for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown');
    check(`${height}px: keyboard navigation scrolls only owning Ready body`, await page.locator('.sf-section-body').evaluateAll(els => els.every(el => el.closest('[data-section]').dataset.section === 'active' ? el.scrollTop > 0 : el.scrollTop === 0)));
    const readyScroll = await page.locator('[data-section="active"] .sf-section-body').evaluate(el => el.scrollTop);
    await page.keyboard.press('End');
    check(`${height}px: keyboard cross-category End scrolls only destination Settled`, await page.locator('.sf-section-body').evaluateAll((els, readyScroll) => els.every(el => {
      const section = el.closest('[data-section]').dataset.section;
      return section === 'settled' ? el.scrollTop > 0 : section === 'active' ? el.scrollTop === readyScroll : el.scrollTop === 0;
    }), readyScroll));
    await page.locator('.sf-section-body').evaluateAll(els => els.forEach(el => { el.scrollTop = 0; }));
    const card = page.locator('[data-session-id="synthetic-active-000"]');
    const metadata = await card.locator('.sf-card-meta').boundingBox(), title = await card.locator('.sf-row-title').boundingBox();
    check(`${height}px: 56px two-line card; title ellipsis below metadata`, (await card.boundingBox()).height === 56 && metadata.y + metadata.height <= title.y && await card.locator('.sf-row-title').evaluate(el => getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth));
    await card.hover(); const action = await card.locator('.sf-hover').boundingBox(), titleHovered = await card.locator('.sf-row-title').boundingBox();
    check(`${height}px: hover actions stay at top, title unaffected`, action.y < title.y && action.y + action.height <= title.y + 1 && JSON.stringify(titleHovered) === JSON.stringify(title));
    await page.mouse.move(1100, 850);
    await page.locator('.harness-sidebar').screenshot({ path: join(screenshotDir, `dense-${height}.png`) });
    console.log(`LAYOUT ${height}: ${JSON.stringify(layout)}`);
  }

  // Banners consume real pane height: category headers must survive that reduction.
  for (const withUndo of [false, true]) {
    if (withUndo) {
      await page.locator('.harness-sidebar').evaluate(el => { el.style.height = '400px'; });
      await page.locator('.sf-section-body').evaluateAll(els => els.forEach(el => { el.scrollTop = 0; }));
      const card = page.locator('[data-session-id="synthetic-active-000"]');
      await card.hover();
      await card.getByRole('button', { name: 'Settle session', exact: true }).click();
      await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
    }
    for (const height of [300, 350, 400]) {
      await page.locator('.harness-sidebar').evaluate((el, height) => { el.style.height = `${height}px`; }, height);
      const geometry = await page.locator('.sf-scroll').evaluate(list => {
        const bounds = list.getBoundingClientRect();
        return {
          fits: list.scrollHeight <= list.clientHeight + 1,
          headers: [...list.querySelectorAll('.sf-section-toggle')].every(el => {
            const r = el.getBoundingClientRect();
            return r.height === 24 && r.top >= bounds.top && r.bottom <= bounds.bottom + 1;
          }),
          bodies: [...list.querySelectorAll('.sf-section-body')].every(el => {
            const r = el.getBoundingClientRect();
            return r.height > 0 && r.top >= bounds.top && r.bottom <= bounds.bottom + 1 && el.scrollHeight > el.clientHeight;
          })
        };
      });
      check(`${height}px${withUndo ? ' with Undo' : ''}: headers and complete scroll bodies fit without outer clipping`, geometry.fits && geometry.headers && geometry.bodies);
    }
  }
  check('no browser page errors', errors.length === 0);
  console.log(`Browser smoke: ${checks.length} checks passed; screenshots ${screenshotDir}/{frontend,actions,dense-400,dense-650}.png`);
} finally { await browser?.close(); server.close(); }
