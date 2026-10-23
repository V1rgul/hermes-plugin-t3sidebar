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
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1, timezoneId: 'Europe/Paris' });
  const noUndo = async () => !await page.getByRole('button', { name: /^(?:Undo|Dismiss undo)$/, includeHidden: true }).count() && !await page.locator('.sf-undo').count();
  const buttonStyle = locator => locator.evaluate(el => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, color: style.color };
  });
  const checkPersistentTrigger = async (label, dialogLabel) => {
    const trigger = page.getByRole('button', { name: label, exact: true });
    await page.mouse.move(1100, 850);
    const normal = await buttonStyle(trigger);
    await trigger.hover();
    const hovered = await buttonStyle(trigger);
    check(`${label} hover uses a visible background and primary text`, hovered.background !== normal.background && await trigger.evaluate(el => {
      const probe = document.createElement('span'); probe.style.color = 'var(--ui-text-primary)'; el.append(probe);
      const primary = getComputedStyle(probe).color; probe.remove();
      return getComputedStyle(el).color === primary;
    }));
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: dialogLabel, exact: true });
    await dialog.waitFor();
    await page.mouse.move(1100, 850);
    check(`${label} retains hover background and primary text while its popover is open`, await trigger.getAttribute('aria-expanded') === 'true' && JSON.stringify(await buttonStyle(trigger)) === JSON.stringify(hovered));
    await dialog.getByRole('button', { name: 'Close session actions', exact: true }).click();
    await page.mouse.move(1100, 850);
    check(`${label} returns to normal after closing its popover`, await trigger.getAttribute('aria-expanded') === 'false' && JSON.stringify(await buttonStyle(trigger)) === JSON.stringify(normal));
  };
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-session-id="approval"]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-session-id="root"]')?.dataset.working === 'true');
  await page.locator('[data-session-id="readme"] .sf-open').focus();
  await page.getByRole('searchbox').click();
  await page.keyboard.type('s');
  check('first typed search character retains keyboard focus and the previous card still matches', await page.getByRole('searchbox').evaluate(el => el === document.activeElement && el.value === 's') && await page.locator('[data-session-id="readme"]').count() === 1);
  await page.keyboard.type('i');
  check('second typed search character filters out the previous card without losing keyboard focus', await page.getByRole('searchbox').evaluate(el => el === document.activeElement && el.value === 'si') && !await page.locator('[data-session-id="readme"]').count());
  await page.keyboard.type('debar');
  check('continued keystrokes remain in search instead of going to a card or composer', await page.getByRole('searchbox').evaluate(el => el === document.activeElement && el.value === 'sidebar'));
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  const removedCard = await page.evaluate(() => window.hermesT3SidebarHarness.control.rows.find(row => row.id === 'readme'));
  await page.locator('[data-session-id="readme"] .sf-open').focus();
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    fixture.control.rows = fixture.control.rows.filter(row => row.id !== 'readme');
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  });
  await page.locator('[data-session-id="readme"]').waitFor({ state: 'detached' });
  check('removal of the actually focused card still recovers keyboard focus to another visible card', await page.evaluate(() => !!document.activeElement?.closest('.sf-row') && !document.activeElement.closest('[data-closed=true]')));
  await page.evaluate(async row => {
    const fixture = window.hermesT3SidebarHarness; fixture.control.rows.push(row);
    fixture.control.rows.find(row => row.id === 'design').provider = null;
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  }, removedCard);
  await page.waitForFunction(() => !document.querySelector('[data-session-id="design"] .sf-provider'));
  check('unknown provider has no question-mark icon or empty provider spacer', !await page.locator('[data-session-id="design"] .sf-provider').count() && await page.locator('[data-session-id="design"] .sf-token').textContent() === '1.5K');
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    fixture.control.rows.find(row => row.id === 'design').provider = 'openai-codex';
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  });
  await page.locator('[data-session-id="design"] [data-provider-mark="openai-codex"]').waitFor();
  check('provider icon appears normally when concrete provider metadata arrives', await page.locator('[data-session-id="design"] .sf-provider').getAttribute('aria-label') === 'Provider: openai-codex');
  for (const section of ['Working', 'Snoozed']) await page.getByRole('button', { name: `${section} (1)`, exact: true }).click();
  await page.reload();
  await page.locator('[data-session-id="approval"]').waitFor();
  check('folded categories survive a full browser reload', await page.locator('[data-section="working"]').getAttribute('data-closed') === 'true' && await page.locator('[data-section="snoozed"]').getAttribute('data-closed') === 'true' && await page.locator('[data-section="archived"]').getAttribute('data-closed') === 'false');
  await page.getByRole('searchbox').fill('Runtime classification');
  await page.locator('[data-session-id="root"]').waitFor();
  check('search temporarily reveals persisted folded category without catch-up text', await page.locator('[data-section="working"]').getAttribute('data-closed') === 'false' && !await page.getByText('All caught up', { exact: true }).count());
  await page.locator('.sf-search input').evaluate(el => el.blur());
  await page.mouse.move(1100, 850);
  check('search clear cross stays visible without hover or focus', await page.getByRole('button', { name: 'Clear search', exact: true }).isVisible() && await page.getByRole('button', { name: 'Clear search', exact: true }).evaluate(el => getComputedStyle(el).opacity === '1'));
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  check('clear cross empties search and returns keyboard focus', await page.getByRole('searchbox').inputValue() === '' && await page.getByRole('searchbox').evaluate(el => el === document.activeElement));
  await page.getByRole('searchbox').fill('Review tomorrow');
  check('search preserves Snoozed fold and its matching count without false empty text', await page.locator('[data-section="snoozed"]').getAttribute('data-closed') === 'true' && await page.getByRole('button', { name: 'Snoozed (1)', exact: true }).getAttribute('aria-expanded') === 'false' && !await page.locator('[data-session-id="snoozed"]').isVisible() && !await page.getByText('No matching sessions', { exact: true }).count());
  await page.getByRole('button', { name: 'Snoozed (1)', exact: true }).click();
  check('matching Snoozed rows can still be opened manually during search', await page.locator('[data-session-id="snoozed"]').isVisible());
  await page.getByRole('button', { name: 'Snoozed (1)', exact: true }).click();
  await page.getByRole('searchbox').fill('');
  await page.locator('[data-session-id="root"]').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Switch mock source', exact: true }).click();
  await page.locator('[data-session-id="root"]').waitFor();
  check('fold preferences do not leak to another source', await page.locator('[data-section="working"]').getAttribute('data-closed') === 'false' && await page.locator('[data-section="snoozed"]').getAttribute('data-closed') === 'false');
  await page.getByRole('button', { name: 'Switch mock source', exact: true }).click();
  await page.locator('[data-session-id="root"]').waitFor({ state: 'hidden' });
  check('reconnecting restores original source fold preferences', await page.locator('[data-section="working"]').getAttribute('data-closed') === 'true' && await page.locator('[data-section="snoozed"]').getAttribute('data-closed') === 'true');
  for (const section of ['Working', 'Snoozed']) await page.getByRole('button', { name: `${section} (1)`, exact: true }).click();
  await page.reload();
  await page.locator('[data-session-id="root"]').waitFor();
  check('explicitly unfolded categories survive another browser reload', await page.locator('[data-section="working"]').getAttribute('data-closed') === 'false' && await page.locator('[data-section="snoozed"]').getAttribute('data-closed') === 'false');
  await page.getByRole('button', { name: 'Archived (1)', exact: true }).click();
  await page.getByRole('searchbox').fill('SDK inventory');
  check('search never unfolds Archived or reports a false no-match', await page.locator('[data-section="archived"]').getAttribute('data-closed') === 'true' && !await page.getByText('No matching sessions', { exact: true }).count() && !await page.locator('[data-session-id="archived"]').isVisible());
  await page.getByRole('button', { name: 'Archived (1)', exact: true }).click();
  check('search still allows explicitly unfolding matching archives', await page.locator('[data-session-id="archived"]').isVisible());
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  check('all five shelves rendered', await page.locator('.sf-section').count() === 5);
  check('Working with one card has no spare vertical space', await page.locator('[data-section="working"]').evaluate(el => el.getBoundingClientRect().height <= 24 + el.querySelectorAll('.sf-row').length * 56 + 1));
  check('waiting approval remains Ready despite archival and pin metadata', await page.locator('section[aria-label="Ready"] [data-session-id="approval"]').count() === 1);
  check('Working is visually dimmed', Number(await page.locator('[data-session-id="root"]').evaluate(el => getComputedStyle(el).opacity)) < 1);
  check('Working card text uses the native blue theme token', await page.locator('[data-session-id="root"] .sf-time').evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'var(--ui-blue)'; el.append(probe);
    const expected = getComputedStyle(probe).color, actual = getComputedStyle(el).color; probe.remove();
    return actual === expected && actual !== getComputedStyle(el.parentElement).color;
  }));
  check('category headings place parenthesized counts and divider before right-aligned chevron', await page.locator('.sf-section-toggle').evaluateAll(headers => headers.every(header => {
    const count = header.querySelector('.sf-count'), line = header.querySelector('.sf-section-line'), chevron = header.querySelector('.sf-section-chevron');
    if (!count || !line || !chevron || !/^\(\d+\)$/.test(count.textContent)) return false;
    const c = count.getBoundingClientRect(), l = line.getBoundingClientRect(), a = chevron.getBoundingClientRect(), h = header.getBoundingClientRect();
    return c.right <= l.left && l.width > 30 && l.right <= a.left && a.right >= h.right - 8 && h.height === 24;
  })));
  check('sidebar project icons have no filled background', await page.locator('.sf-row .sf-project-icon').evaluateAll(icons => icons.every(icon => getComputedStyle(icon).backgroundColor === 'rgba(0, 0, 0, 0)')));
  for (const [id, status, label, token] of [['readme', 'done', 'Done', '--ui-green'], ['approval', 'input', 'Input', '--ui-purple']]) {
    const card = page.locator(`[data-session-id="${id}"]`), badge = card.locator(`.sf-status[data-status="${status}"]`);
    check(`${label} has a leading icon and the requested semantic color`, await badge.evaluate((el, token) => {
      const probe = document.createElement('span'); probe.style.color = `var(${token})`; el.append(probe);
      const color = getComputedStyle(probe).color; probe.remove();
      return el.querySelector('svg') !== null && getComputedStyle(el).color === color;
    }, token));
    check(`${label} is right-aligned after provider/tokens and title is bold`, await card.evaluate(el => {
      const status = el.querySelector('.sf-status').getBoundingClientRect(), tokens = el.querySelector('.sf-token').getBoundingClientRect();
      return status.left >= tokens.right && Number(getComputedStyle(el.querySelector('.sf-row-title')).fontWeight) >= 600;
    }));
  }
  check('project and age contrast increased without brightening provider/tokens', await page.locator('[data-session-id="design"]').evaluate(el => {
    const project = getComputedStyle(el.querySelector('.sf-project-name')).color, time = getComputedStyle(el.querySelector('.sf-time')).color;
    const provider = getComputedStyle(el.querySelector('.sf-provider')).color, tokens = getComputedStyle(el.querySelector('.sf-token')).color;
    return project === time && provider === tokens && project !== tokens;
  }));
  await page.mouse.move(1100, 850);
  check('Input, Working and Done labels are bold', await page.locator('.sf-status').evaluateAll(labels => ['input', 'working', 'done'].every(status => labels.some(el => el.dataset.status === status && Number(getComputedStyle(el).fontWeight) >= 600))));
  const workingOpacity = await page.locator('[data-session-id="root"]').evaluate(el => getComputedStyle(el).opacity);
  for (const id of ['snoozed', 'archived']) {
    const card = page.locator(`[data-session-id="${id}"]`);
    check(`${id} dimmed exactly like Working`, await card.evaluate(el => getComputedStyle(el).opacity) === workingOpacity);
    await card.hover();
    check(`${id} returns to full opacity on hover`, await card.evaluate(el => getComputedStyle(el).opacity) === '1');
    await page.mouse.move(1100, 850);
    check(`${id} dims again when pointer leaves`, await card.evaluate(el => getComputedStyle(el).opacity) === workingOpacity);
  }
  check('external native archive has no plugin metadata; legacy completion remains Ready', await page.evaluate(() => !window.hermesT3SidebarHarness.control.metadata.sessions.archived) && await page.locator('section[aria-label="Archived"] [data-session-id="archived"]').count() === 1 && await page.locator('section[aria-label="Ready"] [data-session-id="legacy"]').count() === 1);
  await mkdir(screenshotDir, { recursive: true });
  const design = page.locator('[data-session-id="design"]');
  const snooze = design.getByRole('button', { name: 'Snooze session', exact: true });
  const archive = design.getByRole('button', { name: 'Archive session', exact: true });
  await page.mouse.move(1100, 850);
  check('Snooze and Archive hidden without hover', !await snooze.isVisible() && !await archive.isVisible());
  await design.locator('.sf-open').focus();
  check('card focus alone does not reveal hover buttons', !await snooze.isVisible() && !await archive.isVisible());
  await design.hover();
  check('hover reveals clock Snooze and labeled Archive', await snooze.isVisible() && await archive.isVisible() && await archive.textContent() === 'Archive');
  await page.screenshot({ path: join(screenshotDir, 'hovered.png'), fullPage: true });
  await snooze.hover();
  const snoozeHoverStyle = await buttonStyle(snooze);
  const rowHoverBackground = await design.evaluate(el => getComputedStyle(el).backgroundColor);
  await snooze.click();
  await page.getByRole('dialog', { name: 'Snooze session', exact: true }).waitFor();
  const snoozeDialog = page.getByRole('dialog', { name: 'Snooze session', exact: true });
  const snoozeAnchor = design.locator('[aria-label="Snooze session"]');
  const anchorBefore = await snoozeAnchor.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  const menuBefore = await snoozeDialog.boundingBox();
  await page.mouse.move(1100, 850);
  const anchorAfter = await snoozeAnchor.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  check('open Snooze retains its measurable anchor after pointer leaves sidebar', JSON.stringify(anchorAfter) === JSON.stringify(anchorBefore) && anchorAfter.width > 0 && anchorAfter.height > 0);
  check('open Snooze stays positioned after pointer leaves sidebar', JSON.stringify(await snoozeDialog.boundingBox()) === JSON.stringify(menuBefore));
  check('open Snooze keeps card actions visible and trigger highlighted after pointer leaves', await snooze.isVisible() && await archive.isVisible() && await snooze.getAttribute('aria-expanded') === 'true' && JSON.stringify(await buttonStyle(snooze)) === JSON.stringify(snoozeHoverStyle) && await design.locator('.sf-hover').evaluate(el => getComputedStyle(el).opacity === '1'));
  check('open Snooze retains row highlight and hides metadata after pointer leaves', await design.getAttribute('data-menu-open') === 'true' && await design.evaluate(el => getComputedStyle(el).backgroundColor) === rowHoverBackground && await design.locator('.sf-provider,.sf-token,.sf-time').evaluateAll(els => els.every(el => getComputedStyle(el).visibility === 'hidden')));
  await design.hover();
  check('Snooze does not jump when pointer re-enters sidebar', JSON.stringify(await snoozeDialog.boundingBox()) === JSON.stringify(menuBefore));
  await snoozeDialog.getByRole('button', { name: 'Close session actions', exact: true }).click();
  await page.mouse.move(1100, 850);
  check('closing Snooze clears row and trigger open state and hides actions', await design.getAttribute('data-menu-open') === 'false' && await snoozeAnchor.getAttribute('aria-expanded') === 'false' && !await snooze.isVisible() && !await archive.isVisible() && await design.locator('.sf-provider,.sf-token,.sf-time').evaluateAll(els => els.every(el => getComputedStyle(el).visibility === 'visible')));
  await design.hover(); await snooze.click();
  check('Snooze menu omits redundant history/agent footer', !await snoozeDialog.innerText().then(text => /History kept|never stops the agent/i.test(text)));
  check('Snooze menu omits bottom chosen-time text button', !await snoozeDialog.getByRole('button', { name: 'Snooze until chosen time', exact: true }).count());
  await page.getByRole('button', { name: 'Snooze · In 1 hour', exact: true }).click();
  await page.locator('section[aria-label="Snoozed"] [data-session-id="design"]').waitFor();
  check('hover Snooze saves the selected time without any Undo toast', await noUndo());
  await design.click({ button: 'right' });
  await page.getByRole('button', { name: 'Restore to Ready', exact: true }).click();
  await page.locator('section[aria-label="Ready"] [data-session-id="design"]').waitFor();
  check('context Restore returns the snoozed session to Ready without any Undo toast', await noUndo());
  await design.click({ button: 'right' });
  await page.getByRole('button', { name: 'Pin', exact: true }).click();
  await page.locator('section[aria-label="Pinned"] [data-session-id="design"]').waitFor();
  check('Pin moves the session to Pinned without any Undo toast', await noUndo());
  await design.click({ button: 'right' });
  await page.getByRole('button', { name: 'Unpin', exact: true }).click();
  await page.locator('section[aria-label="Ready"] [data-session-id="design"]').waitFor();
  check('Unpin returns the session to Ready without any Undo toast', await noUndo());
  await design.hover(); await snooze.click();
  check('Next Monday at 8:00 is the fourth Snooze preset', (await snoozeDialog.getByRole('button', { name: /^Snooze · / }).allTextContents()).length === 4 && await snoozeDialog.getByRole('button', { name: /^Snooze · / }).nth(3).textContent() === 'Snooze · Next Monday at 8:00');
  const expectedMonday = await page.evaluate(() => {
    const monday = new Date();
    monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
    monday.setHours(8, 0, 0, 0);
    return monday.getTime() / 1000;
  });
  const mondayCallStart = await page.evaluate(() => window.hermesT3SidebarHarness.calls.length);
  await snoozeDialog.getByRole('button', { name: 'Snooze · Next Monday at 8:00', exact: true }).click();
  await page.locator('section[aria-label="Snoozed"] [data-session-id="design"]').waitFor();
  check('fourth Snooze preset sends next calendar Monday 08:00 in client local time and lands in Snoozed without a toast', await page.evaluate(({ expectedMonday, mondayCallStart }) => {
    const fixture = window.hermesT3SidebarHarness;
    return fixture.calls.slice(mondayCallStart).some(call => call[0] === 'rest' && call[1] === '/sessions/design' && call[2]?.body?.action === 'snooze' && call[2].body.wake_at === expectedMonday) && fixture.control.metadata.sessions.design.wake_at === expectedMonday;
  }, { expectedMonday, mondayCallStart }) && await noUndo());
  await design.click({ button: 'right' });
  await page.getByRole('button', { name: 'Restore to Ready', exact: true }).click();
  await page.locator('section[aria-label="Ready"] [data-session-id="design"]').waitFor();
  check('restoring the Monday snooze has no Undo toast', await noUndo());
  await design.hover();
  await archive.click();
  await page.locator('section[aria-label="Archived"] [data-session-id="design"]').waitFor();
  check('hover Archive saves without a redundant Undo banner', await noUndo());
  await design.hover(); await design.getByRole('button', { name: 'Unarchive session', exact: true }).click();
  await page.locator('section[aria-label="Ready"] [data-session-id="design"]').waitFor();
  check('hover Unarchive restores Ready without an Undo banner', await noUndo());
  await page.mouse.move(1100, 850);
  check('buttons hide again after pointer leaves', !await snooze.isVisible() && !await archive.isVisible());
  await page.screenshot({ path: join(screenshotDir, 'frontend.png'), fullPage: true });
  await design.click({ button: 'right' });
  await page.getByRole('dialog').waitFor();
  check('actions popover is visible outside sidebar scroll clipping', await page.getByRole('dialog').evaluate(el => { const rect = el.getBoundingClientRect(); return rect.width > 180 && rect.right <= innerWidth && rect.bottom <= innerHeight && el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + 30)); }));
  await page.screenshot({ path: join(screenshotDir, 'actions.png'), fullPage: true });
  const context = page.getByRole('dialog', { name: 'Session actions', exact: true });
  await page.mouse.move(1100, 850);
  check('open row context menu retains row highlight, actions and hidden metadata off hover', await design.getAttribute('data-menu-open') === 'true' && await design.evaluate(el => getComputedStyle(el).backgroundColor) === rowHoverBackground && await snooze.isVisible() && await archive.isVisible() && await design.locator('.sf-provider,.sf-token,.sf-time').evaluateAll(els => els.every(el => getComputedStyle(el).visibility === 'hidden')));
  check('context menu omits archive and snooze actions', !await context.getByRole('button', { name: /^(?:Unarchive|Archive|Snooze)/ }).count());
  check('context menu offers Rename, Copy session ID and row project filter', await context.getByRole('button', { name: 'Rename', exact: true }).count() === 1 && await context.getByRole('button', { name: 'Copy session ID', exact: true }).count() === 1 && await context.getByRole('button', { name: /^Filter by / }).count() === 1);
  check('stored-only Rename is disabled with an explanation', await context.getByRole('button', { name: 'Rename', exact: true }).isDisabled() && /live|runtime/i.test(await context.innerText()));
  await context.getByRole('button', { name: 'Copy session ID', exact: true }).click();
  check('Copy session ID uses the public clipboard with the durable ID', await page.evaluate(() => window.hermesT3SidebarHarness.calls.some(call => call[0] === 'clipboard' && call[1] === 'design')));
  if (!await context.count()) await design.click({ button: 'right' });
  await context.getByRole('button', { name: /^Filter by / }).click();
  check('row project shortcut filters without grouping or changing native workspace', !await page.locator('[data-session-id="readme"]').count() && await page.locator('[data-session-id="design"]').count() === 1 && !await page.locator('.sf-group').count());
  check('active project filter replaces toolbar filter glyph with project icon', await page.getByRole('button', { name: 'Filter sessions', exact: true }).getAttribute('data-filtered') === 'true' && await page.getByRole('button', { name: 'Filter sessions', exact: true }).innerText() === '◇');
  await checkPersistentTrigger('Filter sessions', 'Session filters');
  await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
  const filters = page.getByRole('dialog', { name: 'Session filters', exact: true });
  check('one filter click exposes project choices directly without intermediate select', await filters.getByRole('button', { name: 'All projects', exact: true }).isVisible() && await filters.getByRole('button', { name: 'Filter by docs', exact: true }).isVisible() && !await filters.getByRole('combobox').count());
  check('direct filter list identifies selected project', await filters.getByRole('button', { name: 'Filter by hermes-t3sidebar', exact: true }).getAttribute('aria-pressed') === 'true');
  await filters.getByRole('button', { name: 'All projects', exact: true }).click();
  check('All projects clears active icon and closes filter picker', !await filters.count() && await page.getByRole('button', { name: 'Filter sessions', exact: true }).getAttribute('data-filtered') === 'false');
  await design.hover(); await archive.click();
  await page.locator('section[aria-label="Archived"] [data-session-id="design"]').waitFor();
  check('archival and server-readback rendered without an Undo toast', await noUndo());
  await design.hover(); await design.getByRole('button', { name: 'Unarchive session', exact: true }).click();
  await page.locator('section[aria-label="Ready"] [data-session-id="design"]').waitFor();
  check('Archived list Unarchive restores Ready without an Undo banner', await noUndo());
  await design.hover(); await snooze.click();
  await page.getByRole('button', { name: 'Snooze · In 1 hour', exact: true }).click();
  await page.locator('section[aria-label="Snoozed"] [data-session-id="design"]').waitFor();
  check('direct Snooze control remains available without an Undo toast', await noUndo());
  await page.locator('[data-session-id="design"]').click({ button: 'right' });
  await page.getByRole('button', { name: 'Restore to Ready', exact: true }).click();
  await page.locator('section[aria-label="Ready"] [data-session-id="design"]').waitFor();
  check('context Restore remains available without an Undo toast', await noUndo());
  await page.getByRole('searchbox').fill('release');
  await page.waitForFunction(() => !document.querySelector('[data-session-id="design"]'));
  check('search filters real React rows', await page.locator('[data-session-id="readme"]').count() === 1);
  await page.getByRole('searchbox').fill('no-such-synthetic-session-8917');
  await page.getByText('No matching sessions', { exact: true }).waitFor();
  check('no-match search never displays All caught up', !await page.getByText('All caught up', { exact: true }).count() && !await page.locator('.sf-row').count());
  await page.getByRole('searchbox').fill('');
  await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Filter by docs', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-session-id="design"]'));
  check('project filtering remains available without grouping option', !await page.getByRole('button', { name: 'Group by project' }).count() && !await page.getByRole('button', { name: 'Use flat list' }).count() && !await page.locator('.sf-group').count());
  await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await page.getByRole('button', { name: 'Simulate missing backend' }).click();
  await page.getByText(/Read-only browsing/).waitFor();
  check('missing backend disables mutation but preserves browsing', await page.locator('[data-session-id="design"] [aria-label="Archive session"]').isDisabled());
  await page.getByRole('button', { name: 'Restore mock backend' }).click();
  await page.locator('[data-session-id="design"] [aria-label="Archive session"]').waitFor({ state: 'attached' });

  await page.evaluate(() => { window.hermesT3SidebarHarness.control.dropArchiveWrite = true; });
  await design.hover(); await archive.click();
  await page.getByRole('alert').filter({ hasText: 'did not confirm this native archive change' }).waitFor();
  check('dropped native write stays Ready, reports failed readback, and creates no Undo', await page.locator('section[aria-label="Ready"] [data-session-id="design"]').count() === 1 && await noUndo());
  await page.evaluate(() => { window.hermesT3SidebarHarness.control.dropArchiveWrite = false; });
  await page.getByRole('button', { name: 'Simulate runtime failure' }).click();
  await page.getByText(/Runtime status unavailable/).waitFor();
  check('runtime failure explicitly unknown, native archives remain Archived', await page.locator('section[aria-label="Archived"] [data-session-id="archived"]').count() === 1);
  await page.locator('[data-session-id="archived"]').hover();
  check('native archived Unarchive remains enabled during runtime outage; Snooze absent', !await page.locator('[data-session-id="archived"] [aria-label="Unarchive session"]').isDisabled() && !await page.locator('[data-session-id="archived"] [aria-label="Snooze session"]').count());
  await page.locator('[data-session-id="archived"] [aria-label="Unarchive session"]').click();
  await page.locator('section[aria-label="Ready"] [data-session-id="archived"]').waitFor();
  check('Unarchive during runtime outage has no Undo banner', await noUndo());
  await page.getByRole('button', { name: 'Restore runtime status', exact: true }).click();
  await page.locator('[data-session-id="archived"] [aria-label="Archive session"]').waitFor({ state: 'attached' });
  await page.waitForFunction(() => !document.querySelector('[data-session-id="archived"] [aria-label="Archive session"]').disabled);
  await page.locator('[data-session-id="archived"]').hover();
  await page.locator('[data-session-id="archived"] [aria-label="Archive session"]').click();
  await page.locator('section[aria-label="Archived"] [data-session-id="archived"]').waitFor();
  check('native archival remains available after runtime recovers without an Undo toast', await noUndo());
  check('no user-visible legacy settlement words', !await page.locator('body').innerText().then(text => /\bsettle(?:d)?\b/i.test(text)));
  await checkPersistentTrigger('New session', 'New session project');
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByRole('button', { name: 'New session in Synthetic Sidebar', exact: true }).waitFor();
  check('project picker has no Cancel button', !await page.getByRole('button', { name: 'Cancel', exact: true }).count());
  check('project picker icons have no filled background', await page.locator('.sf-project-choice .sf-project-icon').evaluateAll(icons => icons.length > 0 && icons.every(icon => getComputedStyle(icon).backgroundColor === 'rgba(0, 0, 0, 0)')));
  check('new-session picker omits unsupported Home and its explanatory text', !await page.getByRole('button', { name: 'New session in Home', exact: true }).count() && !await page.getByText(/Home remains listed/).count());
  const projectChoice = page.getByRole('button', { name: 'New session in Synthetic Sidebar', exact: true });
  check('new-session picker renders the native project glyph, not its identifier', await projectChoice.locator('[data-codicon="tools"]').count() === 1 && await projectChoice.textContent() === 'Synthetic Sidebar');
  check('project picker aligns icon before project name', await projectChoice.evaluate(el => {
    const icon = el.querySelector('.sf-project-icon').getBoundingClientRect(), name = el.querySelector('.sf-project-name').getBoundingClientRect();
    return icon.right <= name.left && Math.abs(icon.top + icon.height / 2 - name.top - name.height / 2) < 2;
  }));
  check('project picker does not create a session until a supported project is selected', !await page.evaluate(() => window.hermesT3SidebarHarness.calls.some(call => call[0] === 'requestProfile' && call[2] === 'session.create')));
  await page.getByRole('button', { name: 'New session in Synthetic Sidebar', exact: true }).click();
  await page.waitForFunction(() => window.hermesT3SidebarHarness.control.composerCwd === '/projects/hermes-t3sidebar');
  check('named project public create/open/cwd handoff; no hidden prompt', await page.evaluate(() => {
    const calls = window.hermesT3SidebarHarness.calls;
    const create = calls.find(c => c[0] === 'requestProfile' && c[2] === 'session.create');
    const open = calls.find(c => c[0] === 'open' && c[1] === 'fixture-created');
    return create[3].cwd_explicit && !create[3].close_on_disconnect && open[2].awaitHydration && open[2].expectHistory === false && !calls.some(c => c[0] === 'new' || /prompt/.test(c[2] || ''));
  }));
  check('unsupported Add project button is absent', await page.getByRole('button', { name: 'Add project', exact: true }).count() === 0);
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    fixture.control.metadata.sessions.design = { state: 'active', pinned: false, woke_at: Date.now() / 1000 - 60, updated_at: Date.now() / 1000 - 60 };
    fixture.control.live.push({ id: 'runtime-design', session_key: 'design', status: 'idle', last_active: Date.now() / 1000 });
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  });
  await design.locator('.sf-status[data-status="woke"]').waitFor();
  check('durable wake marker shows orange Woke with icon and bold title', await design.evaluate(el => {
    const badge = el.querySelector('.sf-status'), probe = document.createElement('span'); probe.style.color = 'var(--ui-orange)'; badge.append(probe);
    const expected = getComputedStyle(probe).color; probe.remove();
    return badge.textContent === 'Woke' && badge.querySelector('svg') !== null && getComputedStyle(badge).color === expected && Number(getComputedStyle(el.querySelector('.sf-row-title')).fontWeight) >= 600;
  }));
  await design.locator('.sf-open').click();
  await design.locator('.sf-status[data-status="woke"]').waitFor({ state: 'detached' });
  check('reading acknowledges exact wake marker without a new Undo banner', await page.evaluate(() => window.hermesT3SidebarHarness.control.metadata.sessions.design.woke_at === null) && await noUndo());
  const ageBeforeReopen = await design.locator('.sf-time').textContent();
  await design.locator('.sf-open').click();
  check('opening a thread does not replace its conversation age with runtime resume time', await design.locator('.sf-time').textContent() === ageBeforeReopen && ageBeforeReopen !== 'now');
  await design.click({ button: 'right' });
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByRole('textbox', { name: 'Session title', exact: true }).fill('Renamed sidebar thread');
  check('rename submit is a checkmark beside the field, without Save rename text', await page.getByRole('button', { name: 'Save rename', exact: true }).evaluate(el => {
    const field = el.parentElement.querySelector('input'), button = el.getBoundingClientRect(), input = field.getBoundingClientRect();
    return el.textContent === '' && el.querySelector('svg') !== null && button.left >= input.right && Math.abs(button.top + button.height / 2 - input.top - input.height / 2) < 2;
  }));
  await page.getByRole('button', { name: 'Save rename', exact: true }).click();
  await design.locator('.sf-row-title').filter({ hasText: 'Renamed sidebar thread' }).waitFor();
  check('live-thread Rename saves and exact native title readback renders', await page.evaluate(() => window.hermesT3SidebarHarness.calls.filter(call => call[2] === 'session.title' && call[3].session_id === 'runtime-design').length === 2));
  await page.mouse.move(1100, 850);
  const focusedBackground = await design.evaluate(el => getComputedStyle(el).backgroundColor);
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    fixture.control.drafts = { design: 'SYNTHETIC unsent composer text' };
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar-drafts'] });
  });
  await page.waitForFunction(() => document.querySelector('[data-session-id="design"]')?.dataset.hasDraft === 'true');
  check('focused session with composer text keeps its ordinary selected background', await design.evaluate(el => getComputedStyle(el).backgroundColor) === focusedBackground);
  await page.locator('[data-session-id="readme"] .sf-open').click();
  await page.waitForFunction(() => document.querySelector('[data-session-id="design"]')?.dataset.current === 'false');
  await page.mouse.move(1100, 850);
  check('unfocused unsent composer text gives the card a dim orange background off hover', await design.evaluate(el => {
    const probe = document.createElement('span'); probe.style.backgroundColor = 'color-mix(in srgb,var(--ui-orange) 10%,transparent)'; el.append(probe);
    const expected = getComputedStyle(probe).backgroundColor, actual = getComputedStyle(el).backgroundColor; probe.remove();
    return actual === expected;
  }));
  check('draft query cache retains booleans, never composer text', await page.evaluate(() => window.hermesT3SidebarHarness.queryClient.getQueryCache().findAll({ queryKey: ['hermes-t3sidebar-drafts'] }).every(query => query.state.data === undefined || typeof query.state.data === 'boolean')));
  await design.locator('.sf-open').click();
  await page.mouse.move(1100, 850);
  check('returning to a drafted session immediately removes orange while retaining draft presence', await design.getAttribute('data-has-draft') === 'true' && await design.evaluate(el => getComputedStyle(el).backgroundColor) === focusedBackground);
  await page.evaluate(() => { window.hermesT3SidebarHarness.control.drafts.design = ''; });
  await page.waitForFunction(() => document.querySelector('[data-session-id="design"]')?.dataset.hasDraft === 'false');
  check('focused composer polling still tracks draft clearing without highlighting editor', true);
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    fixture.control.rows.push({ id: 'synthetic-new-empty', title: 'Untitled session', message_count: 0, preview: '', project: null, source: 'desktop' });
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  });
  const empty = page.locator('[data-session-id="synthetic-new-empty"]');
  await empty.waitFor();
  check('confirmed new empty session shows New session without unavailable project or Untitled text', await empty.locator('.sf-row-title').textContent() === 'New session' && !/Project unavailable|Untitled session/i.test(await empty.innerText()) && await empty.locator('.sf-open').getAttribute('aria-label') === 'New session');
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    fixture.control.live.find(row => row.session_key === 'design').running_subagents = 2;
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  });
  await page.locator('[data-section="working"] [data-session-id="design"]').waitFor();
  check('idle parent with running subagents shows blue Working and stays dimmed', await design.getAttribute('data-working') === 'true' && await design.locator('.sf-status').textContent() === 'Working');
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    fixture.control.live.find(row => row.session_key === 'design').running_subagents = 0;
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  });
  await page.locator('[data-section="active"] [data-session-id="design"]').waitFor();
  check('last child completion returns idle parent to Ready without completion-event bookkeeping', await design.getAttribute('data-working') === 'false' && !await design.locator('.sf-status').count());
  await empty.click({ button: 'right' });
  await page.getByRole('button', { name: 'Delete session', exact: true }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete session?', exact: true });
  check('right-click Delete opens a destructive modal naming the empty session before any write', await deleteDialog.isVisible() && /New session.*cannot be undone/i.test(await deleteDialog.innerText()) && await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).getAttribute('data-destructive') === 'true' && !await page.evaluate(() => window.hermesT3SidebarHarness.calls.some(call => call[2] === 'session.mutate')));
  await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  check('cancelling Delete preserves the empty session', await empty.isVisible() && !await deleteDialog.count());
  await empty.click({ button: 'right' }); await page.getByRole('button', { name: 'Delete session', exact: true }).click();
  await page.evaluate(() => { window.hermesT3SidebarHarness.control.dropDelete = true; });
  await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await deleteDialog.getByRole('alert').waitFor();
  check('a dropped Delete leaves the modal open with its verification error', await empty.isVisible() && /still exists/i.test(await deleteDialog.innerText()));
  await page.evaluate(() => { window.hermesT3SidebarHarness.control.dropDelete = false; });
  await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await empty.waitFor({ state: 'detached' }); await deleteDialog.waitFor({ state: 'detached' });
  check('confirmed Delete removes the card only after exact absent readback', await page.evaluate(() => {
    const fixture = window.hermesT3SidebarHarness;
    return !fixture.control.rows.some(row => row.id === 'synthetic-new-empty') && fixture.calls.some(call => call[0] === 'rest' && call[1] === '/sessions/synthetic-new-empty/snapshot');
  }));
  // The server response, not a browser completion event, owns this marker.
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    fixture.control.rows.find(row => row.id === 'readme').unread = false;
    fixture.control.metadata.completions = { readme: { done_token: 'synthetic-server-turn', done_at: Date.now() / 1000 } };
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  });
  const backendDone = page.locator('[data-session-id="readme"]');
  await backendDone.locator('.sf-status[data-status="done"]').waitFor();
  await page.mouse.move(1100, 850);
  check('backend-owned marker displays green Done and bold title without native unread or a client completion event', await backendDone.evaluate(el => {
    const badge = el.querySelector('.sf-status'), probe = document.createElement('span'); probe.style.color = 'var(--ui-green)'; el.append(probe);
    const green = getComputedStyle(probe).color; probe.remove();
    return badge.textContent === 'Done' && getComputedStyle(badge).color === green && Number(getComputedStyle(el.querySelector('.sf-row-title')).fontWeight) >= 600;
  }) && await page.evaluate(() => window.hermesT3SidebarHarness.control.rows.find(row => row.id === 'readme').unread === false));
  await page.screenshot({ path: join(screenshotDir, 'done-backend-marker.png'), fullPage: true });
  await backendDone.locator('.sf-open').click();
  await backendDone.locator('.sf-status').waitFor({ state: 'detached' });
  check('opening Done acknowledges the exact shared backend generation and creates no Undo', await page.evaluate(() => {
    const fixture = window.hermesT3SidebarHarness;
    return !fixture.control.metadata.completions.readme && fixture.calls.some(call => call[0] === 'rest' && call[1] === '/sessions/readme' && call[2]?.body?.action === 'ack_done' && call[2].body.done_token === 'synthetic-server-turn');
  }) && await noUndo());
  // Exercise the real Archived pagination control without expanding active history.
  await page.evaluate(() => window.hermesT3SidebarHarness.loadArchivePaginationFixtures());
  await page.locator('[data-session-id="synthetic-page-active-0"]').waitFor();
  await page.getByRole('button', { name: 'Archived (500)', exact: true }).waitFor();
  check('500 loaded archives retain their logical count without mounting 500 cards', await page.locator('[data-section="archived"] .sf-row').count() > 0 && await page.locator('[data-section="archived"] .sf-row').count() < 30);
  for (const motion of ['reduce', 'no-preference']) {
    await page.emulateMedia({ reducedMotion: motion });
    await page.getByRole('button', { name: 'Archived (500)', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-section="archived"]')?.dataset.closed === 'true');
    check(`500-archive ${motion} fold keeps body inert and mounted rows bounded`, await page.locator('[data-section="archived"] .sf-section-body').evaluate(el => el.inert) && await page.locator('[data-section="archived"] .sf-row').count() < 30);
    await page.getByRole('button', { name: 'Archived (500)', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-section="archived"]')?.dataset.closed === 'false');
    await page.waitForFunction(() => document.querySelector('[data-section="archived"] .sf-section-body')?.clientHeight > 100);
    check(`500-archive ${motion} reopen preserves bounded rows and restores its body`, !await page.locator('[data-section="archived"] .sf-section-body').evaluate(el => el.inert) && await page.locator('[data-section="archived"] .sf-row').count() < 30);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const lastLoadedArchive = await page.evaluate(() => window.hermesT3SidebarHarness.control.extra.slice(0, 500).map(row => row.id).sort((a, b) => a.localeCompare(b)).at(-1));
  await page.locator('[data-session-id="synthetic-page-active-0"] .sf-open').focus();
  await page.keyboard.press('End');
  await page.waitForFunction(id => document.activeElement?.closest('[data-session-id]')?.dataset.sessionId === id, lastLoadedArchive);
  check('End reaches an unmounted archive through full logical ordering', await page.locator('[data-section="archived"] .sf-row').count() < 30 && await page.locator('[data-section="archived"] .sf-section-body').evaluate(el => el.scrollTop > 0));
  await page.keyboard.press('Home');
  await page.waitForFunction(() => document.activeElement?.closest('[data-session-id]')?.dataset.sessionId === 'synthetic-page-active-0');
  check('Home returns from a virtual archive to the first Ready card', await page.locator('[data-section="active"] .sf-section-body').evaluate(el => el.scrollTop === 0));
  await page.getByRole('button', { name: 'Browse older archives', exact: true }).click();
  await page.getByRole('button', { name: 'Archived (501)', exact: true }).waitFor();
  await page.getByRole('searchbox').fill('archive page 500');
  await page.locator('[data-session-id="synthetic-page-archive-500"]').waitFor({ state: 'attached' });
  check('501st archive loads rich metadata independently of older active history', !await page.locator('[data-session-id="synthetic-page-active-500"]').count() && await page.locator('[data-session-id="synthetic-page-archive-500"] .sf-project-name').textContent() === 'Archive pagination');
  await page.getByRole('searchbox').fill('archive page 500');
  const oldArchive = page.locator('[data-session-id="synthetic-page-archive-500"]');
  await oldArchive.hover(); await oldArchive.getByRole('button', { name: 'Unarchive session', exact: true }).click();
  await page.locator('section[aria-label="Ready"] [data-session-id="synthetic-page-archive-500"]').waitFor();
  await oldArchive.hover(); await oldArchive.getByRole('button', { name: 'Archive session', exact: true }).click();
  await page.locator('section[aria-label="Archived"] [data-session-id="synthetic-page-archive-500"]').waitFor();
  check('501st archive Unarchive and rearchive re-read both shelves without banners', await noUndo());
  // Reset into large labeled synthetic data, never a live history.
  await page.evaluate(() => window.hermesT3SidebarHarness.loadDenseFixtures());
  await page.locator('[data-session-id="synthetic-active-000"]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-session-id="synthetic-working-000"]')?.dataset.working === 'true');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const motion = await page.evaluate(async () => {
    const section = document.querySelector('[data-section="archived"]'), toggle = section.querySelector('.sf-section-toggle');
    const before = section.getBoundingClientRect().height, samples = [];
    toggle.click();
    const start = performance.now();
    while (performance.now() - start < 320) { await new Promise(requestAnimationFrame); samples.push(section.getBoundingClientRect().height); }
    const closed = section.getBoundingClientRect().height, inert = section.querySelector('.sf-section-body').inert;
    toggle.click();
    const reopened = [];
    const opening = performance.now();
    while (performance.now() - opening < 320) { await new Promise(requestAnimationFrame); reopened.push(section.getBoundingClientRect().height); }
    return { before, closed, inert, closingIntermediate: samples.some(h => h > 25 && h < before - 1), openingIntermediate: reopened.some(h => h > 25 && h < before - 1), final: section.getBoundingClientRect().height };
  });
  check('fold and unfold animate real category height, not just the chevron', motion.closingIntermediate && motion.openingIntermediate && Math.abs(motion.closed - 24) < 1 && Math.abs(motion.final - motion.before) < 1 && motion.inert);
  const rapid = await page.evaluate(async () => {
    const section = document.querySelector('[data-section="archived"]'), toggle = section.querySelector('.sf-section-toggle');
    toggle.click(); await new Promise(requestAnimationFrame); toggle.click();
    const start = performance.now(); while (performance.now() - start < 320) await new Promise(requestAnimationFrame);
    return section.dataset.closed === 'false' && !section.querySelector('.sf-section-body').inert && section.getBoundingClientRect().height > 24;
  });
  check('rapid folding reversal settles expanded without inert or stuck content', rapid);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  check('reduced-motion disables category height transitions', await page.locator('.sf-scroll').evaluate(el => getComputedStyle(el).transitionDuration === '0s'));
  for (const height of [400, 650]) {
    await page.locator('.harness-sidebar').evaluate((el, height) => { el.style.height = `${height}px`; }, height);
    await page.mouse.move(1100, 850);
    const layout = await page.locator('.sf').evaluate(el => {
      const rect = e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
      const scroll = el.querySelector('.sf-scroll');
      return { root: rect(el), list: rect(scroll), overflow: getComputedStyle(scroll).overflowY, listScrollHeight: scroll.scrollHeight, listHeight: scroll.clientHeight,
        toolbar: [...el.querySelector('.sf-header').children].map(rect), sections: [...el.querySelectorAll('.sf-section')].map(s => ({ name: s.dataset.section, rect: rect(s), header: s.querySelector('.sf-section-toggle') ? rect(s.querySelector('.sf-section-toggle')) : null, body: rect(s.querySelector('.sf-section-body')), scrollHeight: s.querySelector('.sf-section-body').scrollHeight, count: s.querySelectorAll('.sf-row').length })) };
    });
    check(`${height}px: logical Ready rows use a bounded viewport while small priority shelves retain all 20 rows`, layout.sections.find(s => s.name === 'active').count > 0 && layout.sections.find(s => s.name === 'active').count < 30 && layout.sections.filter(s => s.name !== 'active').every(s => s.count === 20));
    check(`${height}px: Pinned before headerless Ready, secondary headings fixed and visible`, layout.sections.map(s => s.name).join(',') === 'pinned,active,working,snoozed,archived' && layout.sections.slice(0, 2).every(s => !s.header) && layout.sections.slice(2).every(s => s.header.height === 24 && s.header.top >= layout.list.top && s.header.bottom <= layout.root.bottom && s.body.top >= s.header.bottom));
    check(`${height}px: no whole-list scrolling; all five bodies constrained`, layout.overflow === 'hidden' && layout.listScrollHeight <= layout.listHeight + 1 && layout.sections.every(s => s.body.height > 0 && s.body.bottom <= layout.list.bottom + 1 && s.scrollHeight > s.body.height));
    check(`${height}px: expanded Archived gets a substantially larger share`, layout.sections.find(s => s.name === 'archived').rect.height > layout.list.height * .35 && layout.sections.filter(s => s.name !== 'archived').every(s => s.body.height > 0));
    check(`${height}px: toolbar single line and Search left of Filter and New session`, layout.toolbar.length === 3 && layout.toolbar.every(r => Math.abs((r.top + r.bottom) / 2 - (layout.toolbar[0].top + layout.toolbar[0].bottom) / 2) < 2) && layout.toolbar.every((r, i, arr) => !i || arr[i-1].right <= r.left));
    // Scroll each body in turn: every other category's scrollTop AND geometry stay fixed.
    for (const section of ['pinned', 'active', 'working', 'snoozed', 'archived']) {
      await page.locator('.sf-section-body').evaluateAll(els => els.forEach(el => { el.scrollTop = 0; }));
      const before = await page.locator('.sf-section-body').evaluateAll(els => els.map(el => ({ top: el.getBoundingClientRect().top, scroll: el.scrollTop })));
      const body = page.locator(`[data-section="${section}"] .sf-section-body`);
      await body.hover(); await page.mouse.wheel(0, 280);
      await page.waitForFunction(section => document.querySelector(`[data-section="${section}"] .sf-section-body`).scrollTop > 0, section);
      const after = await page.locator('.sf-section-body').evaluateAll(els => els.map(el => ({ top: el.getBoundingClientRect().top, scroll: el.scrollTop })));
      const index = ['pinned', 'active', 'working', 'snoozed', 'archived'].indexOf(section);
      check(`${height}px: ${section} wheel scroll isolated`, after[index].scroll > 0 && after.every((r, i) => Math.abs(r.top - before[i].top) < 1 && (i === index || r.scroll === before[i].scroll)));
    }
    await page.locator('.sf-section-body').evaluateAll(els => els.forEach(el => { el.scrollTop = 0; }));
    const first = page.locator('[data-session-id="synthetic-active-000"] .sf-open');
    await first.focus();
    for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown');
    check(`${height}px: keyboard navigation scrolls only owning Ready body`, await page.locator('.sf-section-body').evaluateAll(els => els.every(el => el.closest('[data-section]').dataset.section === 'active' ? el.scrollTop > 0 : el.scrollTop === 0)));
    const readyScroll = await page.locator('[data-section="active"] .sf-section-body').evaluate(el => el.scrollTop);
    await page.keyboard.press('End');
    check(`${height}px: keyboard cross-category End scrolls only destination Archived`, await page.locator('.sf-section-body').evaluateAll((els, readyScroll) => els.every(el => {
      const section = el.closest('[data-section]').dataset.section;
      return section === 'archived' ? el.scrollTop > 0 : section === 'active' ? el.scrollTop === readyScroll : el.scrollTop === 0;
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

  for (const count of [0, 1, 2]) {
    await page.locator('.harness-sidebar').evaluate(el => { el.style.height = '1800px'; });
    await page.evaluate(async count => {
      const fixture = window.hermesT3SidebarHarness; fixture.loadDenseFixtures();
      fixture.control.rows = fixture.control.rows.filter(row => !row.id.startsWith('synthetic-pinned-') || Number(row.id.slice(-3)) < count);
      fixture.switchScope(`sparse-pinned-${count}`);
      await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
    }, count);
    await page.waitForFunction(count => (document.querySelector('[data-section="pinned"]')?.querySelectorAll('.sf-row').length || 0) === count, count);
    if (!count) check('empty Pinned reserves no grid space and Ready starts at the top', !await page.locator('[data-section="pinned"]').count() && await page.locator('.sf-scroll').evaluate(list => Math.abs(list.getBoundingClientRect().top - list.querySelector('[data-section="active"]').getBoundingClientRect().top) <= 1));
    else check(`Pinned with ${count} cards shrinks to content without blank space`, await page.locator('[data-section="pinned"]').evaluate((el, count) => Math.abs(el.getBoundingClientRect().height - count * 56) <= 1 && Math.abs(el.nextElementSibling.getBoundingClientRect().top - el.getBoundingClientRect().bottom - 1) <= 1, count));
  }

  for (const count of [0, 1, 2]) {
    await page.locator('.harness-sidebar').evaluate(el => { el.style.height = '1000px'; });
    await page.evaluate(async count => {
      const fixture = window.hermesT3SidebarHarness; fixture.loadDenseFixtures();
      fixture.control.rows = fixture.control.rows.filter(row => !row.id.startsWith('synthetic-working-') || Number(row.id.slice(-3)) < count);
      const ids = new Set(fixture.control.rows.map(row => row.id));
      fixture.control.live = fixture.control.live.filter(row => ids.has(row.session_key));
      fixture.switchScope(`sparse-working-${count}`);
      await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
    }, count);
    await page.waitForFunction(count => document.querySelector('[data-section="working"]')?.querySelectorAll('.sf-row').length === count, count);
    check(`Working with ${count} cards shrinks to content without blank space`, await page.locator('[data-section="working"]').evaluate((el, count) => Math.abs(el.getBoundingClientRect().height - (24 + count * 56)) <= 1, count));
  }
  await page.evaluate(() => window.hermesT3SidebarHarness.loadDenseFixtures());
  await page.waitForFunction(() => document.querySelector('[data-section="working"]')?.querySelectorAll('.sf-row').length === 20);
  // Errors consume real pane height: category headers must survive that reduction.
  for (const banner of ['none', 'error']) {
    if (banner === 'error') {
      await page.evaluate(() => { window.hermesT3SidebarHarness.control.archiveError = true; });
      const card = page.locator('[data-session-id="synthetic-active-001"]');
      await card.hover();
      await card.getByRole('button', { name: 'Archive session', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'fixture archive RPC unavailable' }).waitFor();
      await page.evaluate(() => { window.hermesT3SidebarHarness.control.archiveError = false; });
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
      check(`${height}px${banner === 'error' ? ' with error' : ''}: headers and complete scroll bodies fit without outer clipping`, geometry.fits && geometry.headers && geometry.bodies);
      check(`${height}px ${banner}: no Undo or dismiss-Undo controls`, await noUndo());
      if (height === 300 && banner === 'error') await page.locator('.harness-sidebar').screenshot({ path: join(screenshotDir, 'short-300-error.png') });
    }
  }
  check('no browser page errors', errors.length === 0);
  console.log(`Browser smoke: ${checks.length} checks passed; screenshots ${screenshotDir}/{frontend,hovered,actions,dense-400,dense-650,short-300-error}.png`);
} finally { await browser?.close(); server.close(); }
