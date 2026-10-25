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
  const deleteIsRed = locator => locator.evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'var(--ui-red)'; el.append(probe);
    const red = getComputedStyle(probe).color; probe.remove();
    const label = el.querySelector('.sf-menu-label'), icon = el.querySelector('.sf-menu-icon svg');
    return !!label && !!icon && el.getAttribute('data-destructive') === 'true' && getComputedStyle(el).color === red && getComputedStyle(label).color === red && getComputedStyle(icon).color === red && getComputedStyle(icon).stroke === red;
  });
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
  check('unknown provider has no question-mark icon or empty provider spacer', !await page.locator('[data-session-id="design"] .sf-provider').count() && await page.locator('[data-session-id="design"] .sf-token').textContent() === '2K');
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
  const customTimeAligned = () => snoozeDialog.locator('form').evaluate(form => {
    const icon = form.querySelector('.sf-menu-icon').getBoundingClientRect();
    const custom = form.querySelector('.sf-custom-snooze');
    const label = document.createRange(); label.selectNodeContents(custom.firstChild);
    const input = custom.querySelector('input').getBoundingClientRect();
    return Math.abs(label.getBoundingClientRect().left - icon.left) < 1 && Math.abs(input.left - icon.left) < 1;
  });
  check('custom local-time label and input align with preset action icons', await customTimeAligned());
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
  await page.getByRole('button', { name: 'In 1 hour', exact: true }).click();
  await page.locator('section[aria-label="Snoozed"] [data-session-id="design"]').waitFor();
  check('hover Snooze saves the selected time without any Undo toast', await noUndo());
  await design.click({ button: 'right' });
  check('snoozed context menu omits the redundant restore action', !await page.getByRole('button', { name: /^(Restore to Ready|Return to ready|Unsnooze)$/ }).count());
  await page.getByRole('button', { name: 'Close session actions', exact: true }).click();
  await design.hover(); await snooze.click();
  await snoozeDialog.getByRole('button', { name: 'Unsnooze', exact: true }).click();
  await page.locator('section[aria-label="Ready"] [data-session-id="design"]').waitFor();
  check('Snooze menu Unsnooze returns the snoozed session to Ready without any Undo toast', await noUndo());
  const worker = page.locator('[data-session-id="root"]');
  await worker.click({ button: 'right' });
  const disabledDelete = page.getByRole('button', { name: 'Delete session', exact: true });
  check('working session Delete remains disabled and has a leading icon', await disabledDelete.isDisabled() && await disabledDelete.locator('.sf-menu-icon svg').count() === 1);
  check('disabled Delete icon and text retain the red theme color and dimming', await deleteIsRed(disabledDelete) && await disabledDelete.evaluate(el => Number(getComputedStyle(el).opacity) < 1));
  await page.getByRole('button', { name: 'Pin', exact: true }).click();
  await page.locator('section[aria-label="Pinned"] [data-session-id="root"]').waitFor();
  await page.mouse.move(1100, 850);
  check('pinning a running session keeps it Pinned with undimmed blue Working status', await worker.evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'var(--ui-blue)'; el.append(probe);
    const blue = getComputedStyle(probe).color; probe.remove();
    return el.dataset.working === 'true' && el.dataset.dimmed === 'false' && getComputedStyle(el).opacity === '1' && el.querySelector('[data-status=working]')?.textContent === 'Working' && getComputedStyle(el.querySelector('.sf-time')).color === blue;
  }));
  await worker.click({ button: 'right' });
  check('Unpin has a leading decorative icon', await page.getByRole('button', { name: 'Unpin', exact: true }).locator('.sf-menu-icon[aria-hidden=true] svg').count() === 1);
  await page.getByRole('button', { name: 'Unpin', exact: true }).click();
  await page.locator('section[aria-label="Working"] [data-session-id="root"]').waitFor();
  check('unpinning a running session restores the Working shelf', await worker.getAttribute('data-dimmed') === 'true');
  await worker.hover();
  check('working session can Snooze while Archive stays disabled', await worker.getByRole('button', { name: 'Snooze session', exact: true }).isEnabled() && await worker.getByRole('button', { name: 'Archive session', exact: true }).isDisabled());
  await worker.getByRole('button', { name: 'Snooze session', exact: true }).click();
  check('working Snooze presets and custom time are enabled', await snoozeDialog.getByRole('button', { name: 'In 1 hour', exact: true }).isEnabled() && await snoozeDialog.locator('input[type=datetime-local]').isEnabled());
  await snoozeDialog.getByRole('button', { name: 'In 1 hour', exact: true }).click();
  await page.locator('section[aria-label="Snoozed"] [data-session-id="root"]').waitFor();
  await page.mouse.move(1100, 850);
  check('snoozed worker shows remaining time in non-bold theme blue instead of Working or age', await worker.locator('.sf-time').evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'var(--ui-blue)'; el.append(probe);
    const blue = getComputedStyle(probe).color; probe.remove();
    return el.textContent === '1h' && !el.querySelector('.sf-status') && getComputedStyle(el).color === blue && getComputedStyle(el).fontWeight === '400' && getComputedStyle(el).visibility === 'visible';
  }));
  check('blue snooze icon is left of the rounded duration, with no left suffix', await worker.locator('.sf-snooze-time').evaluate(el => {
    const icon = el.querySelector('svg'), duration = el.querySelector('.sf-snooze-duration');
    const i = icon.getBoundingClientRect(), d = duration.getBoundingClientRect(), style = getComputedStyle(el);
    return el.firstElementChild === icon && icon.getAttribute('aria-hidden') === 'true' && getComputedStyle(icon).color === style.color && getComputedStyle(icon).stroke === style.color && getComputedStyle(duration).color === style.color && i.width === 13 && i.right < d.left && Math.abs(i.top + i.height / 2 - d.top - d.height / 2) < 1 && /^\d+[mhd]$/.test(duration.textContent);
  }));
  check('session-card project icon/name gap is compact at 4px', await worker.locator('.sf-project').evaluate(el => getComputedStyle(el).columnGap === '4px'));
  check('snooze does not stop or alter the live worker', await page.evaluate(() => window.hermesT3SidebarHarness.control.live.find(item => item.id === 'runtime-worker').status === 'working'));
  await worker.hover(); await worker.getByRole('button', { name: 'Snooze session', exact: true }).click();
  const unsnooze = snoozeDialog.getByRole('button', { name: 'Unsnooze', exact: true });
  check('Unsnooze is the first enabled Snooze menu action and uses theme green', await snoozeDialog.locator('form > button:not(:disabled)').first().textContent() === 'Unsnooze' && await unsnooze.evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'var(--ui-green)'; el.append(probe);
    const green = getComputedStyle(probe).color; probe.remove();
    return getComputedStyle(el).color === green;
  }));
  check('snoozed menu starts with one disabled blue info row before Unsnooze', await snoozeDialog.locator('form').evaluate(form => {
    const [info, unsnooze] = form.children;
    const probe = document.createElement('span'); probe.style.color = 'var(--ui-blue)'; form.append(probe);
    const blue = getComputedStyle(probe).color; probe.remove();
    return info.disabled && /^\d+d \d+h \d+min left$/.test(info.querySelector('.sf-snooze-remaining').textContent) && unsnooze.textContent === 'Unsnooze' && getComputedStyle(info).color === blue && getComputedStyle(info).opacity === '1';
  }));
  check('wake date uses local short date and time separated by a space, without a comma', await snoozeDialog.locator('.sf-snooze-date').textContent() === await page.evaluate(() => {
    const date = new Date(window.hermesT3SidebarHarness.control.metadata.sessions.root.wake_at * 1000);
    return `${new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(date)} ${new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(date)}`;
  }));
  check('date/time and remaining time share a line, with remaining time aligned to the right content edge', await snoozeDialog.locator('.sf-snooze-info').evaluate(el => {
    const date = el.querySelector('.sf-snooze-date').getBoundingClientRect(), remaining = el.querySelector('.sf-snooze-remaining').getBoundingClientRect();
    const r = el.getBoundingClientRect(), style = getComputedStyle(el);
    return Math.abs(date.top - remaining.top) < 1 && date.right < remaining.left && Math.abs(remaining.right - r.right + parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth)) < 1 && el.scrollWidth <= el.clientWidth;
  }));
  check('custom local-time label and input also align with icons in an existing snooze menu', await customTimeAligned());
  await snoozeDialog.screenshot({ path: join(screenshotDir, 'snoozed-menu.png') });
  check('Snooze actions use discard, Clock, Clock, Sun and calendar as aligned leading icons', await snoozeDialog.locator('.sf-menu-action').evaluateAll(actions => {
    const names = actions.map(el => el.querySelector('[data-codicon]')?.dataset.codicon || el.querySelector('[data-icon]')?.dataset.icon);
    return JSON.stringify(names) === JSON.stringify(['discard', 'Clock', 'Clock', 'Sun', 'calendar']) && actions.every(el => {
      const icon = el.querySelector('.sf-menu-icon'), label = el.querySelector('.sf-menu-label');
      const i = icon.getBoundingClientRect(), l = label.getBoundingClientRect();
      return el.firstElementChild === icon && icon.getAttribute('aria-hidden') === 'true' && i.width === 14 && i.right < l.left && Math.abs(i.top + i.height / 2 - l.top - l.height / 2) < 1;
    });
  }));
  check('combined disabled snooze information row remains completely icon-free', await snoozeDialog.locator('.sf-snooze-info').evaluateAll(rows => rows.length === 1 && rows.every(el => el.disabled && !el.querySelector('.sf-menu-icon,svg,[data-codicon]'))));
  check('Unsnooze discard icon inherits the green action color', await unsnooze.evaluate(el => getComputedStyle(el.querySelector('[data-codicon=discard]')).color === getComputedStyle(el).color));
  await unsnooze.hover();
  check('Unsnooze stays green on hover', await unsnooze.evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'var(--ui-green)'; el.append(probe);
    const green = getComputedStyle(probe).color; probe.remove(); return getComputedStyle(el).color === green;
  }));
  await unsnooze.click();
  await page.locator('section[aria-label="Working"] [data-session-id="root"]').waitFor();
  check('Unsnooze returns the running card to Working and removes its countdown', await worker.locator('[data-status=working]').textContent() === 'Working' && !await worker.locator('.sf-snooze-time').count());
  await design.click({ button: 'right' });
  await page.getByRole('button', { name: 'Pin', exact: true }).click();
  await page.locator('section[aria-label="Pinned"] [data-session-id="design"]').waitFor();
  check('Pin moves the session to Pinned without any Undo toast', await noUndo());
  await design.hover(); await snooze.click();
  await page.getByRole('button', { name: 'In 1 hour', exact: true }).click();
  await page.locator('section[aria-label="Snoozed"] [data-session-id="design"]').waitFor();
  check('snoozing a pinned session wins without clearing its pin', await design.locator('.sf-pin').count() === 1);
  await design.hover(); await snooze.click();
  await snoozeDialog.getByRole('button', { name: 'Unsnooze', exact: true }).click();
  await page.locator('section[aria-label="Pinned"] [data-session-id="design"]').waitFor();
  check('restoring a pinned snooze returns to Pinned', await design.locator('.sf-pin').count() === 1);
  await design.click({ button: 'right' });
  await page.getByRole('button', { name: 'Unpin', exact: true }).click();
  await page.locator('section[aria-label="Ready"] [data-session-id="design"]').waitFor();
  check('Unpin returns the session to Ready without any Undo toast', await noUndo());
  await design.hover(); await snooze.click();
  check('Next Monday at 9:00 is the fourth preset, without redundant Snooze prefixes', JSON.stringify(await snoozeDialog.locator('form > button').allTextContents()) === JSON.stringify(['In 1 hour', 'In 3 hours', 'Tomorrow at 9:00', 'Next Monday at 9:00']) && !/Custom snooze/.test(await snoozeDialog.innerText()));
  const expectedMonday = await page.evaluate(() => {
    const monday = new Date();
    monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
    monday.setHours(9, 0, 0, 0);
    return monday.getTime() / 1000;
  });
  const mondayCallStart = await page.evaluate(() => window.hermesT3SidebarHarness.calls.length);
  await snoozeDialog.getByRole('button', { name: 'Next Monday at 9:00', exact: true }).click();
  await page.locator('section[aria-label="Snoozed"] [data-session-id="design"]').waitFor();
  check('fourth Snooze preset sends next calendar Monday 09:00 in client local time and lands in Snoozed without a toast', await page.evaluate(({ expectedMonday, mondayCallStart }) => {
    const fixture = window.hermesT3SidebarHarness;
    return fixture.calls.slice(mondayCallStart).some(call => call[0] === 'rest' && call[1] === '/sessions/design' && call[2]?.body?.action === 'snooze' && call[2].body.wake_at === expectedMonday) && fixture.control.metadata.sessions.design.wake_at === expectedMonday;
  }, { expectedMonday, mondayCallStart }) && await noUndo());
  await design.hover(); await snooze.click();
  await snoozeDialog.getByRole('button', { name: 'Unsnooze', exact: true }).click();
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
  check('context menu offers Rename, Copy session ID and Project last instead of the old filter action', await context.getByRole('button', { name: 'Rename', exact: true }).count() === 1 && await context.getByRole('button', { name: 'Copy session ID', exact: true }).count() === 1 && !await context.getByRole('button', { name: /^Filter by / }).count() && await context.locator('.sf-menu-action').last().getAttribute('aria-label') === 'Project');
  check('each context action aligns a decorative icon before its text', await context.locator('.sf-menu-action').evaluateAll(actions => actions.length === 6 && actions.every(action => {
    const icon = action.querySelector('.sf-menu-icon'), label = action.querySelector('.sf-menu-label');
    if (!icon?.querySelector('svg') || !label || icon.getAttribute('aria-hidden') !== 'true' || action.firstElementChild !== icon) return false;
    const i = icon.getBoundingClientRect(), l = label.getBoundingClientRect();
    return i.width === 14 && i.right < l.left && Math.abs(i.top + i.height / 2 - l.top - l.height / 2) < 1;
  })));
  const menuDelete = context.getByRole('button', { name: 'Delete session', exact: true });
  check('Delete icon and text use the red theme color', await deleteIsRed(menuDelete));
  await menuDelete.hover();
  check('Delete icon and text remain red on hover', await deleteIsRed(menuDelete));
  await menuDelete.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  check('Delete retains red text/icon and focus indication under keyboard focus', await menuDelete.evaluate(el => el === document.activeElement && el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none') && await deleteIsRed(menuDelete));
  await context.locator('.sf-menu').evaluate(el => el.style.setProperty('--ui-red', '#d72b46'));
  check('Delete icon and text follow changes to the red theme token', await deleteIsRed(menuDelete));
  await context.locator('.sf-menu').evaluate(el => el.style.removeProperty('--ui-red'));
  await page.mouse.move(1100, 850);
  check('stored-only Rename is disabled with an explanation', await context.getByRole('button', { name: 'Rename', exact: true }).isDisabled() && /live|runtime/i.test(await context.innerText()));
  await context.getByRole('button', { name: 'Copy session ID', exact: true }).click();
  check('Copy session ID uses the public clipboard with the durable ID', await page.evaluate(() => window.hermesT3SidebarHarness.calls.some(call => call[0] === 'clipboard' && call[1] === 'design')));
  if (!await context.count()) await design.click({ button: 'right' });
  await context.getByRole('button', { name: 'Project', exact: true }).click();
  const projectMenu = page.getByRole('dialog', { name: 'Project actions', exact: true });
  await projectMenu.waitFor();
  check('Project submenu keeps leading icons on Rename, Copy path and Filter for', await projectMenu.locator('.sf-menu-action').evaluateAll(actions => actions.slice(0, 3).map(action => action.querySelector('.sf-menu-label').textContent).join('|') === 'Rename|Copy path|Filter for' && actions.slice(0, 3).every(action => action.firstElementChild.className === 'sf-menu-icon' && action.firstElementChild.querySelector('svg'))));
  check('Project submenu includes all 48 approved colors and 64 categorized icons', await projectMenu.getByRole('group', { name: 'Project color' }).getByRole('button').count() === 49 && await projectMenu.locator('.sf-project-icons button').count() === 64);
  check('Project submenu is visible and fits the viewport', await projectMenu.evaluate(el => { const rect = el.getBoundingClientRect(); return rect.right <= innerWidth && rect.bottom <= innerHeight && rect.top >= 0 && rect.height > 300; }));
  await projectMenu.getByRole('button', { name: 'Copy path', exact: true }).click();
  check('Project Copy path uses the public clipboard', await page.evaluate(() => window.hermesT3SidebarHarness.calls.some(call => call[0] === 'clipboard' && call[1] === '/projects/hermes-t3sidebar')));
  await design.click({ button: 'right' });
  await context.getByRole('button', { name: 'Project', exact: true }).click();
  await projectMenu.getByRole('button', { name: 'Filter for', exact: true }).click();
  check('row project shortcut filters without grouping or changing native workspace', !await page.locator('[data-session-id="readme"]').count() && await page.locator('[data-session-id="design"]').count() === 1 && !await page.locator('.sf-group').count());
  check('active project filter replaces toolbar filter glyph with project icon', await page.getByRole('button', { name: 'Filter sessions', exact: true }).getAttribute('data-filtered') === 'true' && await page.getByRole('button', { name: 'Filter sessions', exact: true }).innerText() === '◇');
  await checkPersistentTrigger('Filter sessions', 'Session filters');
  await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
  const filters = page.getByRole('dialog', { name: 'Session filters', exact: true });
  await filters.getByRole('button', { name: 'Filter by docs', exact: true }).waitFor();
  check('one filter click exposes project choices directly without intermediate select', await filters.getByRole('button', { name: 'All projects', exact: true }).isVisible() && await filters.getByRole('button', { name: 'Filter by docs', exact: true }).isVisible() && !await filters.getByRole('combobox').count());
  check('direct filter list identifies selected project', await filters.getByRole('button', { name: 'Filter by Synthetic Sidebar', exact: true }).getAttribute('aria-pressed') === 'true');
  await filters.getByRole('button', { name: 'All projects', exact: true }).click();
  check('All projects clears active icon and closes filter picker', !await filters.count() && await page.getByRole('button', { name: 'Filter sessions', exact: true }).getAttribute('data-filtered') === 'false');
  const openProject = async () => { await design.click({ button: 'right' }); await context.getByRole('button', { name: 'Project', exact: true }).click(); await projectMenu.waitFor(); };
  await openProject();
  await projectMenu.getByRole('button', { name: 'Rename', exact: true }).click();
  await projectMenu.getByRole('textbox', { name: 'Project name', exact: true }).fill('Renamed test project');
  await projectMenu.getByRole('textbox', { name: 'Project name', exact: true }).press('ArrowLeft');
  check('Left Arrow moves the rename caret without closing the Project submenu or losing its draft', await projectMenu.getByRole('textbox', { name: 'Project name', exact: true }).inputValue() === 'Renamed test project' && await projectMenu.getByRole('textbox', { name: 'Project name', exact: true }).evaluate(el => el.selectionStart === el.value.length - 1));
  await projectMenu.getByRole('textbox', { name: 'Project name', exact: true }).press('Enter');
  await design.locator('.sf-project-name').filter({ hasText: 'Renamed test project' }).waitFor();
  check('Project rename saves through native RPC and exact readback updates sibling cards', await page.evaluate(() => {
    const f = window.hermesT3SidebarHarness;
    return f.calls.some(call => call[0] === 'requestProfile' && call[2] === 'projects.update' && call[3].name === 'Renamed test project') && f.calls.some(call => call[0] === 'requestProfile' && call[2] === 'projects.get');
  }) && await page.locator('[data-session-id="approval"] .sf-project-name').innerText() === 'Renamed test project');
  await openProject();
  await projectMenu.getByRole('button', { name: 'Rename', exact: true }).click();
  await projectMenu.getByRole('textbox', { name: 'Project name', exact: true }).fill('hermes-t3sidebar');
  await projectMenu.getByRole('button', { name: 'Save project rename', exact: true }).click();
  await design.locator('.sf-project-name').filter({ hasText: 'hermes-t3sidebar' }).waitFor();
  await openProject();
  await projectMenu.getByRole('button', { name: 'Project color: Lime', exact: true }).click();
  await page.waitForFunction(() => window.hermesT3SidebarHarness.control.rows.find(row => row.id === 'design').project.color === '#78c318');
  check('Project color selector tints the actual card icon after verified save', await design.locator('.sf-project-icon').evaluate(el => el.style.color !== '' && getComputedStyle(el).color !== getComputedStyle(el.parentElement).color));
  await openProject();
  check('all 64 selectable icons follow project color without tinting the action icons', await projectMenu.locator('.sf-project-submenu').evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = el.style.getPropertyValue('--sf-project-color'); el.append(probe);
    const color = getComputedStyle(probe).color; probe.remove();
    const glyphs = [...el.querySelectorAll('.sf-project-icons svg')];
    return glyphs.length === 64 && glyphs.every(icon => getComputedStyle(icon).color === color) && [...el.querySelectorAll('.sf-menu-icon svg')].every(icon => getComputedStyle(icon).color !== color);
  }));
  await projectMenu.getByRole('button', { name: 'Project icon: chip', exact: true }).hover();
  check('project glyph hover retains the chosen color', await projectMenu.getByRole('button', { name: 'Project icon: chip', exact: true }).evaluate(el => getComputedStyle(el).color === 'rgb(120, 195, 24)'));
  check('palette has two aligned hue rows of golden-ratio portrait rectangles and no visible labels', await projectMenu.locator('.sf-project-colors').evaluate(el => {
    const buttons = [...el.querySelectorAll('button')], bright = buttons.slice(0, 24), dark = buttons.slice(24), rect = node => node.getBoundingClientRect();
    return buttons.length === 48 && !el.innerText.trim() && buttons.every(button => Math.abs(rect(button).height / rect(button).width - (1 + Math.sqrt(5)) / 2) < .01) && dark.every((button, i) => Math.abs(rect(button).x - rect(bright[i]).x) < .1 && rect(button).y > rect(bright[i]).y);
  }));
  check('icon category headings retain all approved groups', await projectMenu.locator('.sf-project-icon-category legend').allTextContents().then(labels => labels.join('|') === 'Projects & workspaces|Code & development|Hardware & robotics|Infrastructure & networks|Research & analysis|Documents & legal|Planning & business|Personal & creative'));
  await projectMenu.screenshot({ path: join(screenshotDir, 'project-appearance.png') });
  await page.setViewportSize({ width: 480, height: 400 });
  await projectMenu.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check('appearance menu remains inside a narrow short viewport with no horizontal clipping', await projectMenu.evaluate(el => { const r = el.getBoundingClientRect(), body = el.querySelector('.sf-project-submenu'); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && body.scrollWidth <= body.clientWidth; }));
  await projectMenu.getByRole('button', { name: 'Default icon', exact: true }).scrollIntoViewIfNeeded();
  check('categorized icon picker stays scrollable through its final row on a short viewport', await projectMenu.getByRole('button', { name: 'Project icon: music', exact: true }).isVisible() && await projectMenu.getByRole('button', { name: 'Default icon', exact: true }).isVisible());
  await page.setViewportSize({ width: 1200, height: 900 });
  await projectMenu.getByRole('button', { name: 'Close session actions', exact: true }).click();
  await context.getByRole('button', { name: 'Close session actions', exact: true }).click();
  await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
  await page.evaluate(() => {
    window.fixtureFallbackMenus = 0;
    window.fixtureContextCoordinator = event => {
      const trigger = event.target.closest('[data-hermes-context-menu-trigger], [data-slot="context-menu-trigger"]');
      if (trigger && !trigger.hasAttribute('data-zone-body')) return;
      event.stopPropagation(); window.fixtureFallbackMenus++;
    };
    window.addEventListener('contextmenu', window.fixtureContextCoordinator, true);
  });
  // Native Button overwrites data-slot; the SDK's independent marker must survive.
  await filters.getByRole('button', { name: 'Filter by docs', exact: true }).evaluate(el => el.setAttribute('data-slot', 'button'));
  await filters.getByRole('button', { name: 'Filter by docs', exact: true }).click({ button: 'right' });
  await projectMenu.waitFor();
  check('filter right-click claims ownership before the native capture-phase fallback', await page.evaluate(() => window.fixtureFallbackMenus === 0));
  check('filter project right-click opens the shared menu without selecting a filter', await projectMenu.locator('.sf-menu-title').textContent() === 'docs' && await filters.getByRole('button', { name: 'All projects', exact: true }).getAttribute('aria-pressed') === 'true' && await design.count() === 1);
  await projectMenu.getByRole('button', { name: 'Project icon: law', exact: true }).click();
  await page.locator('[data-session-id="readme"] [data-codicon="law"]').waitFor();
  check('filter project icon edit saves to the intended project only', !await design.locator('[data-codicon="law"]').count());
  await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
  const docsChoice = filters.getByRole('button', { name: 'Filter by docs', exact: true });
  await docsChoice.focus(); await page.keyboard.press('Shift+F10'); await projectMenu.waitFor();
  check('filter project keyboard context shortcut opens the same categorized picker', await projectMenu.locator('.sf-project-icons button').count() === 64);
  await projectMenu.getByRole('button', { name: 'Rename', exact: true }).click();
  const projectName = projectMenu.getByRole('textbox', { name: 'Project name', exact: true });
  await projectName.fill('Docs renamed'); await projectName.press('ArrowLeft');
  check('filter project rename preserves text caret navigation', await projectName.evaluate(el => el.selectionStart === el.value.length - 1));
  await projectName.press('Enter');
  await page.locator('[data-session-id="readme"] .sf-project-name').filter({ hasText: 'Docs renamed' }).waitFor();
  await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
  await filters.getByRole('button', { name: 'Filter by Docs renamed', exact: true }).click({ button: 'right' }); await projectMenu.waitFor();
  await projectMenu.getByRole('button', { name: 'Rename', exact: true }).click();
  await projectName.fill('docs'); await projectName.press('Enter');
  await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
  await filters.getByRole('button', { name: 'Filter by docs', exact: true }).click({ button: 'right' }); await projectMenu.waitFor();
  await projectMenu.getByRole('button', { name: 'Project color: Brown', exact: true }).click();
  await page.waitForFunction(() => window.hermesT3SidebarHarness.control.rows.find(row => row.id === 'readme').project.color === '#864e08');
  check('filter project color edit persists the exact approved brown', await page.locator('[data-session-id="readme"] .sf-project-icon').evaluate(el => getComputedStyle(el).color === 'rgb(134, 78, 8)'));
  await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
  await filters.getByRole('button', { name: 'Filter by docs', exact: true }).click({ button: 'right' }); await projectMenu.waitFor();
  await projectMenu.getByRole('button', { name: 'No color', exact: true }).click();
  await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
  await filters.getByRole('button', { name: 'Filter by docs', exact: true }).click({ button: 'right' }); await projectMenu.waitFor();
  await projectMenu.getByRole('button', { name: 'Default icon', exact: true }).click();
  await page.evaluate(() => window.removeEventListener('contextmenu', window.fixtureContextCoordinator, true));
  await openProject(); await projectMenu.getByRole('button', { name: 'No color', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-session-id="design"] .sf-project-icon').style.color);
  await openProject(); await projectMenu.getByRole('button', { name: 'Project icon: rocket', exact: true }).click();
  await design.locator('[data-codicon="rocket"]').waitFor();
  await openProject();
  check('Project icon selector marks the saved glyph selected', await projectMenu.getByRole('button', { name: 'Project icon: rocket', exact: true }).getAttribute('aria-pressed') === 'true');
  await projectMenu.getByRole('button', { name: 'Project icon: rocket', exact: true }).click();
  await design.locator('[data-codicon="folder"]').waitFor();
  check('reselecting the chosen icon clears to the default glyph', !await design.locator('[data-codicon="rocket"]').count());
  await design.click({ button: 'right' }); await context.getByRole('button', { name: 'Project', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  await projectMenu.waitFor(); await projectMenu.getByRole('button', { name: 'Rename', exact: true }).focus(); await page.keyboard.press('ArrowLeft');
  check('Project submenu opens with Right and closes with Left without dismissing session actions', !await projectMenu.count() && await context.count() === 1);
  await context.getByRole('button', { name: 'Close session actions', exact: true }).click();
  await design.hover(); await archive.click();
  await page.locator('section[aria-label="Archived"] [data-session-id="design"]').waitFor();
  check('archival and server-readback rendered without an Undo toast', await noUndo());
  await design.hover(); await design.getByRole('button', { name: 'Unarchive session', exact: true }).click();
  await page.locator('section[aria-label="Ready"] [data-session-id="design"]').waitFor();
  check('Archived list Unarchive restores Ready without an Undo banner', await noUndo());
  await design.hover(); await snooze.click();
  await page.getByRole('button', { name: 'In 1 hour', exact: true }).click();
  await page.locator('section[aria-label="Snoozed"] [data-session-id="design"]').waitFor();
  check('direct Snooze control remains available without an Undo toast', await noUndo());
  await design.hover(); await snooze.click();
  await snoozeDialog.getByRole('button', { name: 'Unsnooze', exact: true }).click();
  await page.locator('section[aria-label="Ready"] [data-session-id="design"]').waitFor();
  check('Snooze menu Unsnooze remains available without an Undo toast', await noUndo());
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
  await page.getByRole('button', { name: 'New session in hermes-t3sidebar', exact: true }).waitFor();
  check('project picker has no Cancel button', !await page.getByRole('button', { name: 'Cancel', exact: true }).count());
  check('project picker icons have no filled background', await page.locator('.sf-project-choice .sf-project-icon').evaluateAll(icons => icons.length > 0 && icons.every(icon => getComputedStyle(icon).backgroundColor === 'rgba(0, 0, 0, 0)')));
  check('new-session picker omits unsupported Home and its explanatory text', !await page.getByRole('button', { name: 'New session in Home', exact: true }).count() && !await page.getByText(/Home remains listed/).count());
  const projectChoice = page.getByRole('button', { name: 'New session in hermes-t3sidebar', exact: true });
  check('new-session picker renders the updated native project name and glyph, not its identifier', await projectChoice.locator('[data-codicon="folder"]').count() === 1 && await projectChoice.locator('.sf-project-name').textContent() === 'hermes-t3sidebar');
  check('project picker aligns icon before project name', await projectChoice.evaluate(el => {
    const icon = el.querySelector('.sf-project-icon').getBoundingClientRect(), name = el.querySelector('.sf-project-details').getBoundingClientRect();
    return icon.right <= name.left && Math.abs(icon.top + icon.height / 2 - name.top - name.height / 2) < 2;
  }));
  check('project picker does not create a session until a supported project is selected', !await page.evaluate(() => window.hermesT3SidebarHarness.calls.some(call => call[0] === 'requestProfile' && call[2] === 'session.create')));
  await page.getByRole('button', { name: 'New session in hermes-t3sidebar', exact: true }).click();
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
    fixture.control.live.push({ id: 'runtime-synthetic-draft', session_key: 'synthetic-runtime-draft', source: 'desktop', status: 'idle', message_count: 0,
      cwd: '/synthetic/robot', project: { id: 'robot', name: 'Draft robot', icon: 'tools', color: '#ff6000', cwd: '/synthetic/robot' }, provider: 'anthropic' });
    fixture.host.state.focusedStoredSessionId.set('synthetic-runtime-draft');
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  });
  const runtimeDraft = page.locator('[data-session-id="synthetic-runtime-draft"]');
  check('new runtime-only empty session stays hidden with no draft prompt', !await runtimeDraft.count());
  await page.evaluate(() => { window.hermesT3SidebarHarness.control.mountedDrafts['synthetic-runtime-draft'] = 'PRIVATE unsent robot prompt'; });
  await runtimeDraft.waitFor();
  check('typing in a hidden empty session reveals its card through ordinary focused composer polling', await runtimeDraft.getAttribute('data-has-draft') === 'true' && await runtimeDraft.locator('.sf-row-title').textContent() === 'New session');
  check('zero-message draft card has its exact project name, native icon/color and provider', await runtimeDraft.locator('.sf-project-name').textContent() === 'Draft robot' && await runtimeDraft.locator('[data-codicon="tools"]').count() === 1 && await runtimeDraft.locator('[data-provider-mark="anthropic"]').count() === 1 && await runtimeDraft.locator('.sf-project-icon').evaluate(el => getComputedStyle(el).color === 'rgb(255, 96, 0)'));
  check('draft contents never enter sidebar DOM or plugin query cache', !/PRIVATE unsent robot/.test(await page.locator('.sf').innerText()) && await page.evaluate(() => !JSON.stringify(window.hermesT3SidebarHarness.queryClient.getQueryCache().getAll().map(query => query.state.data)).includes('PRIVATE unsent robot')));
  await page.evaluate(() => { window.hermesT3SidebarHarness.control.mountedDrafts['synthetic-runtime-draft'] = ''; });
  await runtimeDraft.waitFor({ state: 'detached' });
  check('clearing the focused draft removes its otherwise empty card without deleting or closing the session', await page.evaluate(() => window.hermesT3SidebarHarness.control.live.some(row => row.session_key === 'synthetic-runtime-draft')));
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    fixture.control.live = fixture.control.live.filter(row => row.session_key !== 'synthetic-runtime-draft');
    fixture.host.state.focusedStoredSessionId.set('design');
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  });
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    fixture.control.rows.push({ id: 'synthetic-new-empty', title: 'Untitled session', message_count: 0, preview: '', project: null, source: 'desktop' });
    fixture.control.drafts['synthetic-new-empty'] = 'Unsent fixture task';
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
  await page.getByRole('button', { name: 'Archived (100)', exact: true }).waitFor();
  check('archive first page requests and displays only 100 sessions', await page.evaluate(() => window.hermesT3SidebarHarness.calls.some(call => call[0] === 'rest' && call[1] === '/archives?offset=0&limit=100')));
  await page.getByRole('button', { name: 'Browse older archives', exact: true }).click();
  await page.getByRole('button', { name: 'Archived (600)', exact: true }).waitFor();
  check('600 loaded archives retain their logical count without mounting 600 cards', await page.locator('[data-section="archived"] .sf-row').count() > 0 && await page.locator('[data-section="archived"] .sf-row').count() < 30);
  for (const motion of ['reduce', 'no-preference']) {
    await page.emulateMedia({ reducedMotion: motion });
    await page.getByRole('button', { name: 'Archived (600)', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-section="archived"]')?.dataset.closed === 'true');
    check(`600-archive ${motion} fold keeps body inert and mounted rows bounded`, await page.locator('[data-section="archived"] .sf-section-body').evaluate(el => el.inert) && await page.locator('[data-section="archived"] .sf-row').count() < 30);
    await page.getByRole('button', { name: 'Archived (600)', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-section="archived"]')?.dataset.closed === 'false');
    await page.waitForFunction(() => document.querySelector('[data-section="archived"] .sf-section-body')?.clientHeight > 100);
    check(`600-archive ${motion} reopen preserves bounded rows and restores its body`, !await page.locator('[data-section="archived"] .sf-section-body').evaluate(el => el.inert) && await page.locator('[data-section="archived"] .sf-row').count() < 30);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const lastLoadedArchive = await page.evaluate(() => window.hermesT3SidebarHarness.control.extra.slice(0, 600).map(row => row.id).sort((a, b) => a.localeCompare(b)).at(-1));
  await page.locator('[data-session-id="synthetic-page-active-0"] .sf-open').focus();
  await page.keyboard.press('End');
  await page.waitForFunction(id => document.activeElement?.closest('[data-session-id]')?.dataset.sessionId === id, lastLoadedArchive);
  check('End reaches an unmounted archive through full logical ordering', await page.locator('[data-section="archived"] .sf-row').count() < 30 && await page.locator('[data-section="archived"] .sf-section-body').evaluate(el => el.scrollTop > 0));
  await page.keyboard.press('Home');
  await page.waitForFunction(() => document.activeElement?.closest('[data-session-id]')?.dataset.sessionId === 'synthetic-page-active-0');
  check('Home returns from a virtual archive to the first Ready card', await page.locator('[data-section="active"] .sf-section-body').evaluate(el => el.scrollTop === 0));
  await page.getByRole('button', { name: 'Browse older archives', exact: true }).click();
  await page.getByRole('button', { name: 'Archived (601)', exact: true }).waitFor();
  await page.getByRole('searchbox').fill('archive page 600');
  await page.locator('[data-session-id="synthetic-page-archive-600"]').waitFor({ state: 'attached' });
  check('601st archive loads rich metadata independently of older active history', !await page.locator('[data-session-id="synthetic-page-active-500"]').count() && await page.locator('[data-session-id="synthetic-page-archive-600"] .sf-project-name').textContent() === 'Archive pagination');
  await page.getByRole('searchbox').fill('archive page 600');
  const oldArchive = page.locator('[data-session-id="synthetic-page-archive-600"]');
  await oldArchive.hover(); await oldArchive.getByRole('button', { name: 'Unarchive session', exact: true }).click();
  await page.locator('section[aria-label="Ready"] [data-session-id="synthetic-page-archive-600"]').waitFor();
  await oldArchive.hover(); await oldArchive.getByRole('button', { name: 'Archive session', exact: true }).click();
  await page.locator('section[aria-label="Archived"] [data-session-id="synthetic-page-archive-600"]').waitFor();
  check('601st archive Unarchive and rearchive re-read both shelves without banners', await noUndo());
  // Reset into large labeled synthetic data, never a live history.
  await page.evaluate(() => window.hermesT3SidebarHarness.loadDenseFixtures());
  await page.locator('[data-session-id="synthetic-active-000"]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-session-id="synthetic-working-000"]')?.dataset.working === 'true');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const shelf of ['archived', 'working']) {
    const motion = await page.evaluate(async shelf => {
      const section = document.querySelector(`[data-section="${shelf}"]`), toggle = section.querySelector('.sf-section-toggle');
      const height = () => section.getBoundingClientRect().height;
      const collect = async () => {
        const samples = [], start = performance.now();
        while (performance.now() - start < 320) { await new Promise(requestAnimationFrame); samples.push(height()); }
        return samples;
      };
      const before = height();
      toggle.click();
      const closing = await collect(), closed = height();
      const body = section.querySelector('.sf-section-body');
      const inaccessible = body.inert && body.getAttribute('aria-hidden') === 'true';
      toggle.click();
      const opening = await collect();
      return { before, closed, inaccessible, closing, opening, final: height(), reopened: !body.inert && !body.hasAttribute('aria-hidden') };
    }, shelf);
    console.log(`MOTION ${shelf}: ${JSON.stringify(motion)}`);
    check(`${shelf} fold and unfold animate real category height, not just the chevron`, motion.closing.some(h => h > 25 && h < motion.before - 1) && motion.opening.some(h => h > 25 && h < motion.before - 1) && Math.abs(motion.closed - 24) < 1 && Math.abs(motion.final - motion.before) < 1 && motion.inaccessible && motion.reopened);
    const rapid = await page.evaluate(async shelf => {
      const section = document.querySelector(`[data-section="${shelf}"]`), toggle = section.querySelector('.sf-section-toggle');
      const before = section.getBoundingClientRect().height;
      const wait = async ms => { const start = performance.now(); while (performance.now() - start < ms) await new Promise(requestAnimationFrame); };
      const intermediate = async () => {
        const start = performance.now();
        while (performance.now() - start < 260) {
          await new Promise(requestAnimationFrame);
          const height = section.getBoundingClientRect().height;
          if (height > 25 && height < before - 1) return true;
        }
        return false;
      };
      toggle.click();
      const duringClose = await intermediate();
      toggle.click(); await wait(320);
      const open = section.dataset.closed === 'false' && !section.querySelector('.sf-section-body').inert && Math.abs(section.getBoundingClientRect().height - before) < 1;
      toggle.click(); await wait(320);
      toggle.click();
      const duringOpen = await intermediate();
      toggle.click(); await wait(320);
      const closed = section.dataset.closed === 'true' && section.querySelector('.sf-section-body').inert && Math.abs(section.getBoundingClientRect().height - 24) < 1;
      toggle.click(); await wait(320);
      return duringClose && duringOpen && open && closed && Math.abs(section.getBoundingClientRect().height - before) < 1;
    }, shelf);
    check(`${shelf} rapid folding reversal settles expanded without inert or stuck content`, rapid);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  check('reduced-motion disables category height transitions on their actual owners', await page.locator('.sf-shelves,[data-section="working"]').evaluateAll(els => els.every(el => getComputedStyle(el).transitionDuration === '0s')));
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
    check(`${height}px: dense Working is capped at 18% of the remaining grid`, await page.locator('[data-section="working"]').evaluate(el => Math.abs(el.getBoundingClientRect().height - el.parentElement.getBoundingClientRect().height * .18) <= 1));
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
    check(`${height}px: card text lines use a centered 3px gap without changing line heights`, await card.locator('.sf-open').evaluate(el => {
      const meta = el.querySelector('.sf-card-meta').getBoundingClientRect(), title = el.querySelector('.sf-row-title').getBoundingClientRect(), bounds = el.getBoundingClientRect();
      return getComputedStyle(el).rowGap === '3px' && meta.height === 19 && title.height === 19 && title.top - meta.bottom === 3 && Math.abs((meta.top + title.bottom) / 2 - (bounds.top + bounds.bottom) / 2) < 1;
    }));
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
    if (count === 1) check('Pinned uses natural flex sizing rather than a calculated grid track', await page.locator('[data-section="pinned"]').evaluate(el => getComputedStyle(el.parentElement).display === 'flex' && getComputedStyle(el).flexGrow === '0' && !el.parentElement.style.gridTemplateRows));
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
    check(`Working ${count}: parent track is content-fit, not count-derived pixels`, await page.locator('[data-section="working"]').evaluate(el => el.parentElement.style.gridTemplateRows.includes('fit-content(18%)') && !el.style.height && !el.style.maxHeight));
    if (!count) check('empty Working retains only its 24px header and no scroll-body footprint', await page.locator('[data-section="working"]').evaluate(el => el.querySelector('.sf-section-toggle').getBoundingClientRect().height === 24 && el.querySelector('.sf-section-body').getBoundingClientRect().height === 0));
    if (count === 2) {
      // A CSS row-size change must flow through intrinsic layout without new data.
      await page.locator('.harness-sidebar').evaluate(el => { el.style.height = '1800px'; });
      const css = await page.addStyleTag({ content: '[data-section="working"] .sf-row{height:70px}' });
      check('Working follows actual CSS content height without recalculating JavaScript row geometry', await page.locator('[data-section="working"]').evaluate(el => Math.abs(el.getBoundingClientRect().height - 164) <= 1));
      await css.evaluate(el => el.remove());
    }
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
          tightCards: [...list.querySelectorAll('.sf-open')].every(el => {
            const meta = el.querySelector('.sf-card-meta').getBoundingClientRect(), title = el.querySelector('.sf-row-title').getBoundingClientRect();
            return el.closest('.sf-row').getBoundingClientRect().height === 56 && getComputedStyle(el).rowGap === '3px' && meta.height === 19 && title.height === 19 && title.top - meta.bottom === 3;
          }),
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
      check(`${height}px ${banner}: tight card text preserves 56px rows and 19px lines`, geometry.tightCards);
      check(`${height}px ${banner}: no Undo or dismiss-Undo controls`, await noUndo());
      if (height === 300 && banner === 'error') await page.locator('.harness-sidebar').screenshot({ path: join(screenshotDir, 'short-300-error.png') });
    }
  }
  await page.reload();
  await page.getByRole('button', { name: 'Plugin settings', exact: true }).click();
  const presetSetting = page.locator('[aria-label="Snooze preset time"]');
  check('plugin settings default the shared Tomorrow/Monday time to 09:00', await presetSetting.inputValue() === '09:00');
  await presetSetting.fill('14:35');
  const settingsDesign = page.locator('[data-session-id="design"]');
  await settingsDesign.hover(); await settingsDesign.getByRole('button', { name: 'Snooze session', exact: true }).click();
  check('settings change updates both calendar snooze choices without a reload', await snoozeDialog.getByRole('button', { name: 'Tomorrow at 14:35', exact: true }).count() === 1 && await snoozeDialog.getByRole('button', { name: 'Next Monday at 14:35', exact: true }).count() === 1);
  const configuredTomorrow = await page.evaluate(() => { const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(14, 35, 0, 0); return tomorrow.getTime() / 1000; });
  await snoozeDialog.getByRole('button', { name: 'Tomorrow at 14:35', exact: true }).click();
  await page.waitForFunction(expected => window.hermesT3SidebarHarness.control.metadata.sessions.design?.wake_at === expected, configuredTomorrow);
  check('configured Tomorrow action saves its exact local wake deadline', await page.evaluate(expected => window.hermesT3SidebarHarness.control.metadata.sessions.design.wake_at === expected, configuredTomorrow));
  await page.reload();
  await page.getByRole('button', { name: 'Plugin settings', exact: true }).click();
  check('configured preset time persists across actual browser reload', await presetSetting.inputValue() === '14:35');
  await page.locator('[data-session-id="design"]').hover();
  await page.locator('[data-session-id="design"]').getByRole('button', { name: 'Snooze session', exact: true }).click();
  check('persisted setting is used by both presets after reload', await snoozeDialog.getByRole('button', { name: 'Tomorrow at 14:35', exact: true }).count() === 1 && await snoozeDialog.getByRole('button', { name: 'Next Monday at 14:35', exact: true }).count() === 1);
  await snoozeDialog.getByRole('button', { name: 'Close session actions', exact: true }).click();
  await presetSetting.fill('09:00');
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    fixture.control.projects.push({ id: 'p_move', label: 'Move target', path: '/move-target', repos: [{ path: '/move-target' }], icon: 'tools' });
    const archived = fixture.control.rows.find(row => row.id === 'archived');
    archived.unread = true;
    fixture.control.metadata.sessions.archived = { state: 'snoozed', pinned: true, wake_at: Date.now() / 1000 + 3600 };
    fixture.control.metadata.completions = { archived: { done_token: 'archived-result', done_at: 1 } };
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  });
  const archiveShelf = page.getByRole('button', { name: 'Archived (1)', exact: true });
  if (await archiveShelf.getAttribute('aria-expanded') === 'false') await archiveShelf.click();
  const archivedCard = page.locator('[data-session-id="archived"]');
  check('archived card suppresses stale Done, pin and snooze', !await archivedCard.locator('.sf-status,.sf-pin,[aria-label="Snooze session"]').count());
  await archivedCard.locator('.sf-open').click();
  check('viewing an archive preserves native archival', await page.evaluate(() => window.hermesT3SidebarHarness.control.rows.find(row => row.id === 'archived').archived === true));
  await settingsDesign.click({ button: 'right' });
  const moveMenu = page.getByRole('dialog', { name: 'Session actions', exact: true });
  check('Move to project is directly above final Project submenu', await moveMenu.locator('.sf-menu-action').evaluateAll(items => items.at(-2).getAttribute('aria-label') === 'Move to project' && items.at(-1).getAttribute('aria-label') === 'Project'));
  await moveMenu.getByRole('button', { name: 'Move to project', exact: true }).click();
  const moveDialog = page.getByRole('dialog', { name: 'Move to project', exact: true });
  await moveDialog.getByRole('button', { name: 'Move to Move target', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-session-id="design"] .sf-project-name')?.textContent === 'Move target');
  check('project move changes native workspace and verified card metadata', await page.evaluate(() => window.hermesT3SidebarHarness.control.rows.find(row => row.id === 'design').cwd === '/move-target'));
  await page.reload();
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    fixture.control.home = '/home/fixture';
    fixture.control.projects = [
      { id: 'p_multi', label: 'Multi workspace', path: '/home/fixture/main', icon: 'tools', repos: [{ path: '/home/fixture/main' }, { path: '/home/fixture/second' }] },
      { id: 'p_single', label: 'Single workspace', path: '/srv/shared', icon: 'repo' }
    ];
    fixture.control.projectCatalog = [{ id: 'p_multi', name: 'Multi workspace', icon: 'tools', color: null, archived: false, folders: [{ path: '/home/fixture/main' }, { path: '/home/fixture/second' }] }];
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  });
  const pickerShapes = [];
  for (const [trigger, dialogName, prefix] of [['Filter sessions', 'Session filters', 'Filter by'], ['New session', 'New session project', 'New session in']]) {
    await page.getByRole('button', { name: trigger, exact: true }).click();
    const picker = page.getByRole('dialog', { name: dialogName, exact: true });
    await picker.getByRole('button', { name: `${prefix} Multi workspace: ~/second`, exact: true }).waitFor();
    check(`${trigger} always has search and only Filter has All projects`, await picker.getByRole('searchbox', { name: 'Search projects' }).isVisible() && await picker.getByRole('button', { name: 'All projects', exact: true }).count() === (prefix === 'Filter by' ? 1 : 0));
    pickerShapes.push(await picker.locator('.sf-project-options .sf-project-name,.sf-project-path').allTextContents().then(values => values.filter(value => value !== 'All projects')));
    check(`${trigger} groups multiple paths beneath one project name`, await picker.locator('.sf-project-group .sf-project-name').allTextContents().then(names => names.join() === 'Multi workspace') && await picker.locator('.sf-project-group .sf-project-folder .sf-project-path').allTextContents().then(paths => paths.join('|') === '~/main|~/second'));
    check(`${trigger} uses context-menu-density rows and compact folder spacing`, await picker.locator('.sf-project-choice').evaluateAll(rows => rows.every(row => Math.abs(row.getBoundingClientRect().height - 24) < .1) && [...document.querySelectorAll('.sf-project-group')].every(group => {
      const choices = [...group.querySelectorAll('.sf-project-choice')];
      return choices.slice(1).every((row, index) => Math.abs(row.getBoundingClientRect().top - choices[index].getBoundingClientRect().bottom) < .1);
    })));
    check(`${trigger} single-folder path is on the right of its name on the same line`, await picker.getByRole('button', { name: `${prefix} Single workspace`, exact: true }).evaluate(row => {
      const name = row.querySelector('.sf-project-name').getBoundingClientRect(), path = row.querySelector('.sf-project-path').getBoundingClientRect();
      return name.right < path.left && Math.abs(name.top - path.top) < .1 && getComputedStyle(row.querySelector('.sf-project-path')).textAlign === 'right';
    }));
    if (prefix === 'Filter by') check('All projects icon and label align exactly with project icons and labels', await picker.evaluate(el => {
      const all = el.querySelector('[aria-label="All projects"]'), project = el.querySelector('.sf-project-heading');
      return ['.sf-project-icon', '.sf-project-name'].every(selector => Math.abs(all.querySelector(selector).getBoundingClientRect().left - project.querySelector(selector).getBoundingClientRect().left) < .1);
    }));
    check(`${trigger} paths use the dimmed theme color`, await picker.locator('.sf-project-path').evaluateAll(nodes => nodes.every(node => {
      const probe = document.createElement('span'); probe.style.color = 'var(--ui-text-tertiary)'; node.append(probe);
      const expected = getComputedStyle(probe).color; probe.remove();
      return getComputedStyle(node).color === expected && getComputedStyle(node).fontWeight === '400';
    })));
    const heading = picker.getByRole('button', { name: 'Project Multi workspace', exact: true });
    const beforeCreate = await page.evaluate(() => window.hermesT3SidebarHarness.calls.filter(call => call[2] === 'session.create').length);
    const box = await heading.boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await heading.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Space');
    check(`${trigger} multi-path heading cannot select by mouse or keyboard`, await picker.isVisible() && await heading.getAttribute('aria-disabled') === 'true' && await page.getByRole('button', { name: 'Filter sessions', exact: true }).getAttribute('data-filtered') === 'false' && await page.evaluate(() => window.hermesT3SidebarHarness.calls.filter(call => call[2] === 'session.create').length) === beforeCreate);
    await heading.locator('.sf-project-name').click({ button: 'right', force: true });
    await projectMenu.waitFor();
    check(`${trigger} non-selectable heading still opens its project menu`, await projectMenu.locator('.sf-menu-title').textContent() === 'Multi workspace' && await projectMenu.getByRole('button', { name: 'Rename', exact: true }).isEnabled() && await projectMenu.getByRole('button', { name: 'Copy path', exact: true }).isDisabled() && await projectMenu.getByRole('button', { name: 'Filter for', exact: true }).isDisabled());
    await projectMenu.getByRole('button', { name: 'Close session actions', exact: true }).click();
    await picker.getByRole('searchbox', { name: 'Search projects' }).fill('~/second');
    check(`${trigger} path search preserves the non-selectable parent and matching folder only`, await picker.locator('.sf-project-folder').count() === 1 && await heading.count() === 1 && !await picker.getByRole('button', { name: `${prefix} Single workspace`, exact: true }).count());
    await picker.getByRole('searchbox', { name: 'Search projects' }).fill('');
    await picker.screenshot({ path: join(screenshotDir, `${prefix === 'Filter by' ? 'filter' : 'new-session'}-project-picker.png`) });
    await picker.getByRole('button', { name: 'Close session actions', exact: true }).click();
  }
  check('Filter and New session render the same project list and grouped paths', JSON.stringify(pickerShapes[0]) === JSON.stringify(pickerShapes[1]));
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    fixture.control.projects = [
      { id: 'p_many', label: 'Many folders', icon: 'tools', repos: Array.from({ length: 6 }, (_, i) => ({ path: `/home/fixture/worktrees/folder-${i}` })) },
      ...Array.from({ length: 48 }, (_, i) => ({ id: `p_dense_${i}`, label: `Workspace ${String(i).padStart(2, '0')}`, path: `/home/fixture/Documents/a-deliberately-long-project-folder-name-${i}`, icon: 'repo' }))
    ];
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  });
  // Desktop's input need not inherit the harness's global border-box reset.
  const contentBox = await page.addStyleTag({ content: 'input{box-sizing:content-box}' });
  for (const [trigger, dialogName] of [['Filter sessions', 'Session filters'], ['New session', 'New session project']]) {
    for (const [width, height] of [[1200, 900], [360, 320]]) {
      await page.setViewportSize({ width, height });
      await page.getByRole('button', { name: trigger, exact: true }).click();
      const picker = page.getByRole('dialog', { name: dialogName, exact: true });
      await picker.getByRole('button', { name: 'Project Many folders', exact: true }).waitFor();
      await picker.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      check(`${trigger} at ${width}x${height}: search and popup stay inside their bounds without a global box-sizing reset`, await picker.evaluate(el => {
        const box = el.getBoundingClientRect(), body = el.querySelector('.sf-project-picker'), input = body.querySelector('input'), r = input.getBoundingClientRect(), b = body.getBoundingClientRect(), style = getComputedStyle(body);
        return box.left >= 0 && box.right <= innerWidth + .5 && box.top >= 0 && box.bottom <= innerHeight + .5 && body.scrollWidth <= body.clientWidth && getComputedStyle(input).boxSizing === 'border-box' && r.left >= b.left + parseFloat(style.paddingLeft) - .5 && r.right <= b.right - parseFloat(style.paddingRight) + .5;
      }));
      check(`${trigger} at ${width}x${height}: six-folder group keeps all rows compact`, await picker.locator('.sf-project-group').evaluate(el => el.querySelectorAll('.sf-project-folder').length === 6 && Math.abs(el.getBoundingClientRect().height - 7 * 24) < .5));
      if (height === 900) check(`${trigger} uses a taller list instead of the former 360px cap`, await picker.locator('.sf-project-options').evaluate(el => el.clientHeight > 560 && el.scrollHeight > el.clientHeight));
      const before = await picker.getByRole('searchbox', { name: 'Search projects' }).boundingBox();
      await picker.locator('.sf-project-options').hover(); await page.mouse.wheel(0, 700);
      await page.waitForFunction(() => document.querySelector('.sf-project-options')?.scrollTop > 0);
      const after = await picker.getByRole('searchbox', { name: 'Search projects' }).boundingBox();
      check(`${trigger} at ${width}x${height}: only choices scroll while search stays fixed`, Math.abs(before.y - after.y) < .1 && await picker.evaluate(el => el.scrollTop === 0 && el.querySelector('.sf-project-picker').scrollTop === 0));
      await picker.locator('.sf-project-options').evaluate(el => { el.scrollTop = 0; });
      await picker.screenshot({ path: join(screenshotDir, `${trigger === 'Filter sessions' ? 'filter' : 'new-session'}-project-dense-${height}.png`) });
      if (height === 900) {
        await picker.evaluate(el => el.style.setProperty('--radix-popover-content-available-height', '280px'));
        check(`${trigger} honors the native popover available-height limit`, await picker.locator('.sf-project-picker').evaluate(el => el.getBoundingClientRect().height <= 280 && el.querySelector('.sf-project-options').clientHeight > 0));
      }
      await picker.getByRole('button', { name: 'Close session actions', exact: true }).click();
    }
  }
  await contentBox.evaluate(el => el.remove());
  check('no browser page errors', errors.length === 0);
  console.log(`Browser smoke: ${checks.length} checks passed; screenshots ${screenshotDir}/{frontend,hovered,actions,dense-400,dense-650,short-300-error}.png`);
} finally { await browser?.close(); server.close(); }
