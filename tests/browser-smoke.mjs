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
    await page.keyboard.press('Escape');
    await page.mouse.move(1100, 850);
    check(`${label} returns to normal after closing its popover`, await trigger.getAttribute('aria-expanded') === 'false' && JSON.stringify(await buttonStyle(trigger)) === JSON.stringify(normal));
  };
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-session-id="approval"]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-session-id="root"]')?.dataset.working === 'true');
  {
    const visibility = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
    visibility.on('pageerror', error => errors.push(error.message));
    await visibility.emulateMedia({ reducedMotion: 'reduce' });
    await visibility.goto(`http://127.0.0.1:${server.address().port}`);
    await visibility.locator('[data-session-id="root"][data-working=true]').waitFor();
    await visibility.getByRole('button', { name: 'Plugin settings', exact: true }).click();
    const toggle = visibility.getByRole('switch', { name: 'Show token counts', exact: true });
    const metadata = () => visibility.locator('.sf-row').evaluateAll(rows => rows.map(row => ({
      id: row.dataset.sessionId, provider: row.querySelector('.sf-provider')?.getAttribute('aria-label'),
      time: row.querySelector('.sf-time')?.textContent, height: row.getBoundingClientRect().height,
      title: row.querySelector('.sf-row-title')?.textContent
    })));
    check('Show token counts defaults on for every session card', await toggle.getAttribute('aria-checked') === 'true' && await visibility.locator('.sf-token').count() === await visibility.locator('.sf-row').count());
    const before = await metadata();
    await toggle.click();
    await visibility.waitForFunction(() => !document.querySelector('.sf-token'));
    check('disabling token counts removes their accessible labels and keeps card metadata and heights unchanged', !await visibility.locator('[aria-label^="Total tokens:"]').count() && JSON.stringify(await metadata()) === JSON.stringify(before));
    await visibility.reload();
    await visibility.locator('[data-session-id="root"][data-working=true]').waitFor();
    await visibility.getByRole('button', { name: 'Plugin settings', exact: true }).click();
    check('hidden token counts persist through a full browser reload', await toggle.getAttribute('aria-checked') === 'false' && !await visibility.locator('.sf-token').count());
    await visibility.getByRole('button', { name: 'Switch mock source', exact: true }).click();
    await visibility.locator('[data-session-id="root"][data-working=true]').waitFor();
    check('token visibility stays a Desktop preference across sources', !await visibility.locator('.sf-token').count());
    await toggle.click();
    await visibility.waitForFunction(() => document.querySelectorAll('.sf-token').length === document.querySelectorAll('.sf-row').length);
    check('enabling token counts restores every counter without reloading', await toggle.getAttribute('aria-checked') === 'true' && await visibility.locator('.sf-token').count() > 0);
    await visibility.locator('.harness-sidebar').evaluate(el => { el.style.width = '240px'; });
    check('token counts fit narrow cards without horizontal overflow', await visibility.locator('.sf-card-meta').evaluateAll(nodes => nodes.every(el => el.scrollWidth <= el.clientWidth + 1)));
    await toggle.click();
    await visibility.waitForFunction(() => !document.querySelector('.sf-token'));
    check('hidden token counts leave no horizontal overflow on narrow cards', await visibility.locator('.sf-card-meta').evaluateAll(nodes => nodes.every(el => el.scrollWidth <= el.clientWidth + 1)));
    await visibility.close();
  }
  check('a single Snoozed card reserves no blank space below it', await page.locator('[data-section="snoozed"]').evaluate(el => {
    const body = el.querySelector('.sf-section-body'), cards = body.querySelectorAll('.sf-row');
    return cards.length === 1 && Math.abs(body.getBoundingClientRect().bottom - cards[0].getBoundingClientRect().bottom) <= 1 && body.scrollHeight <= body.clientHeight;
  }));
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
  check('empty categories have no placeholder text while headings remain visible', !await page.locator('.sf-section .sf-empty').count() && await page.getByRole('button', { name: 'Snoozed (0)', exact: true }).isVisible() && await page.getByRole('button', { name: 'Archived (0)', exact: true }).isVisible());
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
  check('Working with one card has no spare vertical space', await page.locator('[data-section="working"]').evaluate(el => el.getBoundingClientRect().height <= 30 + el.querySelectorAll('.sf-row').length * 56 + 1));
  check('waiting approval remains Ready despite archival and pin metadata', await page.locator('section[aria-label="Ready"] [data-session-id="approval"]').count() === 1);
  const tokenColor = (locator, token) => locator.evaluate((el, token) => {
    const probe = document.createElement('span'); probe.style.color = `var(${token})`; el.append(probe);
    const color = getComputedStyle(probe).color; probe.remove(); return color;
  }, token);
  const titleColor = id => page.locator(`[data-session-id="${id}"] .sf-row-title`).evaluate(el => getComputedStyle(el).color);
  check('Working, Input and Done status icons and labels share the metadata line centre', await page.locator('.sf-status').evaluateAll(labels => labels.length >= 2 && labels.every(label => {
    const tokens = label.closest('.sf-card-meta').querySelector('.sf-token').getBoundingClientRect(), icon = label.querySelector('[data-status-icon]')?.getBoundingClientRect(), text = label.getBoundingClientRect();
    const centre = rect => rect.top + rect.height / 2;
    return icon && Math.abs(centre(icon) - centre(tokens)) <= 1 && Math.abs(centre(text) - centre(tokens)) <= 1 && icon.right <= text.right;
  })));
  check('Working shows a still, unfilled dashed circle and the native turn elapsed time instead of a visible label', await page.locator('[data-session-id="root"] .sf-status').evaluate(el => {
    const duration = el.querySelector('.sf-working-duration'), label = el.querySelector('.sf-sr'), disc = el.querySelector('svg[data-status-icon=working]');
    return !!duration && /^2m$/.test(duration.textContent) && duration.getAttribute('aria-hidden') === 'true' && label?.textContent === 'Working' && el.dataset.agent === undefined
      && label.getBoundingClientRect().width <= 1 && getComputedStyle(disc).animationName === 'none' && disc.querySelectorAll('path').length === 8 && getComputedStyle(disc.querySelector('path')).fill === 'none'
      && duration.getBoundingClientRect().left > disc.getBoundingClientRect().right && getComputedStyle(duration).fontVariantNumeric.includes('tabular-nums');
  }));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  check('Working dashed circle stays still even without reduced motion', await page.locator('[data-session-id="root"] svg[data-status-icon=working]').evaluate(el => getComputedStyle(el).animationName === 'none'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const setRunAge = seconds => page.evaluate(age => { const harness = window.hermesT3SidebarHarness; harness.control.live.find(item => item.id === 'runtime-worker').turn_started_at = Date.now() / 1000 - age; return harness.queryClient.invalidateQueries(); }, seconds);
  const workingSeconds = () => page.locator('[data-session-id="root"] .sf-working-duration').evaluate(el => /^(\d+)s$/.exec(el.textContent)?.[1]).then(Number);
  await setRunAge(5);
  await page.waitForFunction(() => /^\d+s$/.test(document.querySelector('[data-session-id="root"] .sf-working-duration')?.textContent));
  // Ticks are not phase-aligned with the turn start, so allow one second of display lag.
  const firstSecond = await workingSeconds(); await page.waitForTimeout(3200);
  check('Working elapsed time ticks every second without a new poll', await workingSeconds() - firstSecond >= 2);
  await setRunAge(125);
  await page.waitForFunction(() => document.querySelector('[data-session-id="root"] .sf-working-duration')?.textContent === '2m');
  check('Working recedes its title, not the whole card', await page.locator('[data-session-id="root"]').evaluate(el => getComputedStyle(el).opacity) === '1' && await titleColor('root') === await tokenColor(page.locator('[data-session-id="root"]'), '--ui-text-secondary'));
  check('Working blue mixes Desktop blue with the base text color so it stays readable in dark themes', await page.locator('[data-session-id="root"] .sf-time').evaluate(el => {
    const color = value => { const probe = document.createElement('span'); probe.style.color = value; el.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; };
    return getComputedStyle(el).color === color('oklch(from color-mix(in oklab,var(--ui-blue) 62%,var(--ui-base,var(--ui-text-primary))) l calc(c * 1.6) h)') && getComputedStyle(el).color !== color('var(--ui-blue)');
  }));
  check('snooze status alarm draws in a 16px box with a 1px line, as large as the Working circle', await page.locator('.sf-snooze-time svg').first().evaluate(el => el.getBoundingClientRect().width === 16 && getComputedStyle(el).strokeWidth === '1.6px'));
  check('Working card text uses the native blue theme token', await page.locator('[data-session-id="root"] .sf-time').evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'var(--sf-blue)'; el.append(probe);
    const expected = getComputedStyle(probe).color, actual = getComputedStyle(el).color; probe.remove();
    return actual === expected && actual !== getComputedStyle(el.parentElement).color;
  }));
  check('category headings place plain counts and divider before right-aligned chevron', await page.locator('.sf-section-toggle').evaluateAll(headers => headers.every(header => {
    const count = header.querySelector('.sf-count'), line = header.querySelector('.sf-section-line'), chevron = header.querySelector('.sf-section-chevron');
    if (!count || !line || !chevron || !/^\d+$/.test(count.textContent)) return false;
    const c = count.getBoundingClientRect(), l = line.getBoundingClientRect(), a = chevron.getBoundingClientRect(), h = header.getBoundingClientRect();
    return c.right <= l.left && l.width > 30 && l.right <= a.left && a.right >= h.right - 8 && h.height === 30;
  })));
  check('sidebar project icons have no filled background', await page.locator('.sf-row .sf-project-icon').evaluateAll(icons => icons.every(icon => getComputedStyle(icon).backgroundColor === 'rgba(0, 0, 0, 0)')));
  for (const [id, status, label, token] of [['readme', 'done', 'Done', '--ui-green'], ['approval', 'input', 'Input', '--ui-orange']]) {
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
  check('provider logo and token count share a quieter color, with the denser logo at 0.7 opacity', await page.locator('[data-session-id="design"]').evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'color-mix(in srgb,var(--ui-base,var(--ui-text-primary)) 30%,transparent)'; el.append(probe);
    const quiet = getComputedStyle(probe).color; probe.remove();
    const provider = el.querySelector('.sf-provider'), token = el.querySelector('.sf-token');
    return getComputedStyle(provider).color === quiet && getComputedStyle(token).color === quiet && getComputedStyle(provider).opacity === '0.7' && getComputedStyle(token).opacity === '1';
  }));
  check('project and age contrast increased without brightening provider/tokens', await page.locator('[data-session-id="design"]').evaluate(el => {
    const project = getComputedStyle(el.querySelector('.sf-project-name')).color, time = getComputedStyle(el.querySelector('.sf-time')).color;
    const provider = getComputedStyle(el.querySelector('.sf-provider')).color, tokens = getComputedStyle(el.querySelector('.sf-token')).color;
    return project === time && provider === tokens && project !== tokens;
  }));
  await page.mouse.move(1100, 850);
  check('Input, Working and Done labels are bold', await page.locator('.sf-status').evaluateAll(labels => ['input', 'working', 'done'].every(status => labels.some(el => el.dataset.status === status && Number(getComputedStyle(el).fontWeight) >= 600))));
  const recededTitle = await titleColor('root'), primaryTitle = await tokenColor(page.locator('[data-session-id="root"]'), '--ui-text-primary');
  for (const id of ['snoozed', 'archived']) {
    const card = page.locator(`[data-session-id="${id}"]`);
    check(`${id} recedes its title exactly like Working while staying fully opaque`, await titleColor(id) === recededTitle && await card.evaluate(el => getComputedStyle(el).opacity) === '1');
    await card.hover();
    check(`${id} title returns to primary text instantly on hover`, await titleColor(id) === primaryTitle);
    check(`${id} card backgrounds keep a 2px gap from adjacent cards without changing the 56px stride`, await card.evaluate(el => {
      const style = getComputedStyle(el), next = el.parentElement.nextElementSibling?.querySelector('.sf-row') || el.nextElementSibling;
      return el.getBoundingClientRect().height === 56 && style.backgroundClip === 'padding-box' && style.borderTopWidth === '1px' && style.borderBottomWidth === '1px'
        && style.borderTopColor === 'rgba(0, 0, 0, 0)' && (!next || Math.abs(next.getBoundingClientRect().top - el.getBoundingClientRect().bottom) < .5);
    }));
    check(`${id} hover actions sit equally far from the card's top and right edges`, await card.evaluate(el => {
      // The visible card background starts inside the transparent top border.
      const card = el.getBoundingClientRect(), hover = el.querySelector('.sf-hover').getBoundingClientRect(), border = parseFloat(getComputedStyle(el).borderTopWidth);
      return Math.abs((hover.top - card.top - border) - (card.right - hover.right)) < .5;
    }));
    if (await card.locator('[aria-label="Snooze session"]').count()) check(`${id} hover alarm draws in a 15px box with a 1px line so it reads as large as Archive`, await card.locator('[aria-label="Snooze session"] svg').evaluate(el => {
      const box = el.getBoundingClientRect(), style = getComputedStyle(el);
      return box.width === 15 && box.height === 15 && style.strokeWidth === '1.6px' && style.flexShrink === '0';
    }));
    check(`${id} hover action icons and labels use the primary text color, with a 1px Archive line`, await card.locator('.sf-hover').evaluate(strip => {
      const probe = document.createElement('span'); probe.style.color = 'var(--ui-text-primary)'; strip.append(probe); const primary = getComputedStyle(probe).color; probe.remove();
      const archive = strip.querySelector('.sf-archive svg');
      return [...strip.querySelectorAll('.sf-icon')].every(button => getComputedStyle(button).color === primary) && getComputedStyle(archive).strokeWidth === '2px';
    }));
    check(`${id} hover actions appear without an opacity fade`, await card.locator('.sf-hover').evaluate(el => getComputedStyle(el).visibility === 'visible' && getComputedStyle(el).opacity === '1' && !/opacity/.test(getComputedStyle(el).transitionProperty)));
    // Desktop's SDK Button is `transition-all duration-100` (a Tailwind utility class), which also transitions inherited visibility.
    const desktopButton = await page.addStyleTag({ content: ':where(.sf-row button){transition:all 100ms}' });
    await card.hover(); await page.mouse.move(1100, 850);
    const linger = await card.evaluate(async el => {
      await new Promise(requestAnimationFrame);
      const bad = [...el.querySelectorAll('.sf-hover, .sf-hover button')].filter(node => !(getComputedStyle(node).visibility === 'hidden' && getComputedStyle(node).transitionDuration.split(',').every(value => parseFloat(value) === 0)));
      return bad.length ? bad.map(node => `${node.className}|${getComputedStyle(node).visibility}|${getComputedStyle(node).transitionDuration}|${node.matches(':hover')}`).join(' ; ') : true;
    });
    await desktopButton.evaluate(el => el.remove());
    if (linger !== true) console.log('LINGER', linger);
    check(`${id} hover actions and their buttons hide in the same frame the pointer leaves`, linger === true);
    check(`${id} recedes again when pointer leaves`, await titleColor(id) === recededTitle);
  }
  const searchField = page.locator('.sf-search');
  await searchField.locator('input').focus();
  check('search focus highlights the whole field instead of outlining the text box', await searchField.evaluate(el => getComputedStyle(el).boxShadow.includes('inset') && getComputedStyle(el.querySelector('input')).outlineStyle === 'none'));
  await searchField.locator('input').blur();
  check('search field has no focus ring at rest', await searchField.evaluate(el => getComputedStyle(el).boxShadow === 'none'));
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
    const preset = form.querySelector('.sf-snooze-action'), icon = preset.querySelector('.sf-menu-icon').getBoundingClientRect(), label = preset.querySelector('.sf-menu-label').getBoundingClientRect();
    const custom = form.querySelector('.sf-custom-snooze'), calendar = custom.querySelector('.sf-menu-icon').getBoundingClientRect();
    const input = custom.querySelector('input').getBoundingClientRect();
    return !/Custom|local time/.test(custom.textContent) && custom.querySelector('[data-icon=CalendarTime]') && Math.abs(calendar.left - icon.left) < 1 && Math.abs(input.left - label.left) < 1;
  });
  check('custom time has a calendar in the preset icon column and its field starts at the preset labels, without a text label', await customTimeAligned());
  const check_ = snoozeDialog.getByRole('button', { name: 'Apply custom snooze', exact: true });
  const green = await check_.evaluate(el => { const probe = document.createElement('span'); probe.style.color = 'var(--ui-green)'; el.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; });
  await snoozeDialog.locator('input[type=datetime-local]').fill('2020-01-01T12:00');
  const pastColor = await check_.evaluate(el => getComputedStyle(el).color);
  await snoozeDialog.locator('input[type=datetime-local]').fill(`${new Date().getFullYear() + 2}-01-01T12:00`);
  check('custom checkmark turns green only for a valid future time', pastColor !== green && await check_.evaluate(el => getComputedStyle(el).color) === green);
  check('custom checkmark is a bold, filled 28px button', await check_.evaluate(el => getComputedStyle(el.querySelector('svg')).strokeWidth === '3.5px' && el.getBoundingClientRect().width === 28 && getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)'));
  check('custom checkmark is centred in its button', await check_.evaluate(el => {
    const b = el.getBoundingClientRect(), s = el.querySelector('svg').getBoundingClientRect();
    return Math.abs((s.left + s.right) / 2 - (b.left + b.right) / 2) < .5 && Math.abs((s.top + s.bottom) / 2 - (b.top + b.bottom) / 2) < .5;
  }));
  await snoozeDialog.locator('input[type=datetime-local]').fill('');
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
  await page.keyboard.press('Escape');
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
  await page.keyboard.press('Escape');
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
    const probe = document.createElement('span'); probe.style.color = 'var(--sf-blue)'; el.append(probe);
    const blue = getComputedStyle(probe).color; probe.remove();
    return el.dataset.working === 'true' && el.dataset.dimmed === 'false' && getComputedStyle(el).opacity === '1' && /^Working\d+m$/.test(el.querySelector('[data-status=working]')?.textContent) && getComputedStyle(el.querySelector('.sf-time')).color === blue;
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
  check('snoozed worker shows remaining time in non-bold theme purple instead of age', await worker.locator('.sf-snooze-time').evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'var(--sf-purple)'; el.append(probe);
    const purple = getComputedStyle(probe).color; probe.remove();
    return el.textContent === '1h' && !el.querySelector('.sf-status') && getComputedStyle(el).color === purple && getComputedStyle(el).fontWeight === '400' && getComputedStyle(el).visibility === 'visible';
  }));
  check('a running snoozed card shows the blue Working icon and time between tokens and the countdown', await worker.evaluate(row => {
    const token = row.querySelector('.sf-token').getBoundingClientRect(), working = row.querySelector('.sf-snooze-working'), countdown = row.querySelector('.sf-snooze-time').getBoundingClientRect();
    const probe = document.createElement('span'); probe.style.color = 'var(--sf-blue)'; row.append(probe); const blue = getComputedStyle(probe).color; probe.remove();
    const box = working.getBoundingClientRect(), status = working.querySelector('[data-status=working]');
    return /^Working\d+m$/.test(status.textContent) && getComputedStyle(status).color === blue && token.right < box.left && box.right < countdown.left;
  }));
  await worker.hover();
  check('snoozed Working badge hides on hover like the other metadata', await worker.locator('.sf-snooze-working').evaluate(el => getComputedStyle(el).visibility === 'hidden'));
  await page.mouse.move(1100, 850);
  check('snooze purple mixes Desktop purple with the base text color for contrast', await worker.locator('.sf-snooze-time').evaluate(el => {
    const color = value => { const probe = document.createElement('span'); probe.style.color = value; el.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; };
    return getComputedStyle(el).color === color('oklch(from color-mix(in oklab,var(--ui-purple) 65%,var(--ui-base,var(--ui-text-primary))) l calc(c * 2) h)') && getComputedStyle(el).color !== color('var(--ui-purple)');
  }));
  check('purple alarm-snooze icon is left of the rounded duration, with no left suffix', await worker.locator('.sf-snooze-time').evaluate(el => {
    const icon = el.querySelector('svg'), duration = el.querySelector('.sf-snooze-duration');
    const i = icon.getBoundingClientRect(), d = duration.getBoundingClientRect(), style = getComputedStyle(el);
    return el.firstElementChild === icon && icon.getAttribute('aria-hidden') === 'true' && getComputedStyle(icon).color === style.color && getComputedStyle(icon).stroke === style.color && getComputedStyle(duration).color === style.color && i.width === 16 && i.right < d.left && Math.abs(i.top + i.height / 2 - d.top - d.height / 2) < 1 && /^\d+[mhd]$/.test(duration.textContent);
  }));
  check('card project glyphs start at the title left edge, while pickers keep their centred icon column', await page.locator('.sf-row').evaluateAll(rows => rows.slice(0, 6).every(row => {
    const range = document.createRange(); range.selectNodeContents(row.querySelector('.sf-row-title'));
    const box = row.querySelector('.sf-project-icon'), style = getComputedStyle(box);
    return Math.abs(box.getBoundingClientRect().left - range.getBoundingClientRect().left) < .5 && style.justifyContent === 'flex-start';
  })));
  check('session-card project icon/name gap is compact at 4px', await worker.locator('.sf-project').evaluate(el => getComputedStyle(el).columnGap === '4px'));
  check('snooze does not stop or alter the live worker', await page.evaluate(() => window.hermesT3SidebarHarness.control.live.find(item => item.id === 'runtime-worker').status === 'working'));
  await worker.hover(); await worker.getByRole('button', { name: 'Snooze session', exact: true }).click();
  const unsnooze = snoozeDialog.getByRole('button', { name: 'Unsnooze', exact: true });
  check('Unsnooze is the first enabled Snooze menu action and uses theme green', await snoozeDialog.locator('form > button:not(:disabled)').first().textContent() === 'Unsnooze' && await unsnooze.evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'var(--ui-green)'; el.append(probe);
    const green = getComputedStyle(probe).color; probe.remove();
    return getComputedStyle(el).color === green;
  }));
  check('snoozed menu starts with one disabled purple info row before Unsnooze', await snoozeDialog.locator('form').evaluate(form => {
    const [info, unsnooze] = form.children;
    const probe = document.createElement('span'); probe.style.color = 'var(--sf-purple)'; form.append(probe);
    const purple = getComputedStyle(probe).color; probe.remove();
    return info.disabled && /^(\d+d \d+h |\d+h )?\d+min left$/.test(info.querySelector('.sf-snooze-remaining').textContent) && unsnooze.textContent === 'Unsnooze' && getComputedStyle(info).color === purple && getComputedStyle(info).opacity === '1';
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
  check('custom calendar and field also align with the presets in an existing snooze menu', await customTimeAligned());
  await snoozeDialog.screenshot({ path: join(screenshotDir, 'snoozed-menu.png') });
  check('Snooze actions use AlarmOff, ClockHour1, ClockHour3, Sun and calendar as aligned leading icons', await snoozeDialog.locator('.sf-menu-action').evaluateAll(actions => {
    const names = actions.map(el => el.querySelector('[data-codicon]')?.dataset.codicon || el.querySelector('[data-icon]')?.dataset.icon);
    return JSON.stringify(names) === JSON.stringify(['AlarmOff', 'ClockHour1', 'ClockHour3', 'Sun', 'calendar']) && actions.every(el => {
      const icon = el.querySelector('.sf-menu-icon'), label = el.querySelector('.sf-menu-label');
      const i = icon.getBoundingClientRect(), l = label.getBoundingClientRect();
      return el.firstElementChild === icon && icon.getAttribute('aria-hidden') === 'true' && i.width === 14 && i.right < l.left && Math.abs(i.top + i.height / 2 - l.top - l.height / 2) < 1;
    });
  }));
  check('combined disabled snooze information row remains completely icon-free', await snoozeDialog.locator('.sf-snooze-info').evaluateAll(rows => rows.length === 1 && rows.every(el => el.disabled && !el.querySelector('.sf-menu-icon,svg,[data-codicon]'))));
  check('Unsnooze alarm-off icon inherits the green action color', await unsnooze.evaluate(el => getComputedStyle(el.querySelector('[data-icon=AlarmOff]')).color === getComputedStyle(el).color));
  await unsnooze.hover();
  check('Unsnooze stays green on hover', await unsnooze.evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'var(--ui-green)'; el.append(probe);
    const green = getComputedStyle(probe).color; probe.remove(); return getComputedStyle(el).color === green;
  }));
  await unsnooze.click();
  await page.locator('section[aria-label="Working"] [data-session-id="root"]').waitFor();
  check('Unsnooze returns the running card to Working and removes its countdown', /^Working\d+m$/.test(await worker.locator('[data-status=working]').textContent()) && !await worker.locator('.sf-snooze-time').count());
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
  check('each context action aligns a decorative icon before its text', await context.locator('.sf-menu-action').evaluateAll(actions => actions.length === 7 && actions.every(action => {
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
  check('stored-only Rename is enabled without an inline disclaimer', !await context.getByRole('button', { name: 'Rename', exact: true }).isDisabled() && !/live runtime/i.test(await context.innerText()));
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
  check('selected project uses a row background instead of a trailing check', await filters.locator('.sf-project-choice').evaluateAll(choices => {
    const selected = choices.filter(el => el.getAttribute('aria-pressed') === 'true'), other = choices.find(el => el.getAttribute('aria-pressed') === 'false');
    const background = el => getComputedStyle(el).backgroundColor, rest = 'rgba(0, 0, 0, 0)';
    return selected.length === 1 && background(selected[0]) !== rest && background(selected[0]) !== background(other)
      && choices.every(el => el.querySelectorAll(':scope > svg').length === 0 && el.querySelector('.sf-project-path, .sf-project-name').parentElement.nextElementSibling === null);
  }));
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
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
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
  await page.keyboard.press('Escape');
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
  check('durable wake marker shows purple Woke with icon and bold title', await design.evaluate(el => {
    const badge = el.querySelector('.sf-status'), probe = document.createElement('span'); probe.style.color = 'var(--sf-purple)'; badge.append(probe);
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
    fixture.control.rows.push({ id: 'synthetic-runtime-draft', source: 'desktop', message_count: 1, provider: null, total_tokens: 0,
      cwd: '/synthetic/robot', project: { name: 'Draft robot' } });
    Object.assign(fixture.control.live.find(row => row.session_key === 'synthetic-runtime-draft'), { message_count: 1, status: 'working', turn_started_at: Date.now() / 1000 });
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  });
  await page.locator('[data-section="working"] [data-session-id="synthetic-runtime-draft"]').waitFor();
  check('first persisted prompt keeps its runtime provider icon while token usage is still zero', await runtimeDraft.locator('[data-provider-mark="anthropic"]').count() === 1 && await runtimeDraft.locator('.sf-token').textContent() === '0');
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    Object.assign(fixture.control.rows.find(row => row.id === 'synthetic-runtime-draft'), { title: 'First robot response', message_count: 2, provider: 'anthropic', total_tokens: 2000 });
    Object.assign(fixture.control.live.find(row => row.session_key === 'synthetic-runtime-draft'), { message_count: 2, status: 'idle', provider: null });
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  });
  await runtimeDraft.locator('.sf-row-title').filter({ hasText: 'First robot response' }).waitFor();
  check('persisted provider takes over after the response without depending on runtime provider metadata', await runtimeDraft.locator('[data-provider-mark="anthropic"]').count() === 1 && await runtimeDraft.locator('.sf-token').textContent() === '2K');
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    fixture.control.rows = fixture.control.rows.filter(row => row.id !== 'synthetic-runtime-draft');
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
    // Opt in to the detailed Working indicator for the subagent checks, as the settings switch would.
    localStorage.setItem('hermes.plugin.hermes-t3sidebar.working-details', 'true');
    fixture.queryClient.setQueryData(['hermes-t3sidebar-preferences', 'working-details'], true);
    fixture.control.live.find(row => row.session_key === 'design').running_subagents = 2;
    // Its own turn ended after dispatching; the backend keeps that turn's start.
    fixture.control.metadata.runs = { design: { started_at: Date.now() / 1000 - 300, ended_at: Date.now() / 1000 - 240 } };
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  });
  await page.locator('[data-section="working"] [data-session-id="design"]').waitFor();
  check('idle parent with running subagents shows blue Working counted from its last turn start and stays dimmed', await design.getAttribute('data-working') === 'true' && await design.locator('.sf-status').textContent() === '+2Working: 2 subagents running5m');
  check('idle parent draws the dashed ring, then a regular-weight +2 touching it and before the bold elapsed time', await design.locator('.sf-status').evaluate(el => {
    const ring = el.querySelector('svg[data-status-icon=working]').getBoundingClientRect(), count = el.querySelector('.sf-subagents').getBoundingClientRect(), time = el.querySelector('.sf-working-duration').getBoundingClientRect();
    const centre = rect => rect.top + rect.height / 2;
    return el.dataset.agent === 'false' && el.querySelectorAll('svg path').length === 8 && Math.abs(count.left - ring.right) <= 0.5
      && time.left - count.right >= 3 && Math.abs(centre(count) - centre(time)) <= 1
      && getComputedStyle(el.querySelector('.sf-subagents')).fontWeight === '400' && getComputedStyle(el.querySelector('.sf-working-duration')).fontWeight === '600';
  }));
  // The same card compacting: the pinched ring replaces the dashed one, +2 and the time stay put.
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    fixture.control.live.find(row => row.session_key === 'design').compacting = true;
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  });
  await page.waitForFunction(() => document.querySelector('[data-session-id="design"] .sf-status')?.dataset.compacting === 'true');
  check('a compacting card draws the pinched ring, centred, with +2 touching it and its own hover detail', await design.locator('.sf-status').evaluate(el => {
    const ring = el.querySelector('svg[data-status-icon=working]').getBoundingClientRect(), count = el.querySelector('.sf-subagents').getBoundingClientRect(), tokens = el.closest('.sf-card-meta').querySelector('.sf-token').getBoundingClientRect();
    const centre = rect => rect.top + rect.height / 2;
    return el.querySelectorAll('svg path').length === 6 && ring.width === 13 && Math.abs(centre(ring) - centre(tokens)) <= 1 && Math.abs(count.left - ring.right) <= 0.5
      && el.querySelector('.sf-sr').textContent === 'Working: Compacting context · 2 subagents running' && el.closest('.sf-open').title.endsWith('\nCompacting context · 2 subagents running');
  }));
  await design.screenshot({ path: join(screenshotDir, 'compacting-card.png') });
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    fixture.control.live.find(row => row.session_key === 'design').compacting = false;
    await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
  });
  await page.waitForFunction(() => document.querySelector('[data-session-id="design"] .sf-status')?.dataset.compacting === undefined);
  await page.evaluate(async () => {
    const fixture = window.hermesT3SidebarHarness;
    fixture.control.live.find(row => row.session_key === 'design').running_subagents = 0;
    delete fixture.control.metadata.runs;
    localStorage.removeItem('hermes.plugin.hermes-t3sidebar.working-details');
    fixture.queryClient.setQueryData(['hermes-t3sidebar-preferences', 'working-details'], false);
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
  const fade = () => page.evaluate(() => Object.fromEntries(['active', 'working'].map(name => {
    const body = document.querySelector(`[data-section="${name}"] .sf-section-body`);
    return [name, { more: body.dataset.moreBelow, mask: getComputedStyle(body).maskImage }];
  })));
  const fadeTop = await fade();
  check('a scrollable list fades its bottom edge toward the next heading', fadeTop.active.more === 'true' && fadeTop.active.mask.includes('linear-gradient') && (fadeTop.working.more !== 'true' || fadeTop.working.mask.includes('linear-gradient')));
  await page.locator('[data-section="active"] .sf-section-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.waitForFunction(() => document.querySelector('[data-section="active"] .sf-section-body').dataset.moreBelow === 'false');
  check('the fade disappears at the end of the list', (await fade()).active.mask === 'none');
  await page.locator('[data-section="active"] .sf-section-body').evaluate(el => { el.scrollTop = 0; });
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
    const steady = await page.evaluate(async shelf => {
      const section = document.querySelector(`[data-section="${shelf}"]`), toggle = section.querySelector('.sf-section-toggle'), body = section.querySelector('.sf-section-body');
      const open = body.getBoundingClientRect().height, samples = [];
      const collect = async () => { const start = performance.now(); while (performance.now() - start < 200) { await new Promise(requestAnimationFrame); samples.push({ section: section.getBoundingClientRect().height, body: body.getBoundingClientRect().height, masked: getComputedStyle(section).maskImage !== 'none' }); } };
      toggle.click(); await collect();
      const closing = samples.splice(0);
      toggle.click(); await collect();
      await new Promise(resolve => setTimeout(resolve, 150));
      return { open, closing, opening: samples, released: !section.dataset.pinned && getComputedStyle(section).maskImage === 'none' && Math.abs(body.getBoundingClientRect().height - open) < 1 };
    }, shelf);
    const moving = phase => phase.filter(sample => sample.section > 31 && sample.section < motion.before - 1);
    check(`${shelf} fold and unfold move only the section edge: the list keeps its height under a fading edge, then releases`,
      moving(steady.closing).length > 0 && moving(steady.opening).length > 0
      && [...moving(steady.closing), ...moving(steady.opening)].every(sample => Math.abs(sample.body - steady.open) < 1 && sample.masked) && steady.released);
    check(`${shelf} fold and unfold animate real category height, not just the chevron`, motion.closing.some(h => h > 31 && h < motion.before - 1) && motion.opening.some(h => h > 31 && h < motion.before - 1) && Math.abs(motion.closed - 30) < 1 && Math.abs(motion.final - motion.before) < 1 && motion.inaccessible && motion.reopened);
    const rapid = await page.evaluate(async shelf => {
      const section = document.querySelector(`[data-section="${shelf}"]`), toggle = section.querySelector('.sf-section-toggle');
      const before = section.getBoundingClientRect().height;
      const wait = async ms => { const start = performance.now(); while (performance.now() - start < ms) await new Promise(requestAnimationFrame); };
      const intermediate = async () => {
        const start = performance.now();
        while (performance.now() - start < 260) {
          await new Promise(requestAnimationFrame);
          const height = section.getBoundingClientRect().height;
          if (height > 31 && height < before - 1) return true;
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
      const closed = section.dataset.closed === 'true' && section.querySelector('.sf-section-body').inert && Math.abs(section.getBoundingClientRect().height - 30) < 1;
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
    check(`${height}px: Pinned before headerless Ready, secondary headings fixed and visible`, layout.sections.map(s => s.name).join(',') === 'pinned,active,working,snoozed,archived' && layout.sections.slice(0, 2).every(s => !s.header) && layout.sections.slice(2).every(s => s.header.height === 30 && s.header.top >= layout.list.top && s.header.bottom <= layout.root.bottom && s.body.top >= s.header.bottom));
    check(`${height}px: no whole-list scrolling; all five bodies constrained`, layout.overflow === 'hidden' && layout.listScrollHeight <= layout.listHeight + 1 && layout.sections.every(s => s.body.height > 0 && s.body.bottom <= layout.list.bottom + 1 && s.scrollHeight > s.body.height));
    const shares = await page.locator('.sf-shelves').evaluate(el => ({ height: el.getBoundingClientRect().height, ...Object.fromEntries([...el.children].map(s => [s.dataset.section, s.getBoundingClientRect().height])) }));
    check(`${height}px: dense Ready takes its 40% first and constrained Working, Snoozed and Archived share the rest equally`, Math.abs(shares.active - shares.height * .4) <= 1.5
      && Math.max(shares.working, shares.snoozed, shares.archived) - Math.min(shares.working, shares.snoozed, shares.archived) <= 1 && layout.sections.every(s => s.body.height > 0));
    await page.getByRole('searchbox').fill('SYNTHETIC snoozed'); await page.waitForTimeout(100);
    check(`${height}px: Snoozed grows past 40% into space nobody else needs`, await page.locator('.sf-shelves').evaluate(el => el.querySelector('[data-section=snoozed]').getBoundingClientRect().height > el.getBoundingClientRect().height * .6));
    await page.getByRole('searchbox').fill('SYNTHETIC archived'); await page.waitForTimeout(100);
    check(`${height}px: Archived stops at 40%, leaving blank space under Ready with headings at the bottom`, await page.locator('.sf-shelves').evaluate(el => {
      const shelves = el.getBoundingClientRect(), archived = el.querySelector('[data-section=archived]').getBoundingClientRect();
      return Math.abs(archived.height - shelves.height * .4) <= 1 && Math.abs(archived.bottom - shelves.bottom) <= 1 && el.querySelector('[data-section=archived]').querySelectorAll('.sf-row').length === 20;
    }));
    await page.getByRole('searchbox').fill(''); await page.waitForTimeout(100);
    check(`${height}px: dense Snoozed gets the same two-card minimum before Archived`, await page.locator('[data-section="snoozed"]').evaluate(el => {
      const grid = el.parentElement.getBoundingClientRect().height;
      return el.getBoundingClientRect().height >= Math.min(30 + 2 * 56, grid * .2) - 1;
    }));
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
    if (!count) check('empty Pinned reserves no space and Ready starts at the top', await page.locator('[data-section="pinned"]').evaluate(el => el.getBoundingClientRect().height === 0 && !el.querySelector('.sf-row')) && await page.locator('.sf-scroll').evaluate(list => Math.abs(list.getBoundingClientRect().top - list.querySelector('[data-section="active"]').getBoundingClientRect().top) <= 1));
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
    check(`Working with ${count} cards shrinks to content without blank space`, await page.locator('[data-section="working"]').evaluate((el, count) => Math.abs(el.getBoundingClientRect().height - (30 + count * 56)) <= 1, count));
    check(`Working ${count}: CSS flex sizes it from its content, with no inline size`, await page.locator('[data-section="working"]').evaluate(el => getComputedStyle(el.parentElement).display === 'flex' && !el.style.height && !el.style.maxHeight && !el.parentElement.style.gridTemplateRows));
    if (!count) check('empty Working retains only its 30px header and no scroll-body footprint', await page.locator('[data-section="working"]').evaluate(el => el.querySelector('.sf-section-toggle').getBoundingClientRect().height === 30 && el.querySelector('.sf-section-body').getBoundingClientRect().height === 0));
    if (count === 2) {
      // A CSS row-size change must flow through intrinsic layout without new data.
      await page.locator('.harness-sidebar').evaluate(el => { el.style.height = '1800px'; });
      const css = await page.addStyleTag({ content: '[data-section="working"] .sf-row{height:70px}' });
      check('Working follows actual CSS content height without recalculating JavaScript row geometry', await page.locator('[data-section="working"]').evaluate(el => Math.abs(el.getBoundingClientRect().height - 170) <= 1));
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

    // The Usage/Limits footer is a fixed row below the list. Pad each pane by its height so these cases keep testing the same list heights they did before the footer existed (the 300px case is the shortest list the flex minima fit with an error note).
    const footerHeight = await page.locator('.sf-footer').evaluate(el => el.getBoundingClientRect().height);
    for (const base of [300, 350, 400]) {
      const height = base + footerHeight;
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
            return r.height === 30 && r.top >= bounds.top && r.bottom <= bounds.bottom + 1;
          }),
          bodies: [...list.querySelectorAll('.sf-section-body')].every(el => {
            const r = el.getBoundingClientRect();
            return r.height > 0 && r.top >= bounds.top && r.bottom <= bounds.bottom + 1 && el.scrollHeight > el.clientHeight;
          })
        };
      });
      check(`${base}px list pane (+${footerHeight}px footer)${banner === 'error' ? ' with error' : ''}: headers and complete scroll bodies fit without outer clipping`, geometry.fits && geometry.headers && geometry.bodies);
      check(`${base}px list pane ${banner}: tight card text preserves 56px rows and 19px lines`, geometry.tightCards);
      check(`${base}px list pane ${banner}: no Undo or dismiss-Undo controls`, await noUndo());
      if (base === 300 && banner === 'error') await page.locator('.harness-sidebar').screenshot({ path: join(screenshotDir, 'short-300-error.png') });
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
  await page.keyboard.press('Escape');
  await presetSetting.fill('09:00');
  const detailsSwitch = page.getByRole('switch', { name: 'Detailed Working indicator', exact: true });
  const rootBadge = () => page.locator('[data-session-id="root"] .sf-status').evaluate(el => ({ agent: el.dataset.agent ?? null, paths: el.querySelectorAll('svg path').length }));
  check('Detailed Working indicator defaults off with the plain dashed circle', await detailsSwitch.getAttribute('aria-checked') === 'false' && JSON.stringify(await rootBadge()) === JSON.stringify({ agent: null, paths: 8 }));
  await detailsSwitch.click();
  await page.waitForFunction(() => document.querySelector('[data-session-id="root"] .sf-status')?.dataset.agent === 'true');
  check('turning on the detailed indicator draws the solid agent ring without a reload', JSON.stringify(await rootBadge()) === JSON.stringify({ agent: 'true', paths: 1 }));
  await page.reload();
  await page.getByRole('button', { name: 'Plugin settings', exact: true }).click();
  check('detailed indicator setting persists across actual browser reload', await detailsSwitch.getAttribute('aria-checked') === 'true' && (await rootBadge()).agent === 'true');
  await detailsSwitch.click();
  await page.waitForFunction(() => document.querySelector('[data-session-id="root"] .sf-status')?.dataset.agent === undefined);
  check('turning it off restores the plain dashed circle', JSON.stringify(await rootBadge()) === JSON.stringify({ agent: null, paths: 8 }));
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
    await page.keyboard.press('Escape');
    await picker.getByRole('searchbox', { name: 'Search projects' }).fill('~/second');
    check(`${trigger} path search preserves the non-selectable parent and matching folder only`, await picker.locator('.sf-project-folder').count() === 1 && await heading.count() === 1 && !await picker.getByRole('button', { name: `${prefix} Single workspace`, exact: true }).count());
    await picker.getByRole('searchbox', { name: 'Search projects' }).fill('');
    await picker.screenshot({ path: join(screenshotDir, `${prefix === 'Filter by' ? 'filter' : 'new-session'}-project-picker.png`) });
    await page.keyboard.press('Escape');
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
      await page.keyboard.press('Escape');
    }
  }
  await contentBox.evaluate(el => el.remove());
  {
    // Cards enter and leave by clipping their slot while the card keeps its full height; content-sized shelves follow.
    const motion = await browser.newPage({ viewport: { width: 900, height: 760 } });
    motion.on('pageerror', error => errors.push(error));
    await motion.emulateMedia({ reducedMotion: 'no-preference' });
    await motion.goto(`http://127.0.0.1:${server.address().port}`);
    await motion.waitForSelector('[data-session-id="root"][data-working=true]');
    await motion.waitForTimeout(400);
    const sample = () => motion.evaluate(() => ({
      ghosts: [...document.querySelectorAll('[data-exiting=true]')].map(ghost => ({ height: ghost.getBoundingClientRect().height, inert: ghost.inert, hidden: ghost.getAttribute('aria-hidden'), ids: ghost.querySelectorAll('[data-session-id]').length })),
      entering: [...document.querySelectorAll('.sf-slot:not([data-exiting])')].map(slot => slot.getBoundingClientRect().height).filter(height => height > 0 && height < 55),
      rows: [...document.querySelectorAll('.sf-row')].every(row => Math.abs(row.getBoundingClientRect().height - 56) < .5),
      working: document.querySelector('[data-section=working]').getBoundingClientRect().height }));
    const rest = await sample();
    await motion.getByRole('searchbox').fill('zzzz-no-match');
    await motion.waitForTimeout(90);
    const leaving = await sample();
    check('search-removed cards collapse as inert, id-free ghosts while each card keeps its full height', leaving.ghosts.length > 0 && leaving.ghosts.every(ghost => ghost.height > 1 && ghost.height < 55 && ghost.inert && ghost.hidden === 'true' && !ghost.ids) && leaving.rows);
    check('content-sized Working shrinks with its leaving card instead of jumping', leaving.working > 31 && leaving.working < rest.working - 1);
    await motion.waitForTimeout(400);
    check('exit ghosts are removed once collapsed', (await sample()).ghosts.length === 0);
    await motion.getByRole('searchbox').fill('');
    await motion.waitForTimeout(90);
    const returning = await sample();
    check('cards returning from search grow from a clipped slot and Working grows with them', returning.entering.length > 0 && returning.rows && returning.working > 31 && returning.working < rest.working - 1);
    await motion.waitForTimeout(400);
    check('returned cards settle at their full stride', (await sample()).entering.length === 0 && Math.abs((await sample()).working - rest.working) < 1);
    // Moving categories: Ready -> Working leaves a ghost in Ready and grows a slot in Working.
    await motion.evaluate(async () => {
      const fixture = window.hermesT3SidebarHarness;
      const live = fixture.control.live.find(row => row.session_key === 'design');
      if (live) live.running_subagents = 2;
      else fixture.control.live.push({ id: 'runtime-design', session_key: 'design', status: 'idle', running_subagents: 2 });
      await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
    });
    await motion.locator('[data-section="working"] [data-session-id="design"]').waitFor();
    const moving = await motion.evaluate(() => ({
      ghost: !!document.querySelector('[data-section=active] [data-exiting=true]'),
      slot: document.querySelector('[data-section=working] [data-session-id="design"]').closest('.sf-slot').getBoundingClientRect().height }));
    check('a card changing category collapses out of Ready and grows into Working', moving.ghost && moving.slot < 55);
    await motion.close();
  }
  {
    // Re-revealing an already-focused small-list card must not queue focus for the next outside click.
    const focus = await browser.newPage({ viewport: { width: 900, height: 400 } });
    focus.on('pageerror', error => errors.push(error));
    await focus.emulateMedia({ reducedMotion: 'reduce' });
    await focus.goto(`http://127.0.0.1:${server.address().port}`);
    await focus.locator('[data-session-id="root"][data-working=true]').waitFor();
    await focus.evaluate(async () => {
      const fixture = window.hermesT3SidebarHarness;
      fixture.control.rows = Array.from({ length: 12 }, (_, index) => ({ id: `focus-${index}`, title: `Focus probe ${index}`, message_count: 2, last_active: 100 - index }));
      fixture.control.extra = []; fixture.control.live = []; fixture.control.metadata = { version: 1, sessions: {} };
      fixture.host.state.focusedStoredSessionId.set(null);
      const composer = document.createElement('textarea'); composer.setAttribute('aria-label', 'Composer probe');
      document.querySelector('.harness-main').append(composer);
      await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
    });
    await focus.waitForFunction(() => document.querySelectorAll('[data-section=active] [data-session-id]').length === 12);
    const body = focus.locator('[data-section=active] .sf-section-body');
    check('small-list focus fixture is scrollable without windowing', await body.evaluate(el => el.scrollHeight > el.clientHeight) && await focus.locator('[data-section=active] .sf-row').count() === 12);
    for (const [id, key, scrollToEnd, outside] of [
      ['focus-11', 'End', false, 'Search sessions'],
      ['focus-11', 'ArrowDown', false, 'Composer probe'],
      ['focus-0', 'Home', true, 'Search sessions'],
      ['focus-0', 'ArrowUp', true, 'Composer probe'],
      ['focus-0', 'Home', false, 'Search sessions']
    ]) {
      await focus.locator(`[data-session-id="${id}"] .sf-open`).focus();
      await body.evaluate(async (el, end) => { el.scrollTop = end ? el.scrollHeight : 0; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); }, scrollToEnd);
      await focus.keyboard.press(key);
      check(`${key} reveals its already-focused small-list card`, await body.evaluate((el, last) => last ? el.scrollTop > 0 : el.scrollTop === 0, id === 'focus-11'));
      await focus.getByRole(outside === 'Search sessions' ? 'searchbox' : 'textbox', { name: outside, exact: true }).click();
      check(`${key} small-list reveal does not steal ${outside} focus on blur`, await focus.getByLabel(outside, { exact: true }).evaluate(el => document.activeElement === el));
    }
    await focus.close();
  }
  {
    const gap = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
    gap.on('pageerror', error => errors.push(error.message));
    await gap.emulateMedia({ reducedMotion: 'reduce' });
    await gap.goto(`http://127.0.0.1:${server.address().port}`);
    await gap.locator('[data-session-id="pinned"]').waitFor();
    const measure = () => gap.locator('[data-section="pinned"]').evaluate(el => ({
      height: el.getBoundingClientRect().height,
      space: el.nextElementSibling.getBoundingClientRect().top - el.getBoundingClientRect().bottom,
      margin: parseFloat(getComputedStyle(el).marginBottom),
      row: el.querySelector('.sf-row')?.getBoundingClientRect().height ?? 0
    }));
    await gap.getByRole('button', { name: 'Plugin settings', exact: true }).click();
    const toggle = gap.getByRole('switch', { name: 'Pinned session gap', exact: true });
    check('Pinned session gap defaults off with the original 1px shelf spacing', await toggle.getAttribute('aria-checked') === 'false' && (await measure()).space === 1);
    await toggle.click();
    await gap.waitForFunction(() => document.querySelector('.sf-scroll')?.dataset.pinnedGap === 'true');
    const enabled = await measure();
    check('Pinned session gap adds exactly a quarter-row outside the unchanged pinned body', enabled.space === 1 + enabled.row / 4 && enabled.margin === enabled.row / 4 && enabled.height === enabled.row);
    await gap.reload();
    await gap.locator('[data-session-id="pinned"]').waitFor();
    check('Pinned session gap persists through a real browser reload', (await measure()).space === enabled.space);
    await gap.getByRole('button', { name: 'Plugin settings', exact: true }).click();
    check('Pinned session gap toggle reads its persisted value', await toggle.getAttribute('aria-checked') === 'true');
    const custom = await gap.addStyleTag({ content: ':root{--sf-card-content:44px;--sf-card-padding:7px;--sf-card-margin:2px}' });
    const themed = await measure();
    check('Pinned session gap follows custom card geometry without JavaScript measurements', themed.row === 62 && themed.space === 1 + themed.row / 4);
    await custom.evaluate(el => el.remove());
    await gap.getByRole('searchbox', { name: 'Search sessions', exact: true }).fill('Design review');
    await gap.waitForFunction(() => document.querySelector('[data-section=pinned]')?.dataset.populated === 'false');
    check('search hiding all pinned cards removes their gap and reserved space', await gap.locator('.sf-scroll').evaluate(el => {
      const pinned = el.querySelector('[data-section=pinned]'), ready = el.querySelector('[data-section=active]');
      return pinned.getBoundingClientRect().height === 0 && getComputedStyle(pinned).marginBottom === '-1px' && ready.getBoundingClientRect().top === el.getBoundingClientRect().top;
    }));
    await gap.getByRole('searchbox', { name: 'Search sessions', exact: true }).fill('');
    await gap.locator('[data-session-id="pinned"]').waitFor();
    check('clearing search restores the enabled pinned gap', (await measure()).space === enabled.space);
    await toggle.click();
    await gap.waitForFunction(() => document.querySelector('.sf-scroll')?.dataset.pinnedGap === 'false');
    check('disabling Pinned session gap immediately restores the original spacing', (await measure()).space === 1);
    await toggle.click();
    await gap.waitForFunction(() => document.querySelector('.sf-scroll')?.dataset.pinnedGap === 'true');
    await gap.evaluate(async () => {
      const fixture = window.hermesT3SidebarHarness; fixture.loadDenseFixtures();
      await fixture.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar'] });
    });
    await gap.locator('[data-session-id="synthetic-pinned-000"]').waitFor();
    for (const height of [300, 400, 650]) {
      await gap.locator('.harness-sidebar').evaluate((el, height) => { el.style.height = `${height}px`; }, height);
      check(`${height}px with pinned gap: capped pinned scrolling and all secondary headings fit`, await gap.locator('.sf-scroll').evaluate(el => {
        const pinned = el.querySelector('[data-section=pinned]'), body = pinned.querySelector('.sf-section-body');
        return el.scrollHeight <= el.clientHeight + 1 && pinned.getBoundingClientRect().height <= el.clientHeight * .18 + 1 && body.scrollHeight > body.clientHeight &&
          [...el.querySelectorAll('.sf-section-toggle')].every(header => header.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom + 1);
      }));
      check(`${height}px with pinned gap: spacing stays exactly a quarter-row`, (await measure()).space === 15);
    }
    await gap.close();
  }
  {
    // Card geometry is themeable: a different content/padding/margin must drive heights, gaps, windowing and shelf minimums alike.
    // 936px = the former 900px plus the 36px Usage/Limits footer, so the shelves get the list height this case was written for (the 20% minimum already sits 1px under the formula, so a shorter list pushes rounding past the 1px tolerance).
    const geometry = await browser.newPage({ viewport: { width: 1200, height: 936 }, deviceScaleFactor: 1 });
    geometry.on('pageerror', error => errors.push(error));
    // Shelf tracks animate when the fixture changes card counts; measure final layout, like the main page.
    await geometry.emulateMedia({ reducedMotion: 'reduce' });
    await geometry.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style'); style.textContent = ':root{--sf-card-content:44px;--sf-card-padding:7px;--sf-card-margin:2px}'; document.head.append(style);
    }));
    await geometry.goto(`http://127.0.0.1:${server.address().port}`);
    await geometry.waitForSelector('.sf-row');
    await geometry.evaluate(() => window.hermesT3SidebarHarness.loadDenseFixtures());
    await geometry.locator('[data-session-id="synthetic-active-000"]').waitFor();
    await geometry.waitForFunction(() => document.querySelector('[data-session-id="synthetic-working-000"]')?.dataset.working === 'true');
    const layout = await geometry.evaluate(() => {
      const row = document.querySelector('[data-session-id="synthetic-active-001"]'), style = getComputedStyle(row), open = getComputedStyle(row.querySelector('.sf-open'));
      const ready = document.querySelector('[data-section="active"] .sf-window'), shelves = document.querySelector('.sf-shelves').getBoundingClientRect().height;
      const top = id => document.querySelector(`[data-session-id="${id}"]`).parentElement.getBoundingClientRect().top;
      return { height: row.getBoundingClientRect().height, margin: style.borderTopWidth, padding: open.paddingTop, spacer: ready.getBoundingClientRect().height,
        step: top('synthetic-active-001') - top('synthetic-active-000'), working: document.querySelector('[data-section="working"]').getBoundingClientRect().height, shelves };
    });
    check('custom card content, padding and margin drive the row height, gap and windowed stride', layout.height === 62 && layout.margin === '2px' && layout.padding === '7px' && layout.step === 62 && layout.spacer === 100 * 62);
    check('custom card geometry drives the two-card shelf minimum', Math.abs(layout.working - Math.max(layout.shelves * .18, Math.min(30 + 2 * 62, layout.shelves * .2))) <= 1);
    await geometry.close();
  }
  {
    // Usage footer and page: the real plugin tree under the mocked SDK (not live Electron), with synthetic usage payloads.
    const usageDir = process.env.USAGE_SCREENSHOT_DIR || '/home/hermes/.hermes/cache/scratch/usage-viz';
    await mkdir(usageDir, { recursive: true });
    const usage = await browser.newPage({ viewport: { width: 1300, height: 1000 }, deviceScaleFactor: 1, timezoneId: 'Europe/Paris' });
    usage.on('pageerror', error => errors.push(error.message));
    await usage.emulateMedia({ reducedMotion: 'reduce' });
    // A fixed weekday afternoon makes the clock-relative limits fixture (office-hours drain, idle nights and weekends) deterministic, so the projection reliably empties before the next reset and the screenshots are comparable between runs.
    await usage.clock.install({ time: new Date('2026-10-28T15:00:00+01:00') });
    // Day labels name the month only on the first label and where it changes; the rest are bare day numbers.
    const monthsOnChange = labels => { let month = null; return labels.length > 0 && labels.every((label, index) => {
      const named = label.match(/^([A-Z][a-z]{2}) \d{1,2}$/);
      if (!named) return index > 0 && /^\d{1,2}$/.test(label);
      const changed = named[1] !== month; month = named[1]; return index === 0 || changed;
    }); };
    // Local midnights (Europe/Paris page zone) at quarter-hour resolution, counted independently of the plugin's helper.
    const pageMidnights = (start, end) => usage.evaluate(([from, to]) => {
      const format = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
      let count = 0;
      for (let t = Math.ceil(from / 900) * 900; t <= to; t += 900) { const parts = Object.fromEntries(format.formatToParts(new Date(t * 1000)).map(part => [part.type, part.value])); if (Number(parts.hour) === 0 && Number(parts.minute) === 0) count++; }
      return count;
    }, [start, end]);
    const axisState = metricSelector => usage.evaluate(selector => {
      const r = el => el.getBoundingClientRect(), spans = [...document.querySelectorAll(`${selector} .su-xaxis span`)];
      const boxes = spans.map(r);
      return { labels: spans.map(span => span.textContent), overlap: boxes.some((box, index) => index > 0 && box.left < boxes[index - 1].right + 2),
        dayLines: document.querySelectorAll(`${selector} .su-day-grid`).length, units: [...document.querySelectorAll('.su-yunit')].map(el => el.textContent) };
    }, metricSelector);
    await usage.goto(`http://127.0.0.1:${server.address().port}`);
    await usage.waitForSelector('.sf-row');
    // Footer: the single Limits button on the left and T3's icon-only Usage button on the right, each named by aria-label and a tooltip.
    const footer = await usage.evaluate(() => {
      const aside = document.querySelector('.sf'), footer = aside.querySelector('.sf-footer'), list = aside.querySelector('.sf-scroll'), buttons = [...(footer?.querySelectorAll('.sf-utility') || [])];
      if (!footer || buttons.length === 0) return null;
      const r = el => el.getBoundingClientRect(), mid = box => [(box.left + box.right) / 2, (box.top + box.bottom) / 2];
      return { last: aside.lastElementChild === footer, height: r(footer).height, bottomGap: Math.abs(r(footer).bottom - r(aside).bottom), belowList: r(footer).top >= r(list).bottom - 0.5,
        controls: [...footer.querySelectorAll('button, [tabindex], a, input')].map(el => el.className),
        buttons: buttons.map(button => { const glyph = button.querySelector('svg'), [bx, by] = mid(r(button)), [gx, gy] = glyph ? mid(r(glyph)) : [NaN, NaN];
          return { label: button.getAttribute('aria-label'), text: button.textContent, title: button.title, icon: glyph?.getAttribute('data-icon'), width: r(button).width, height: r(button).height, glyph: glyph ? r(glyph).width : 0, centered: Math.hypot(bx - gx, by - gy) <= 0.5 }; }) };
    });
    console.log(`USAGE FOOTER: ${JSON.stringify(footer)}`);
    check('Footer is a fixed 36px row at the bottom of the pane, below the shelves', footer?.last && footer.height === 36 && footer.bottomGap < 1 && footer.belowList);
    check('Footer has exactly two controls: the single Limits button, then the 28px icon-only Usage button (BarChart3) with a tooltip', footer?.controls.join() === 'sf-limits,sf-utility' && footer.buttons.length === 1
      && [footer.buttons[0].label, footer.buttons[0].text, footer.buttons[0].title, footer.buttons[0].icon].join('|') === 'Usage||Token usage|BarChart3'
      && footer.buttons[0].width === 28 && footer.buttons[0].height === 28 && footer.buttons[0].glyph === 16 && footer.buttons[0].centered);
    const usageButton = usage.locator('.sf-footer').getByRole('button', { name: 'Usage', exact: true });
    const limitsButton = usage.locator('.sf-footer .sf-limits');
    {
      const idle = await usageButton.evaluate(el => getComputedStyle(el).backgroundColor);
      await usageButton.hover();
      await usage.waitForSelector('.mock-tip');
      const footerTip = await usage.evaluate(() => {
        const r = el => el.getBoundingClientRect(), tips = [...document.querySelectorAll('.mock-tip')], button = r(document.querySelector('.sf-footer .sf-utility[aria-label="Usage"]'));
        const tip = tips[0] ? r(tips[0]) : null;
        return { count: tips.length, text: tips[0]?.textContent, above: !!tip && tip.bottom <= button.top, centered: !!tip && tip.left <= (button.left + button.right) / 2 && tip.right >= (button.left + button.right) / 2, inside: !!tip && tip.left >= 0 && tip.top >= 0 };
      });
      console.log(`USAGE FOOTER TIP: ${JSON.stringify(footerTip)}`);
      check('Usage icon hover shows its background and one tooltip above it', await usageButton.evaluate(el => getComputedStyle(el).backgroundColor) !== idle
        && footerTip.count === 1 && footerTip.text === 'Token usage' && footerTip.above && footerTip.centered && footerTip.inside);
      await usage.mouse.move(5, 5);
    }
    // The Limits button holds one item per provider with limits: the synthetic Codex pool (Business 20 + Pro 100 100 units) runs short this week, missing more than two thirds of its capacity (red arrow to the floor), and Anthropic's Max 20x (200 units) throws under a third of its capacity away at its reset (muted clock-x).
    await usage.waitForSelector('.sf-footer .sf-limit');
    const footerStatus = () => usage.evaluate(() => {
      const r = el => el.getBoundingClientRect(), footer = document.querySelector('.sf-footer'), button = footer.querySelector('.sf-limits'), usageButton = footer.querySelector('.sf-utility');
      const items = [...footer.querySelectorAll('.sf-limit')], mid = box => (box.top + box.bottom) / 2, rgb = el => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const paint = canvas.getContext('2d'); paint.fillStyle = getComputedStyle(el).color; paint.fillRect(0, 0, 1, 1); return [...paint.getImageData(0, 0, 1, 1).data.slice(0, 3)]; };
      return { footerHeight: r(footer).height, overflow: footer.scrollWidth - footer.clientWidth, buttonHeight: r(button).height, leftAligned: Math.abs(r(button).left - r(footer).left - 6) < 0.5, rightAligned: Math.abs(r(footer).right - 6 - r(usageButton).right) < 0.5, beforeUsage: r(button).right <= r(usageButton).left, insideFooter: r(button).right <= r(footer).right + 0.5,
        focusables: button.querySelectorAll('button, [tabindex], a, input').length, oneRow: items.every(item => Math.abs(mid(r(item)) - mid(r(usageButton))) < 0.5) && Math.abs(mid(r(button)) - mid(r(usageButton))) < 0.5,
        label: button.getAttribute('aria-label'),
        items: items.map(item => { const value = item.querySelector('.sf-limit-value'), glyph = item.querySelector('[data-verdict-icon]');
          return { provider: item.dataset.provider, status: item.dataset.status, value: value.textContent, tabular: getComputedStyle(value).fontVariantNumeric.includes('tabular-nums'), mark: !!item.querySelector('svg[data-provider-mark]'),
            icon: glyph?.dataset.verdictIcon ?? null, severity: item.dataset.severity ?? null, iconName: glyph?.querySelector('svg')?.getAttribute('data-icon') ?? null, iconColor: glyph ? rgb(glyph) : null, valueColor: rgb(value), inside: r(item).right <= r(button).right + 0.5 && r(item).bottom <= r(button).bottom + 0.5 }; }) };
    });
    const ADVICE = /cut optional|background work|room for|optional work/i;
    const codexLine = /^OpenAI Codex: \d+(\.\d)? \/ 120 units · Runs out \w{3} \d{1,2}:\d{2} (AM|PM), ((\d+d \d+h|\d+h \d+m) before the next reset|still empty at the end of the 7 days) · missing ~\d+ units$/;
    const anthropicLine = /^Anthropic: \d+(\.\d)? \/ 200 units · \d+(\.\d)? units will expire unused by \w{3}$/;
    // A neutral colour has its channels close together; theme orange and red do not.
    const neutral = color => Math.max(...color) - Math.min(...color) < 24;
    {
      const status = await footerStatus();
      console.log(`USAGE FOOTER STATUS: ${JSON.stringify(status)}`);
      const [codex, anthropic] = status.items;
      check('Limits button is left-aligned and the Usage button right-aligned in the same 36px row, the Limits button one 28px control with one item per provider, without overflow', status.footerHeight === 36 && status.leftAligned && status.rightAligned && status.beforeUsage && status.oneRow && status.buttonHeight === 28 && status.insideFooter
        && status.focusables === 0 && status.items.length === 2 && codex.provider === 'openai-codex' && anthropic.provider === 'anthropic' && status.items.every(item => item.mark && item.inside) && status.overflow <= 0);
      check('Limits items show pooled units in tabular numerals: a red arrow to the floor for Codex missing over two thirds of its capacity, a muted clock-x for Anthropic losing under a third', status.items.every(item => /^\d+(\.\d)?$/.test(item.value) && item.tabular)
        && codex.status === 'short' && codex.severity === 'high' && codex.iconName === 'ArrowBarToDownTouching' && codex.iconColor[0] > codex.iconColor[1] + 40
        && anthropic.status === 'waste' && anthropic.severity === 'low' && anthropic.iconName === 'ClockX' && neutral(anthropic.iconColor) && anthropic.iconColor.join() === anthropic.valueColor.join());
      const idle = await limitsButton.evaluate(el => getComputedStyle(el).backgroundColor);
      await limitsButton.hover();
      await usage.waitForSelector('.mock-tip');
      const tip = await usage.evaluate(() => { const tips = [...document.querySelectorAll('.mock-tip')], box = tips[0]?.getBoundingClientRect(), button = document.querySelector('.sf-footer .sf-limits').getBoundingClientRect();
        return { count: tips.length, lines: [...(tips[0]?.querySelectorAll('span > span') || [])].map(line => line.textContent), above: !!box && box.bottom <= button.top, inside: !!box && box.left >= 0 && box.right <= innerWidth }; });
      console.log(`USAGE FOOTER LIMITS TIP: ${JSON.stringify(tip)}`);
      check('Limits button tooltip lists one factual line per provider, matches its accessible name and stays inside the window', tip.count === 1 && tip.lines.length === 2 && codexLine.test(tip.lines[0]) && anthropicLine.test(tip.lines[1])
        && status.label === `Limits. ${tip.lines.join('. ')}.` && !ADVICE.test(status.label) && tip.above && tip.inside);
      check('Limits button hover shows the ghost background', await limitsButton.evaluate(el => getComputedStyle(el).backgroundColor) !== idle);
      await usage.mouse.move(5, 5);
    }
    {
      // Close-up of the footer with the Limits tooltip showing: the same harness at 3x, cropped to the sidebar's bottom edge.
      const closeUp = await browser.newPage({ viewport: { width: 1300, height: 1000 }, deviceScaleFactor: 3, timezoneId: 'Europe/Paris' });
      closeUp.on('pageerror', error => errors.push(error.message));
      await closeUp.emulateMedia({ reducedMotion: 'reduce' });
      await closeUp.clock.install({ time: new Date('2026-10-28T15:00:00+01:00') });
      await closeUp.goto(`http://127.0.0.1:${server.address().port}`);
      await closeUp.waitForSelector('.sf-footer .sf-limit');
      await closeUp.locator('.sf-footer .sf-limits').hover();
      await closeUp.waitForSelector('.mock-tip');
      const pane = await closeUp.locator('.harness-sidebar').boundingBox(), tip = await closeUp.locator('.mock-tip').boundingBox();
      await closeUp.screenshot({ path: join(usageDir, 'v6-footer.png'), clip: { x: pane.x, y: tip.y - 12, width: Math.max(pane.width, tip.x + tip.width + 12 - pane.x), height: pane.y + pane.height - tip.y + 12 } });
      // The same footer in a 260px pane: both providers stay on the one row without overflowing it.
      await closeUp.mouse.move(600, 300);
      const footerAt = async width => {
        await closeUp.evaluate(px => { document.querySelector('.harness-sidebar').style.width = `${px}px`; }, width);
        await closeUp.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        return closeUp.evaluate(() => {
          const r = el => el.getBoundingClientRect(), footer = document.querySelector('.sf-footer'), button = footer.querySelector('.sf-limits'), strip = button.querySelector('.sf-limits-items'), items = [...footer.querySelectorAll('.sf-limit')];
          return { pane: r(document.querySelector('.harness-sidebar')).width, height: r(footer).height, overflow: footer.scrollWidth - footer.clientWidth, buttonInside: r(button).right <= r(footer.querySelector('.sf-utility')).left + 0.5,
            shown: items.filter(item => r(item).top < r(strip).bottom && r(item).right <= r(button).right + 0.5).length };
        });
      };
      const narrow = await footerAt(260);
      console.log(`USAGE FOOTER 260: ${JSON.stringify(narrow)}`);
      check('Footer fits a 260px pane: one 36px row, both provider items shown, no overflow', narrow.pane === 260 && narrow.height === 36 && narrow.overflow <= 0 && narrow.buttonInside && narrow.shown === 2);
      // With more providers than a 260px row can hold, items that do not fit wrap onto the clipped second line and vanish whole instead of overflowing the row.
      await closeUp.evaluate(() => {
        const mock = window.hermesT3SidebarHarness, data = mock.syntheticUsageLimits(168, 'mixed'), [codex, claude] = data.providers;
        mock.control.usageLimits = { ...data, providers: [...data.providers, { ...codex, provider: 'gemini', label: 'Gemini' }, { ...claude, provider: 'xai', label: 'xAI' }, { ...codex, provider: 'nous', label: 'Nous' }] };
        return mock.queryClient.invalidateQueries();
      });
      await closeUp.waitForFunction(() => document.querySelectorAll('.sf-footer .sf-limit').length === 5);
      const crowded = await footerAt(260);
      const partial = await closeUp.evaluate(() => { const r = el => el.getBoundingClientRect(), button = r(document.querySelector('.sf-footer .sf-limits')), strip = r(document.querySelector('.sf-limits-items'));
        return [...document.querySelectorAll('.sf-footer .sf-limit')].filter(item => { const box = r(item); return box.top < strip.bottom && box.right > button.right + 0.5; }).length; });
      console.log(`USAGE FOOTER CROWDED 260: ${JSON.stringify({ crowded, partial })}`);
      check('Footer never overflows a pane too narrow for every provider: items that do not fit are clipped away whole', crowded.height === 36 && crowded.overflow <= 0 && crowded.buttonInside && crowded.shown >= 2 && crowded.shown < 5 && partial === 0);
      await closeUp.evaluate(() => { const mock = window.hermesT3SidebarHarness; delete mock.control.usageLimits; return mock.queryClient.invalidateQueries(); });
      await closeUp.waitForFunction(() => document.querySelectorAll('.sf-footer .sf-limit').length === 2);
      await footerAt(260);
      const narrowPane = await closeUp.locator('.harness-sidebar').boundingBox();
      await closeUp.screenshot({ path: join(usageDir, 'v6-footer-260.png'), clip: { x: narrowPane.x, y: narrowPane.y + narrowPane.height - 60, width: narrowPane.width + 1, height: 60 } });
      await closeUp.close();
    }
    {
      // Without limits data the same button shows the gauge alone, so the Limits page stays reachable.
      const failing = await browser.newPage({ viewport: { width: 1300, height: 1000 }, deviceScaleFactor: 1, timezoneId: 'Europe/Paris' });
      failing.on('pageerror', error => errors.push(error.message));
      await failing.emulateMedia({ reducedMotion: 'reduce' });
      await failing.clock.install({ time: new Date('2026-10-28T15:00:00+01:00') });
      await failing.goto(`http://127.0.0.1:${server.address().port}/?limits=error`);
      await failing.waitForSelector('.sf-row');
      await failing.waitForFunction(() => window.hermesT3SidebarHarness.calls.some(call => call[0] === 'rest' && call[1].startsWith('/usage/limits')));
      await failing.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const gauge = await failing.evaluate(() => {
        const r = el => el.getBoundingClientRect(), button = document.querySelector('.sf-footer .sf-limits'), glyph = button?.querySelector('svg'), mid = box => [(box.left + box.right) / 2, (box.top + box.bottom) / 2];
        const [bx, by] = mid(r(button)), [gx, gy] = mid(r(glyph));
        return { empty: button.dataset.empty, label: button.getAttribute('aria-label'), icon: glyph?.getAttribute('data-icon'), width: r(button).width, height: r(button).height, glyph: r(glyph).width, centered: Math.hypot(bx - gx, by - gy) <= 0.5, items: button.querySelectorAll('.sf-limit').length, text: button.textContent };
      });
      console.log(`USAGE FOOTER GAUGE: ${JSON.stringify(gauge)}`);
      check('Without limits data the Limits button is the 28px gauge icon alone, with no error text', gauge.empty === 'true' && gauge.label === 'Limits' && gauge.icon === 'Gauge' && gauge.width === 28 && gauge.height === 28 && gauge.glyph === 16 && gauge.centered && gauge.items === 0 && gauge.text === '');
      await failing.locator('.sf-footer .sf-limits').click();
      await failing.waitForSelector('.su-state[role=alert]');
      check('The gauge still opens the Limits page, which reports the failure', await failing.evaluate(() => document.querySelector('.harness-route')?.dataset.route === '/t3sidebar-limits' && /^Limits unavailable: /.test(document.querySelector('.su-state[role=alert]').textContent)));
      await failing.close();
    }
    // The footer status has already read /usage/limits; only requests after the click belong to the Usage page.
    const beforeUsage = await usage.evaluate(() => window.hermesT3SidebarHarness.calls.length);
    await usageButton.click();
    check('Usage footer button navigates to /t3sidebar-usage', await usage.evaluate(() => window.hermesT3SidebarHarness.calls.some(call => call[0] === 'navigate' && call[1] === '/t3sidebar-usage')));
    await usage.waitForSelector('.su-chart[data-metric="user_messages"] svg g[data-series]');
    {
      const state = await usage.evaluate(count => ({ paths: window.hermesT3SidebarHarness.calls.slice(count).filter(call => call[0] === 'rest' && call[1].startsWith('/usage/')).map(call => call[1].split('?')[0]),
        title: document.querySelector('.harness-route .harness-tabs')?.firstChild?.textContent, view: document.querySelector('.su')?.dataset.view, limits: !!document.querySelector('.su-pooled, .su-providers'),
        buttons: [...document.querySelectorAll('.su-header button')].map(button => button.textContent || button.getAttribute('aria-label')) }), beforeUsage);
      check('Usage route shows only usage content and fetches only /usage/history', state.title === 'Usage' && state.view === 'usage' && !state.limits && state.paths.length > 0 && state.paths.every(path => path === '/usage/history')
        && !state.buttons.includes('Limits') && !state.buttons.includes('Usage'));
    }
    const usageLayout = () => usage.evaluate(() => {
      const root = document.querySelector('.su'), charts = [...root.querySelectorAll('.su-chart')], r = el => el.getBoundingClientRect();
      const plots = charts.map(chart => r(chart.querySelector('.su-plot')));
      const inside = [...root.querySelectorAll('.su-header *, .su-legend *, .su-xaxis span, .su-yaxis span, .su-footnote')].every(el => { const box = r(el), bounds = r(root); return box.width === 0 || box.left >= bounds.left - 0.5 && box.right <= bounds.right + 0.5; });
      return { overflowX: root.scrollWidth - root.clientWidth, charts: charts.map(chart => chart.dataset.metric), aligned: plots.every(p => Math.abs(p.left - plots[0].left) < 1 && Math.abs(p.width - plots[0].width) < 1), plotWidth: plots[0].width,
        series: charts.map(chart => chart.querySelectorAll('svg g[data-series]').length), drawn: charts.every(chart => [...chart.querySelectorAll('svg .su-line')].every(path => path.getTotalLength() > 50 && r(path).width > 0.9 * plots[0].width)), inside };
    });
    let layout = await usageLayout();
    console.log(`USAGE LAYOUT: ${JSON.stringify(layout)}`);
    check('Usage page draws Tokens, Cost and User messages charts on one shared, aligned time axis', layout.charts.join() === 'tokens,cost_usd,user_messages' && layout.aligned && layout.plotWidth > 800 && layout.drawn);
    check('Usage page has no horizontal overflow and keeps labels inside the page', layout.overflowX <= 0 && layout.inside);
    {
      const axis7 = await axisState('.su-chart[data-metric="user_messages"]');
      const buckets = await usage.evaluate(() => window.hermesT3SidebarHarness.syntheticUsageHistory(7, 'Europe/Paris').buckets);
      const midnights = (await Promise.all(buckets.map(t => pageMidnights(t, t)))).reduce((sum, count) => sum + count, 0);
      console.log(`USAGE 7D AXIS: ${JSON.stringify({ ...axis7, midnights })}`);
      check('Usage charts label the vertical axis per day for all three metrics', axis7.units.join() === 'tokens/day,$/day,messages/day');
      check('Usage 7d day gridlines match the local midnights and labels name the month only once', axis7.dayLines === midnights && midnights === 7 && monthsOnChange(axis7.labels) && !axis7.overlap);
    }
    const tokensPlot = usage.locator('.su-chart[data-metric="tokens"] .su-plot');
    const plotBox = await tokensPlot.boundingBox();
    await usage.mouse.move(plotBox.x + plotBox.width * 0.72, plotBox.y + plotBox.height / 2);
    const hover = await usage.evaluate(() => {
      const crosses = [...document.querySelectorAll('.su-cross')].map(el => Math.round(el.getBoundingClientRect().left));
      const tips = [...document.querySelectorAll('.su-tip')], page = document.querySelector('.su').getBoundingClientRect();
      return { crosses, tips: tips.length, rows: tips.map(tip => tip.querySelectorAll('.su-tip-row').length), inside: tips.every(tip => { const box = tip.getBoundingClientRect(); return box.left >= page.left && box.right <= page.right; }), flipped: tips.every(tip => tip.dataset.side === 'left') };
    });
    check('hovering one chart moves a synchronized crosshair and tooltip on all three', hover.crosses.length === 3 && new Set(hover.crosses).size === 1 && hover.tips === 3 && hover.rows.every(rows => rows >= 3) && hover.inside && hover.flipped);
    await usage.locator('.harness-page').screenshot({ path: join(usageDir, 'usage-stacked.png') });
    await usage.getByRole('button', { name: 'Independent', exact: true }).click();
    await usage.getByRole('button', { name: 'Model', exact: true }).click();
    await usage.waitForFunction(() => document.querySelectorAll('.su-chart[data-metric="tokens"] svg g[data-series]').length === 5);
    layout = await usageLayout();
    check('Model split with Independent mode redraws one line per model without overflow', layout.series.join() === '5,4,5' && layout.drawn && layout.overflowX <= 0 && layout.inside);
    await usage.mouse.move(plotBox.x + plotBox.width * 0.2, plotBox.y + plotBox.height / 2);
    await usage.locator('.harness-page').screenshot({ path: join(usageDir, 'usage-independent.png') });
    await usage.mouse.move(5, 5);
    // 24h: hourly buckets plotted per day, with the date only on the first label and at midnight.
    await usage.getByRole('button', { name: '24h', exact: true }).click();
    await usage.waitForFunction(() => document.querySelector('.su-chart[data-metric="tokens"] svg g[data-series] .su-line')?.getAttribute('d').split('L').length === 24);
    {
      const axis = await axisState('.su-chart[data-metric="user_messages"]');
      const buckets = await usage.evaluate(() => window.hermesT3SidebarHarness.syntheticUsageHistory(1, 'Europe/Paris').buckets);
      const midnights = await pageMidnights(buckets[0], buckets.at(-1));
      const hourLabels = axis.labels.slice(1).every(label => /^\d{1,2} (AM|PM)$/.test(label) || /^[A-Z][a-z]{2} \d{1,2}$/.test(label));
      const dated = axis.labels.filter(label => /[A-Z][a-z]{2}/.test(label));
      console.log(`USAGE 24H AXIS: ${JSON.stringify({ ...axis, midnights })}`);
      check('Usage 24h view draws one gridline per local midnight and dates only the first label and midnight', axis.dayLines === midnights && midnights === 1 && /^[A-Z][a-z]{2} \d{1,2}, \d{1,2} (AM|PM)$/.test(axis.labels[0]) && hourLabels && dated.length === 2 && !axis.overlap);
      const box = await usage.locator('.su-chart[data-metric="user_messages"] .su-plot').boundingBox();
      await usage.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
      const tip = await usage.locator('.su-chart[data-metric="user_messages"] .su-tip-total b').textContent();
      const [, perDay, hour] = tip.match(/^([\d,]+)\/day · ([\d,]+) this hour$/) || [];
      check('Usage 24h tooltip shows the per-day rate with the raw hour value', perDay !== undefined && Number(perDay.replace(/,/g, '')) === 24 * Number(hour.replace(/,/g, '')));
      await usage.locator('.harness-page').screenshot({ path: join(usageDir, 'v2-usage-24h.png') });
      await usage.mouse.move(5, 5);
    }
    await usage.getByRole('button', { name: '30d', exact: true }).click();
    await usage.waitForFunction(() => document.querySelectorAll('.su-chart[data-metric="user_messages"] .su-day-grid').length === 30);
    {
      const axis = await axisState('.su-chart[data-metric="user_messages"]');
      console.log(`USAGE 30D AXIS: ${JSON.stringify(axis)}`);
      layout = await usageLayout();
      check('Usage 30d labels name each month once, do not overlap and keep one gridline per day', monthsOnChange(axis.labels) && !axis.overlap && axis.dayLines === 30 && layout.overflowX <= 0 && layout.inside);
      await usage.locator('.harness-page').screenshot({ path: join(usageDir, 'v2-usage-30d.png') });
    }
    await usage.getByRole('button', { name: '7d', exact: true }).click();
    // Let the 7-day history land (its request starts a tick after the click) so it is not counted against the Limits page.
    await usage.waitForFunction(() => document.querySelectorAll('.su-chart[data-metric="user_messages"] .su-day-grid').length === 7 && !document.querySelector('.su-header [role=status]'));
    const usageRequests = await usage.evaluate(() => window.hermesT3SidebarHarness.calls.filter(call => call[0] === 'rest').length);
    await limitsButton.click();
    await usage.waitForSelector('.su-pooled .su-line.su-projected');
    const CODEX = '.su-provider-limits[data-provider="openai-codex"]', ANTHROPIC = '.su-provider-limits[data-provider="anthropic"]';
    // Let both charts' layout effects and ResizeObservers place their labels.
    const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await settle(usage);
    {
      const state = await usage.evaluate(count => ({ paths: window.hermesT3SidebarHarness.calls.filter(call => call[0] === 'rest').slice(count).map(call => call[1].split('?')[0]).filter(path => path.startsWith('/usage/')),
        navigated: window.hermesT3SidebarHarness.calls.some(call => call[0] === 'navigate' && call[1] === '/t3sidebar-limits'),
        title: document.querySelector('.harness-route .harness-tabs')?.firstChild?.textContent, view: document.querySelector('.su')?.dataset.view, usageCharts: document.querySelectorAll('.su-chart[data-metric]').length,
        legend: document.querySelectorAll('.su-pooled .su-legend').length, segmented: [...document.querySelectorAll('.su [aria-pressed]')].map(button => button.textContent).filter(Boolean) }), usageRequests);
      console.log(`USAGE LIMITS ROUTE: ${JSON.stringify(state)}`);
      // The footer status already holds the same limits query (same key), so the page may reuse it without a new request.
      check('Limits button opens /t3sidebar-limits, which shows only limits and fetches only /usage/limits', state.navigated && state.title === 'Limits' && state.view === 'limits' && state.usageCharts === 0
        && state.paths.every(path => path === '/usage/limits'));
      check('Limits charts have no Remaining/Projected legend and the only day choices are the 7d | 30d horizon', state.legend === 0 && state.segmented.filter(label => /^\d+d$/.test(label)).join() === '7d,30d');
    }
    {
      // Overview: the shared controls bar first, then one section per provider with data, each with its logo heading, chart and folded accounts.
      const overview = await usage.evaluate(() => {
        const r = el => el.getBoundingClientRect(), bar = document.querySelector('.su-limits-controls'), sections = [...document.querySelectorAll('.su-provider-limits')], mid = box => (box.top + box.bottom) / 2;
        const lookback = bar?.querySelector('.su-lookback'), label = r(lookback.querySelector('.su-lookback-label')), range = r(lookback.querySelector('input[type=range]')), value = r(lookback.querySelector('.su-lookback-value'));
        const parts = [lookback, bar.querySelector('[aria-label=Window]'), bar.querySelector('.su-horizon'), bar.querySelector('[aria-label=Refresh]')];
        return { tabs: document.querySelectorAll('.su-provider-tabs, button.su-provider').length, sections: sections.map(node => node.dataset.provider), headings: sections.map(node => node.querySelector('.su-provider-head')?.textContent),
          marks: sections.map(node => !!node.querySelector('.su-provider-head svg[data-provider-mark]')), charts: sections.map(node => node.querySelectorAll('.su-pooled').length),
          barFirst: bar.parentElement.classList.contains('su') && r(bar).bottom <= r(sections[0]).top, parts: parts.map(Boolean), ordered: parts.every((node, index) => index === 0 || r(node).left >= r(parts[index - 1]).right),
          oneRow: parts.every(node => Math.abs(mid(r(node)) - mid(r(parts[0]))) <= 2), once: ['.su-lookback', '.su-horizon', '[aria-label=Window]', '[aria-label=Refresh]'].map(selector => document.querySelectorAll(`.su ${selector}`).length),
          sliderRow: label.right <= range.left && range.right <= value.left && Math.abs(mid(label) - mid(range)) <= 1.5 && Math.abs(mid(value) - mid(range)) <= 1.5,
          sliderText: [lookback.querySelector('.su-lookback-label').textContent, lookback.querySelector('.su-lookback-value').textContent], accounts: document.querySelectorAll('.su-account').length,
          disclosures: [...document.querySelectorAll('.su-disclosure')].map(node => `${node.textContent}|${node.getAttribute('aria-expanded')}`), footnotes: document.querySelectorAll('.su-footnote').length,
          footnoteLast: document.querySelector('.su-overview').lastElementChild.classList.contains('su-footnotes') };
      });
      console.log(`USAGE LIMITS OVERVIEW: ${JSON.stringify(overview)}`);
      check('Limits page is one overview without provider tabs: a Codex then an Anthropic section, each with its logo heading and one chart', overview.tabs === 0 && overview.sections.join() === 'openai-codex,anthropic'
        && overview.headings.join() === 'OpenAI Codex,Anthropic' && overview.marks.every(Boolean) && overview.charts.join() === '1,1');
      check('One shared controls bar heads the page: Projections based on [slider] value, Window, 7d | 30d horizon, Refresh, in one row and only once', overview.barFirst && overview.parts.every(Boolean) && overview.ordered && overview.oneRow
        && overview.once.join() === '1,1,1,1' && overview.sliderRow && overview.sliderText.join() === 'Projections based on,12h');
      check('Accounts are folded under every chart by default and the footnote appears once at the bottom', overview.accounts === 0 && overview.disclosures.join() === 'Accounts (2)|false,Accounts (1)|false' && overview.footnotes === 1 && overview.footnoteLast);
    }
    const chartState = section => usage.evaluate(selector => {
      const chart = document.querySelector(selector), r = el => el.getBoundingClientRect(), plot = r(chart.querySelector('.su-pooled .su-plot'));
      const now = r(chart.querySelector('.su-now')), past = chart.querySelector('.su-line.su-past'), projected = chart.querySelector('.su-line.su-projected');
      return { nowInside: now.left > plot.left && now.left < plot.right, pastEndsAtNow: Math.abs(r(past).right - now.left) <= 2, projectedStartsAtNow: Math.abs(r(projected).left - now.left) <= 2,
        projectedReachesEnd: Math.abs(r(projected).right - plot.right) <= 2, dashed: getComputedStyle(projected).strokeDasharray !== 'none', overflowX: document.querySelector('.su').scrollWidth - document.querySelector('.su').clientWidth };
    }, section);
    for (const [name, section] of [['Codex', CODEX], ['Anthropic', ANTHROPIC]]) {
      const state = await chartState(section);
      console.log(`USAGE LIMITS ${name}: ${JSON.stringify(state)}`);
      check(`Limits ${name} chart draws the past pool up to Now and a dashed projection to the horizon, without page overflow`, state.nowInside && state.pastEndsAtNow && state.projectedStartsAtNow && state.projectedReachesEnd && state.dashed && state.overflowX <= 0);
    }
    // Measurement row under a plot: the averaging period left of Now and the time to empty right of it, on one row. Each chart measures its own labels.
    const measureIn = section => usage.evaluate(selector => {
      const chart = document.querySelector(selector), r = el => el.getBoundingClientRect(), plotNode = chart.querySelector('.su-pooled .su-plot'), plot = r(plotNode), nowX = r(chart.querySelector('.su-now')).left;
      const start = Number(plotNode.dataset.start), end = Number(plotNode.dataset.end), xAt = t => plot.left + (t - start) / (end - start) * plot.width;
      const part = kind => {
        const node = chart.querySelector(`.su-measure[data-kind="${kind}"]`);
        if (!node) return null;
        const span = node.querySelector('.su-measure-span'), box = r(span), text = node.querySelector('.su-measure-text'), label = r(text);
        const arrows = Object.fromEntries([...span.querySelectorAll('.su-arrow')].map(el => [el.dataset.end, r(el)])), ticks = Object.fromEntries([...span.querySelectorAll('.su-measure-tick')].map(el => [el.dataset.end, r(el)]));
        // A span narrower than its arrowheads draws them outside, their tips still on the span ends.
        const tight = span.dataset.tight === 'true', tip = (end, arrow) => end === 'start' ? (tight ? arrow.right : arrow.left) : (tight ? arrow.left : arrow.right);
        return { left: box.left, right: box.right, top: box.top, tight, arrows: Object.keys(arrows).sort().join(), ticks: Object.keys(ticks).sort().join(),
          arrowsAtEnds: tight === box.width < 16 && Object.entries(arrows).every(([end, arrow]) => arrow.width >= 5 && arrow.height >= 7 && Math.abs(tip(end, arrow) - (end === 'start' ? box.left : box.right)) <= 0.5),
          ticksAtEnds: Object.entries(ticks).every(([end, tick]) => Math.abs((end === 'start' ? tick.left : tick.right) - (end === 'start' ? box.left : box.right)) <= 1),
          text: text.textContent, label: { left: label.left, right: label.right, top: label.top, bottom: label.bottom }, full: text.scrollWidth <= text.clientWidth + 0.5, aboveLine: label.bottom <= box.top + 1 };
      };
      // The averaging span is the lookback, or only the covered time when the history holds less; the chart reports which in data-seconds.
      const dot = chart.querySelector('.su-empty-dot'), mark = dot ? r(dot) : null, lookback = Number(chart.querySelector('.su-measure[data-kind="average"]')?.dataset.seconds);
      const nowT = start + (nowX - plot.left) / plot.width * (end - start);
      // The notes row under a chart exists only when there is a note; without it nothing sits below the measurements.
      const footNode = chart.querySelector('.su-chart-foot'), foot = footNode ? r(footNode) : { top: Infinity }, row = r(chart.querySelector('.su-measures'));
      return { plotLeft: plot.left, plotRight: plot.right, plotBottom: plot.bottom, nowX, lookbackX: xAt(nowT - lookback), emptyX: mark ? mark.left + mark.width / 2 : null, emptyOnFloor: mark ? Math.abs(mark.top + mark.height / 2 - plot.bottom) <= 1 : null,
        average: part('average'), empty: part('empty'), rowTop: row.top, rowBottom: row.bottom, footTop: foot.top };
    }, section);
    const measure = () => measureIn(CODEX);
    // The averaging span reaches from max(plot edge, Now − lookback) to Now; the left arrowhead and tick exist only when its start is on the plot.
    const averageOk = geometry => {
      const average = geometry?.average;
      if (!average) return false;
      const clipped = geometry.lookbackX < geometry.plotLeft;
      return Math.abs(average.right - geometry.nowX) <= 1 && Math.abs(average.left - (clipped ? geometry.plotLeft : geometry.lookbackX)) <= 1 && average.arrowsAtEnds && average.ticksAtEnds
        && average.arrows === (clipped ? 'end' : 'end,start') && average.ticks === (clipped ? 'end' : 'end,start') && average.top > geometry.plotBottom;
    };
    // Both labels sit inside the plot on their own side of Now, fully shown, apart from each other and above the chart's notes row.
    const labelsOk = (geometry, { full = true } = {}) => {
      const { average, empty } = geometry;
      const separate = !average || !empty || average.label.right + 4 <= empty.label.left;
      return separate && [average, empty].filter(Boolean).every(part => (part.full || !full) && part.aboveLine && part.label.left >= geometry.plotLeft - 0.5 && part.label.right <= geometry.plotRight + 0.5 && part.label.bottom <= geometry.footTop)
        && (!average || average.label.right <= geometry.nowX) && (!empty || empty.label.left >= geometry.nowX) && geometry.footTop >= geometry.rowBottom - 0.5;
    };
    const rates = () => usage.evaluate(() => [...document.querySelectorAll('.su-rate')].map(node => node.textContent));
    const lookbackValue = () => usage.locator('.su-lookback-value').textContent();
    {
      const geometry = await measure(), other = await measureIn(ANTHROPIC);
      const plot = await usage.evaluate(selector => { const node = document.querySelector(`${selector} .su-pooled .su-plot`); return [Number(node.dataset.start), Number(node.dataset.end)]; }, CODEX);
      const axis = await axisState(`${CODEX} .su-pooled`), otherAxis = await axisState(`${ANTHROPIC} .su-pooled`);
      const midnights = await pageMidnights(...plot);
      console.log(`USAGE LIMITS MEASURE: ${JSON.stringify({ geometry, other, axis, otherAxis, midnights, rates: await rates() })}`);
      const empty = geometry.empty;
      check('Limits time-to-empty arrow spans Now to the first projected zero below the Codex plot (within 1px)', empty && Math.abs(empty.left - geometry.nowX) <= 1 && Math.abs(empty.right - geometry.emptyX) <= 1 && geometry.emptyOnFloor
        && empty.arrows === 'end,start' && empty.ticks === 'end,start' && empty.arrowsAtEnds && empty.ticksAtEnds && empty.top > geometry.plotBottom);
      check('Limits time-to-empty text is unclipped and dated', empty && /^Empty in (\d+d \d+h|\d+h \d+m) · \w{3} \d{1,2}:\d{2} (AM|PM)$/.test(empty.text));
      check('Limits 12h averaging measurement spans Now − 12h to Now on the same row, with arrowheads and ticks at both ends', averageOk(geometry) && geometry.lookbackX > geometry.plotLeft
        && Math.abs(geometry.average.top - empty.top) <= 0.5 && /^Average over 12h · ~\d+(\.\d)? units\/h$/.test(geometry.average.text));
      check('Limits measurement labels stay on their side of Now, apart, inside the plot and above the notes', labelsOk(geometry));
      check('The Anthropic chart measures its own averaging span and labels independently (it never empties)', averageOk(other) && other.empty === null && labelsOk(other) && /^Average over 12h · ~\d+(\.\d)? units\/h$/.test(other.average.text));
      check('Limits draws one gridline per local midnight and names each month once on every chart', axis.dayLines === midnights && otherAxis.dayLines === midnights && midnights >= 9 && monthsOnChange(axis.labels) && !axis.overlap && monthsOnChange(otherAxis.labels) && !otherAxis.overlap);
    }
    // Waste measurements: vertical dimension lines at projected resets that discard quota, at the reset's x and spanning from the pool's level just before the step-up down by the expiring units. Colors are read back through a canvas: color-mix in oklab computes to an oklab() string, not rgb().
    const wasteGeometry = (page, section) => page.evaluate(selector => {
      const chart = document.querySelector(selector), r = el => el.getBoundingClientRect(), plotNode = chart.querySelector('.su-pooled .su-plot'), plot = r(plotNode);
      const start = Number(plotNode.dataset.start), end = Number(plotNode.dataset.end), cap = Number(plotNode.dataset.cap), paint = value => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const context = canvas.getContext('2d'); context.fillStyle = value; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)]; }, rgb = el => paint(getComputedStyle(el).color);
      const nowColor = paint(getComputedStyle(chart.querySelector('.su-now')).borderLeftColor);
      const marks = [...chart.querySelectorAll('.su-pooled .su-waste')].map(mark => {
        const box = r(mark), line = r(mark.querySelector('.su-waste-line')), t = Number(mark.dataset.t), before = Number(mark.dataset.before), lost = Number(mark.dataset.lost);
        const x = plot.left + (t - start) / (end - start) * plot.width, top = plot.top + (1 - before / cap) * plot.height, bottom = top + lost / cap * plot.height;
        const arrows = Object.fromEntries([...mark.querySelectorAll('.su-waste-arrow')].map(el => [el.dataset.end, r(el)])), ticks = Object.fromEntries([...mark.querySelectorAll('.su-waste-tick')].map(el => [el.dataset.end, r(el)]));
        const label = mark.querySelector('.su-waste-text'), labelBox = r(label), tight = mark.dataset.tight === 'true';
        return { x: Math.abs((line.left + line.right) / 2 - x), top: Math.abs(box.top - top), bottom: Math.abs(box.bottom - bottom), span: box.height, lost, cap, tight,
          arrowsAtEnds: tight || Math.abs(arrows.top.top - box.top) <= 0.5 && Math.abs(arrows.bottom.bottom - box.bottom) <= 0.5, ticks: Object.keys(ticks).sort().join(),
          ticksAtEnds: Math.abs(ticks.top.top - box.top) <= 1 && Math.abs(ticks.bottom.top - box.bottom) <= 1, text: label.textContent, hidden: label.dataset.hidden === 'true',
          label: { left: labelBox.left, right: labelBox.right, top: labelBox.top, bottom: labelBox.bottom }, labelInside: labelBox.left >= plot.left - 0.5 && labelBox.right <= plot.right + 0.5,
          color: rgb(mark), labelColor: rgb(label), nowColor, title: mark.getAttribute('title') };
      });
      const shown = marks.filter(mark => !mark.hidden);
      const apart = shown.every((a, i) => shown.every((b, j) => i >= j || a.label.right <= b.label.left || b.label.right <= a.label.left || a.label.bottom <= b.label.top || b.label.bottom <= a.label.top));
      const verdict = chart.querySelector('.su-verdict');
      const glyph = verdict?.querySelector('.su-verdict-icon');
      return { marks, apart, verdict: verdict ? { status: verdict.dataset.status, severity: verdict.dataset.severity ?? null, text: verdict.textContent, icon: verdict.querySelector('svg')?.getAttribute('data-icon') ?? null, color: rgb(verdict), iconColor: glyph ? rgb(glyph) : null } : null };
    }, section);
    const wasteOk = (mark, account) => mark.x <= 1 && mark.top <= 1 && mark.bottom <= 1 && mark.arrowsAtEnds && mark.ticks === 'bottom,top' && mark.ticksAtEnds && mark.labelInside
      && /^\d+(\.\d)? lost$/.test(mark.text) && mark.color.join() === mark.nowColor.join() && mark.labelColor.join() === mark.nowColor.join() && new RegExp(`^${account} · \\d+(\\.\\d)? units unused at reset \\w{3} \\d{1,2}:\\d{2} (AM|PM)$`).test(mark.title);
    {
      const waste = await wasteGeometry(usage, CODEX), claude = await wasteGeometry(usage, ANTHROPIC);
      console.log(`USAGE LIMITS WASTE (mixed): ${JSON.stringify({ waste, claude })}`);
      check('Limits draws a waste measurement at the Pro 100 reset: x within 1px, span = the expiring units within 1px, in the Now line colour, with arrowheads, ticks and a label',
        waste.marks.length === 1 && waste.marks.every(mark => wasteOk(mark, 'chatgpt1 · Pro 100')) && waste.marks[0].span > 16 && !waste.marks[0].hidden && waste.apart);
      check('Limits Codex verdict under its headline: neutral factual text (when it runs out, the gap, the missing units) after a red arrow to the floor', waste.verdict?.status === 'short' && waste.verdict.severity === 'high' && waste.verdict.icon === 'ArrowBarToDownTouching'
        && /^Runs out \w{3} \d{1,2}:\d{2} (AM|PM), ((\d+d \d+h|\d+h \d+m) before the next reset|still empty at the end of the 7 days) · missing ~\d+ units$/.test(waste.verdict.text) && neutral(waste.verdict.color) && waste.verdict.iconColor[0] > waste.verdict.iconColor[1] + 40);
      check('Limits Anthropic chart has its own waste verdict (muted clock-x: under a third of the capacity) and a waste measurement at the Max 20x reset', claude.verdict?.status === 'waste' && claude.verdict.severity === 'low' && claude.verdict.icon === 'ClockX' && neutral(claude.verdict.iconColor)
        && /^\d+(\.\d)? units will expire unused by \w{3}$/.test(claude.verdict.text) && claude.marks.length === 1 && claude.marks.every(mark => wasteOk(mark, 'claude-max · Max 20x')) && claude.apart);
      const headline = await usage.evaluate(() => [...document.querySelectorAll('.su-pooled')].map(chart => ({ pool: chart.querySelector('.su-pool').textContent, capacity: chart.querySelector('.su-capacity').textContent, composition: chart.querySelector('.su-composition').textContent,
        ticks: [...chart.querySelectorAll('.su-yaxis span')].map(el => el.textContent).join() })));
      console.log(`USAGE LIMITS HEADLINE: ${JSON.stringify(headline)}`);
      check('Limits headlines and axes are in units: Business 20 + Pro 100 100 = 120, Max 20x = 200', headline.length === 2 && headline.every(item => /^\d+(\.\d)?$/.test(item.pool))
        && headline[0].capacity === '/ 120 units' && headline[0].composition === '(Business: 20, Pro 100: 100)' && headline[0].ticks === 'units,0,25,50,75,100,120'
        && headline[1].capacity === '/ 200 units' && headline[1].composition === '(Max 20x: 200)' && headline[1].ticks === 'units,0,50,100,150,200');
      check('No Next reset line and no plan units wording anywhere on the Limits page', await usage.evaluate(() => !/Next reset|plan units/i.test(document.querySelector('.su').innerText) && [...document.querySelectorAll('[title],[aria-label]')].every(node => !/plan units/i.test(`${node.getAttribute('title') || ''} ${node.getAttribute('aria-label') || ''}`))));
      check('No advice anywhere on the Limits page or in the footer', await usage.evaluate(source => { const advice = new RegExp(source, 'i'); return !advice.test(document.body.innerText) && [...document.querySelectorAll('[aria-label],[title]')].every(node => !advice.test(node.getAttribute('aria-label') || '') && !advice.test(node.getAttribute('title') || '')); }, ADVICE.source));
    }
    {
      // Reset markers: Business and Pro 100 reset together tomorrow, so their markers stack on one vertical line in pool priority order, each dot at the cumulative level its account brings the pool to.
      const resets = await usage.evaluate(selector => {
        const chart = document.querySelector(selector), r = el => el.getBoundingClientRect(), plotNode = chart.querySelector('.su-pooled .su-plot'), plot = r(plotNode);
        const start = Number(plotNode.dataset.start), end = Number(plotNode.dataset.end), cap = Number(plotNode.dataset.cap), box = b => ({ left: b.left, right: b.right, top: b.top, bottom: b.bottom });
        const groups = [...chart.querySelectorAll('.su-reset[data-kind=projected]')].map(group => ({ t: Number(group.dataset.t), marks: [...group.querySelectorAll('.su-reset-mark')].map(mark => {
          const dot = r(mark.querySelector('.su-reset-dot')), label = mark.querySelector('.su-reset-text'), top = Number(mark.dataset.top);
          return { account: mark.dataset.account, top, base: Number(mark.dataset.base), dx: Math.abs((dot.left + dot.right) / 2 - (plot.left + (Number(group.dataset.t) - start) / (end - start) * plot.width)),
            dy: Math.abs((dot.top + dot.bottom) / 2 - (plot.top + (1 - top / cap) * plot.height)), text: label.textContent, hidden: label.dataset.hidden === 'true', dot: box(dot) };
        }) }));
        const waste = chart.querySelector('.su-waste'), overlap = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
        const labels = [...chart.querySelectorAll('.su-reset-text, .su-waste-text')].filter(node => node.dataset.hidden !== 'true').map(r), dots = [...chart.querySelectorAll('.su-reset-dot')].map(r);
        return { groups, wasteT: waste ? Number(waste.dataset.t) : null, labelsApart: labels.every((a, i) => labels.every((b, j) => i >= j || !overlap(a, b))), labelsClearOfDots: labels.every(a => dots.every(b => !overlap(a, b))) };
      }, CODEX);
      console.log(`USAGE LIMITS RESETS: ${JSON.stringify(resets)}`);
      const stacked = resets.groups.find(group => group.marks.length === 2);
      check('Both Codex accounts resetting together stack two markers on one vertical line in priority order, each dot within 1px of its cumulative level', !!stacked && stacked.marks.map(mark => mark.account).join() === 'acct-team,acct-prolite'
        && Math.abs(stacked.marks[1].base - stacked.marks[0].top) < 1e-6 && Math.abs(stacked.marks[1].top - 120) < 1e-6 && stacked.marks.every(mark => mark.dx <= 1 && mark.dy <= 1) && stacked.marks[0].dot.top - stacked.marks[1].dot.bottom > 8);
      check('Stacked reset labels read +N and stay shown, apart from each other and from every dot; the waste arrow shares the reset x', !!stacked && stacked.marks.every(mark => /^\+\d+(\.\d)?$/.test(mark.text) && !mark.hidden) && resets.labelsApart && resets.labelsClearOfDots && resets.wasteT === stacked.t);
      // Hovering the upper dot shows its tooltip; the crosshair and its inline tooltip step aside.
      await usage.locator(`${CODEX} .su-reset-mark[data-account="acct-prolite"] .su-reset-dot`).hover();
      await usage.waitForSelector('.mock-tip');
      const tip = await usage.evaluate(selector => ({ count: document.querySelectorAll('.mock-tip').length, lines: [...document.querySelectorAll('.mock-tip span > span')].map(node => node.textContent),
        cross: document.querySelectorAll(`${selector} .su-cross`).length, inline: document.querySelectorAll(`${selector} .su-tip`).length }), CODEX);
      console.log(`USAGE LIMITS RESET TIP: ${JSON.stringify(tip)}`);
      check('Hovering a reset marker shows account and plan, reset time, units restored and units lost, without the crosshair', tip.count === 1 && tip.lines[0] === 'chatgpt1 · Pro 100' && /^Resets \w{3} \d{1,2}:\d{2} (AM|PM)$/.test(tip.lines[1])
        && /^\+\d+ units restored$/.test(tip.lines[2]) && /^\d+ units lost at this reset$/.test(tip.lines[3]) && tip.lines.length === 4 && tip.cross === 0 && tip.inline === 0);
      {
        const section = await usage.locator(CODEX).boundingBox(), bubble = await usage.locator('.mock-tip').boundingBox();
        const top = Math.max(0, Math.min(section.y, bubble.y) - 12), bottom = Math.max(section.y + section.height, bubble.y + bubble.height) + 12;
        await usage.screenshot({ path: join(usageDir, 'v6-limits-stacked-tip.png'), clip: { x: section.x - 12, y: top, width: section.width + 24, height: bottom - top } });
      }
      await usage.mouse.move(5, 5);
      // Banked-credit flags: the two Codex credits expiring ten minutes apart in about five hours get one flag each, poles on their own expiry; the second is lifted onto the next row instead of overlapping the first.
      const flag = await usage.evaluate(selector => {
        const chart = document.querySelector(selector), r = el => el.getBoundingClientRect(), plotNode = chart.querySelector('.su-pooled .su-plot'), plot = r(plotNode), nodes = [...chart.querySelectorAll('.su-flag')];
        const start = Number(plotNode.dataset.start), end = Number(plotNode.dataset.end);
        const flags = nodes.map(node => { const box = r(node), svg = r(node.querySelector('svg'));
          return { account: node.dataset.account, row: node.dataset.row, box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, pole: Math.abs(svg.left + svg.width * 5 / 24 - (plot.left + (Number(node.dataset.t) - start) / (end - start) * plot.width)) }; });
        const overlap = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
        return { flags, apart: flags.every((a, i) => flags.every((b, j) => i === j || !overlap(a.box, b.box))), above: flags.every(item => item.box.bottom <= plot.top + 0.5),
          counts: chart.querySelectorAll('.su-flag-count').length, other: document.querySelectorAll('.su-provider-limits[data-provider="anthropic"] .su-flag').length };
      }, CODEX);
      const flagTips = [];
      for (const index of [0, 1]) {
        await usage.locator(`${CODEX} .su-flag`).nth(index).hover();
        await usage.waitForSelector('.mock-tip');
        flagTips.push(await usage.evaluate(() => [...document.querySelectorAll('.mock-tip span > span')].map(node => node.textContent)));
        await usage.mouse.move(5, 5);
      }
      console.log(`USAGE LIMITS FLAG: ${JSON.stringify({ flag, flagTips })}`);
      check('Each banked credit gets its own flag above the Codex plot, pole on its expiry within 1px, the close second one lifted onto the next row without overlap, no count badge, one tooltip line each', flag.flags.length === 2 && flag.flags.every(item => item.pole <= 1)
        && flag.flags.map(item => item.row).join() === '0,1' && flag.apart && flag.above && flag.counts === 0 && flag.other === 0
        && flagTips.every(lines => lines.length === 1) && /^chatgptvitibot · banked reset expires \w{3} \d{1,2}:\d{2} (AM|PM)$/.test(flagTips[0][0]) && /^chatgpt1 · banked reset expires \w{3} \d{1,2}:\d{2} (AM|PM)$/.test(flagTips[1][0]));
      // Projected reset steps are dashed like the projection line; only realized (past) step-ups are solid.
      const segments = await usage.evaluate(selector => [...document.querySelectorAll(`${selector} .su-reset-mark`)].map(node => { const style = getComputedStyle(node.querySelector('.su-reset-seg')); return { kind: node.dataset.kind, dashed: style.backgroundImage.includes('repeating-linear-gradient'), solid: style.borderLeftStyle === 'solid' }; }), CODEX);
      check('Projected reset segments are dashed, never a solid line', segments.some(item => item.kind === 'projected') && segments.filter(item => item.kind === 'projected').every(item => item.dashed && !item.solid));
      await usage.mouse.move(5, 5);
    }
    // Pixels along the slider's middle row: the track left of the thumb stays unfilled and the part to its right carries the fill color (the thumb's own color), since the filled part is the averaged period reaching back from now.
    const sliderFill = async () => {
      const slider = usage.locator('.su-lookback input[type=range]'), box = await slider.boundingBox();
      const png = (await slider.screenshot()).toString('base64');
      return usage.evaluate(async ([data, width, height, share]) => {
        const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        const scale = image.width / width, row = Math.round(height / 2 * scale), at = x => [...context.getImageData(Math.round(x * scale), row, 1, 1).data.slice(0, 3)];
        const thumb = 6 + (width - 12) * share, distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        const color = at(thumb), left = thumb > 14 ? at(thumb - 10) : null, right = thumb < width - 14 ? at(thumb + 10) : null;
        return { thumb, color, left, right, leftFilled: left ? distance(left, color) < 40 : null, rightFilled: right ? distance(right, color) < 40 : null };
      }, [png, box.width, box.height, Number(await slider.evaluate(el => el.style.getPropertyValue('--su-share')))]);
    };
    {
      const fill = await sliderFill();
      console.log(`USAGE SLIDER FILL: ${JSON.stringify(fill)}`);
      check('Limits lookback slider runs longest-first and fills the track to the right of the thumb', await usage.locator('.su-lookback input[type=range]').inputValue() === '6' && fill.rightFilled === true && fill.leftFilled === false);
      const range = usage.locator('.su-lookback input[type=range]');
      await range.focus(); await usage.keyboard.press('ArrowRight');
      await usage.waitForFunction(() => document.querySelector('.su-lookback-value')?.textContent === '5h');
      const right = await range.getAttribute('aria-valuetext');
      await usage.keyboard.press('ArrowLeft'); await usage.keyboard.press('ArrowLeft');
      await usage.waitForFunction(() => document.querySelector('.su-lookback-value')?.textContent === '1d');
      check('Limits lookback arrow keys follow the visual direction (Right = shorter) with the stop as aria-valuetext', right === '5h' && await range.getAttribute('aria-valuetext') === '1d' && await range.getAttribute('aria-label') === 'Projections based on');
      await usage.keyboard.press('ArrowRight');
      await usage.waitForFunction(() => document.querySelector('.su-lookback-value')?.textContent === '12h');
      await range.blur();
    }
    const pooledPlot = await usage.locator(`${CODEX} .su-pooled .su-plot`).boundingBox();
    await usage.mouse.move(pooledPlot.x + pooledPlot.width * 0.55, pooledPlot.y + pooledPlot.height / 2);
    check('Limits hover reports a projected value in plan units with its local time, on the hovered chart only', /^\w{3} \d{1,2}:\d{2}.* · \d+(\.\d)? units left \(projected\)$/.test(await usage.locator(`${CODEX} .su-pooled .su-tip`).textContent())
      && await usage.locator(`${ANTHROPIC} .su-pooled .su-tip`).count() === 0);
    await usage.mouse.move(5, 5);
    await usage.locator('.harness-page').screenshot({ path: join(usageDir, 'v6-limits-top.png') });
    {
      // The overview scrolled so the second provider's section starts at the top of the page.
      await usage.evaluate(selector => { const page = document.querySelector('.su'), section = document.querySelector(selector); page.scrollTop += section.getBoundingClientRect().top - page.getBoundingClientRect().top - 12; }, ANTHROPIC);
      await settle(usage);
      const scrolled = await usage.evaluate(selector => { const node = document.querySelector('.su'), page = node.getBoundingClientRect(), section = document.querySelector(selector), chart = section.querySelector('.su-pooled').getBoundingClientRect();
        return { scrollTop: node.scrollTop, bottom: node.scrollHeight - node.clientHeight - node.scrollTop, top: section.getBoundingClientRect().top - page.top, chartShown: chart.top >= page.top && chart.bottom <= page.bottom }; }, ANTHROPIC);
      console.log(`USAGE LIMITS SCROLLED: ${JSON.stringify(scrolled)}`);
      // The page may end before the section reaches the top; then it is scrolled all the way down.
      check('The overview scrolls to the Anthropic section and shows its whole chart', scrolled.scrollTop > 0 && (Math.abs(scrolled.top - 12) <= 1 || scrolled.bottom <= 1) && scrolled.chartShown);
      await usage.locator('.harness-page').screenshot({ path: join(usageDir, 'v6-limits-second.png') });
      await usage.evaluate(() => { document.querySelector('.su').scrollTop = 0; });
    }
    {
      const before = { rates: await rates(), paths: await usage.evaluate(() => [...document.querySelectorAll('.su-line.su-projected')].map(path => path.getAttribute('d'))), empty: (await measure()).empty?.right };
      // Reversed slider: position 5 from the left is 1d (30d, 15d, 7d, 3d, 2d, 1d, …, 1h). A day still includes today's burst, so the Codex pool still runs dry, just later.
      await usage.locator('.su-lookback input[type=range]').fill('5');
      await usage.waitForFunction(() => document.querySelector('.su-lookback-value')?.textContent === '1d');
      await settle(usage);
      const after = { rates: await rates(), paths: await usage.evaluate(() => [...document.querySelectorAll('.su-line.su-projected')].map(path => path.getAttribute('d'))), geometry: await measure(), other: await measureIn(ANTHROPIC) };
      console.log(`USAGE LIMITS 1D: ${JSON.stringify({ before, after })}`);
      check('The shared lookback slider changes every provider\'s drain rate text and projection', after.rates.length === 2 && after.rates.every((text, index) => text !== before.rates[index] && /^~\d+(\.\d)? units per hour$/.test(text))
        && after.paths.every((path, index) => path !== before.paths[index]) && after.geometry.empty && Math.abs(after.geometry.empty.right - before.empty) > 1);
      check('Limits arrows still span Now to the moved zero crossing and Now − 1d to Now after the slider change, on both charts', Math.abs(after.geometry.empty.left - after.geometry.nowX) <= 1 && Math.abs(after.geometry.empty.right - after.geometry.emptyX) <= 1
        && averageOk(after.geometry) && labelsOk(after.geometry) && averageOk(after.other) && labelsOk(after.other) && /^Average over 1d/.test(after.other.average.text));
      check('Limits lookback persists in the usage preferences as hours, not the slider position', await usage.evaluate(() => JSON.parse(localStorage.getItem('hermes.plugin.hermes-t3sidebar.usage-preferences')).lookback) === 24);
      const fill1d = await sliderFill();
      check('Limits lookback fill still starts at the moved thumb and runs to the right end', fill1d.rightFilled === true && fill1d.leftFilled === false);
      // 15 days reach back past the 2.1 days of past on the chart: every averaging line is cut at the plot edge, without a left arrowhead.
      await usage.locator('.su-lookback input[type=range]').fill('1');
      await usage.waitForFunction(() => document.querySelector('.su-lookback-value')?.textContent === '15d');
      await settle(usage);
      check('Limits lookback beyond the history requests more and says how much data it used', await usage.evaluate(() => window.hermesT3SidebarHarness.calls.some(call => call[0] === 'rest' && call[1] === '/usage/limits?hours=360')));
      const clipped = await measure(), otherClipped = await measureIn(ANTHROPIC);
      console.log(`USAGE LIMITS 15D: ${JSON.stringify({ clipped, otherClipped })}`);
      check('Limits 15d averaging lines are clipped at the plot edge with no left arrowhead or tick, on both charts', [clipped, otherClipped].every(geometry => geometry.lookbackX < geometry.plotLeft && averageOk(geometry) && geometry.average.arrows === 'end'
        && /^Average over \d+d · ~\d+(\.\d)? units\/h$/.test(geometry.average.text) && labelsOk(geometry)));
      // fill() leaves the slider focused; its focus ring is not part of the resting design.
      await usage.locator('.su-lookback input[type=range]').blur();
      await usage.locator('.su-lookback input[type=range]').fill('6');
      await usage.waitForFunction(() => document.querySelector('.su-lookback-value')?.textContent === '12h');
      await usage.locator('.su-lookback input[type=range]').blur();
    }
    {
      // Horizon: an explicit 7d | 30d segmented control in the controls bar; 7 days by default, 30 days on every chart when chosen.
      const toggleState = () => usage.evaluate(() => {
        const group = document.querySelector('.su-horizon'), charts = [...document.querySelectorAll('.su-pooled')];
        return { role: group.getAttribute('role'), name: group.getAttribute('aria-label'), choices: [...group.querySelectorAll('button')].map(button => `${button.textContent}:${button.getAttribute('aria-pressed')}`).join(), icons: group.querySelectorAll('svg').length, inBar: !!group.closest('.su-limits-controls'),
          days: charts.map(chart => { const plot = chart.querySelector('.su-plot'); return Math.round((Number(plot.dataset.end) - Number(plot.dataset.start)) / 864) / 100; }),
          reachEnd: charts.every(chart => Math.abs(chart.querySelector('.su-line.su-projected').getBoundingClientRect().right - chart.querySelector('.su-plot').getBoundingClientRect().right) <= 2) };
      });
      const initial = await toggleState();
      console.log(`USAGE HORIZON 7D: ${JSON.stringify(initial)}`);
      check('Limits horizon is a labelled 7d | 30d segmented control in the controls bar, 7 days pressed by default on every chart', initial.role === 'group' && initial.name === 'Horizon' && initial.choices === '7d:true,30d:false' && initial.icons === 0
        && initial.inBar && initial.days.join() === '9.1,9.1');
      // Keyboard: Tab reaches the 30d choice and Space presses it.
      await usage.locator('.su-horizon button', { hasText: '7d' }).focus();
      await usage.keyboard.press('Tab');
      const focused = await usage.evaluate(() => document.activeElement?.textContent);
      await usage.keyboard.press('Space');
      await usage.waitForFunction(() => [...document.querySelectorAll('.su-pooled')].every(chart => chart.dataset.horizon === '30'));
      await usage.waitForFunction(() => window.hermesT3SidebarHarness.calls.some(call => call[0] === 'rest' && call[1] === '/usage/limits?hours=216'));
      await usage.locator('.su-horizon button', { hasText: '30d' }).blur();
      await usage.mouse.move(5, 5);
      await settle(usage);
      const extended = await toggleState(), geometry = await measure(), other = await measureIn(ANTHROPIC), axis = await axisState(`${CODEX} .su-pooled`), otherAxis = await axisState(`${ANTHROPIC} .su-pooled`);
      const plot = await usage.evaluate(selector => { const node = document.querySelector(`${selector} .su-pooled .su-plot`); return [Number(node.dataset.start), Number(node.dataset.end)]; }, CODEX);
      const midnights = await pageMidnights(...plot);
      console.log(`USAGE HORIZON 30D: ${JSON.stringify({ focused, extended, geometry, other, axis, otherAxis, midnights })}`);
      check('The keyboard picks 30d, which extends every chart to 30 days and persists', focused === '30d' && extended.choices === '7d:false,30d:true' && extended.days.join() === '39,39' && extended.reachEnd
        && await usage.evaluate(() => JSON.parse(localStorage.getItem('hermes.plugin.hermes-t3sidebar.usage-preferences')).horizon) === 30);
      check('Limits 30-day charts keep one gridline per midnight, readable labels and their measurements', axis.dayLines === midnights && otherAxis.dayLines === midnights && midnights >= 38 && monthsOnChange(axis.labels) && !axis.overlap && !otherAxis.overlap
        && averageOk(geometry) && geometry.lookbackX > geometry.plotLeft && labelsOk(geometry) && averageOk(other) && labelsOk(other));
      check('Limits 30-day 12h averaging span is too short for inner arrowheads, so they point in from outside', geometry.average.tight && geometry.average.right - geometry.average.left < 16 && other.average.tight);
      await usage.locator('.harness-page').screenshot({ path: join(usageDir, 'v6-limits-30d.png') });
      // The 30-day chart shows the banked credits expiring in nine days as their own flags, and last week's stacked resets as quieter past markers.
      const thirty = await usage.evaluate(selector => { const chart = document.querySelector(selector); return { flags: [...chart.querySelectorAll('.su-flag')].map(node => node.querySelector('.su-flag-count')?.textContent ?? '1').join(), past: [...chart.querySelectorAll('.su-reset[data-kind=past]')].map(node => node.querySelectorAll('.su-reset-mark').length).join(), pastLabels: chart.querySelectorAll('.su-reset[data-kind=past] .su-reset-text').length }; }, CODEX);
      console.log(`USAGE HORIZON 30D MARKS: ${JSON.stringify(thirty)}`);
      check('The 30-day Codex chart flags each banked expiry time (×2 only where two credits expire at the same instant) and marks last week\'s stacked resets quietly, without labels', thirty.flags === '1,1,×2' && thirty.past.split(',').includes('2') && thirty.pastLabels === 0);
      await usage.locator('.su-horizon button', { hasText: '7d' }).click();
      await usage.waitForFunction(() => [...document.querySelectorAll('.su-pooled')].every(chart => chart.dataset.horizon === '7'));
      await usage.mouse.move(5, 5);
    }
    {
      // Account details: folded by default, unfolded per provider, remembered across a reload.
      await usage.locator(`${CODEX} .su-disclosure`).click();
      await usage.waitForSelector(`${CODEX} .su-account`);
      const accounts = await usage.evaluate(selector => {
        const r = el => el.getBoundingClientRect(), page = document.querySelector('.su');
        const bars = [...document.querySelectorAll(`${selector} .su-window`)].map(row => { const bar = r(row.querySelector('.su-bar')), pace = row.querySelector('.su-pace'); return !pace || r(pace).left >= bar.left - 1 && r(pace).right <= bar.right + 1; });
        return { codex: document.querySelectorAll(`${selector} .su-account`).length, total: document.querySelectorAll('.su-account').length, paces: bars.length > 0 && bars.every(Boolean), overflowX: page.scrollWidth - page.clientWidth,
          stored: JSON.parse(localStorage.getItem('hermes.plugin.hermes-t3sidebar.usage-preferences')).accounts };
      }, CODEX);
      console.log(`USAGE LIMITS ACCOUNTS: ${JSON.stringify(accounts)}`);
      check('Unfolding Codex accounts shows its two rows with pace ticks inside the bars, leaves Anthropic folded and stores the fold', accounts.codex === 2 && accounts.total === 2 && accounts.paces && accounts.overflowX <= 0
        && JSON.stringify(accounts.stored) === '{"openai-codex":true}');
      const banked = await usage.evaluate(() => {
        const rgb = el => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const paint = canvas.getContext('2d'); paint.fillStyle = getComputedStyle(el).color; paint.fillRect(0, 0, 1, 1); return [...paint.getImageData(0, 0, 1, 1).data.slice(0, 3)]; };
        return Object.fromEntries(['acct-team', 'acct-prolite'].map(id => { const account = document.querySelector(`.su-account[data-account="${id}"]`), bars = account.querySelector('.su-windows').getBoundingClientRect();
          return [id, [...account.querySelectorAll('.su-banked-credit')].map(line => ({ text: line.textContent, soon: line.dataset.soon, color: rgb(line), muted: line.querySelector('.su-banked-unusable') ? rgb(line.querySelector('.su-banked-unusable')) : null, below: line.getBoundingClientRect().top >= bars.bottom }))]; }));
      });
      console.log(`USAGE LIMITS BANKED: ${JSON.stringify(banked)}`);
      const [teamSoon, teamLater] = banked['acct-team'], [proSoon, proLater] = banked['acct-prolite'];
      // The page clock runs on from the fixed start while the test works, so the countdowns may have lost a minute.
      check('Each Codex account lists its banked resets under its bars, soonest first: the one expiring within a day in orange, chatgpt1\'s marked not usable now in muted text', banked['acct-team'].length === 2 && banked['acct-prolite'].length === 2
        && [teamSoon, teamLater, proSoon, proLater].every(line => line.below) && /^Banked reset · expires \w{3} \d{1,2}:\d{2} (AM|PM) \(in (4h 5\dm|5h 0m)\)$/.test(teamSoon.text) && /\(in (8d 23h|9d 0h)\)$/.test(teamLater.text)
        && /\(in 5h \d+m\) · not usable now$/.test(proSoon.text) && /\(in (9d 0h|8d 23h)\) · not usable now$/.test(proLater.text) && teamSoon.soon === 'true' && teamLater.soon === 'false'
        && teamSoon.color[0] > teamSoon.color[2] + 60 && teamLater.color.join() !== teamSoon.color.join() && proSoon.muted && proSoon.muted.join() !== proSoon.color.join() && teamSoon.muted === null);
      await usage.reload();
      await usage.waitForSelector('.sf-footer .sf-limit');
      await usage.locator('.sf-footer .sf-limits').click();
      await usage.waitForSelector(`${CODEX} .su-account`);
      const reloaded = await usage.evaluate(() => [...document.querySelectorAll('.su-disclosure')].map(node => node.getAttribute('aria-expanded')).join());
      check('The account fold survives a reload', reloaded === 'true,false');
      await usage.evaluate(selector => { const page = document.querySelector('.su'), toggle = document.querySelector(`${selector} .su-disclosure`); page.scrollTop += toggle.getBoundingClientRect().top - page.getBoundingClientRect().top - 260; }, CODEX);
      await settle(usage);
      await usage.locator('.harness-page').screenshot({ path: join(usageDir, 'v6-limits-accounts.png') });
      await usage.locator(`${CODEX} .su-disclosure`).click();
      await usage.evaluate(() => { document.querySelector('.su').scrollTop = 0; });
    }
    {
      // A logged-out provider is a compact muted row after the charts, without a chart or account details.
      const loggedOut = await browser.newPage({ viewport: { width: 1300, height: 1000 }, deviceScaleFactor: 1, timezoneId: 'Europe/Paris' });
      loggedOut.on('pageerror', error => errors.push(error.message));
      await loggedOut.emulateMedia({ reducedMotion: 'reduce' });
      await loggedOut.clock.install({ time: new Date('2026-10-28T15:00:00+01:00') });
      await loggedOut.goto(`http://127.0.0.1:${server.address().port}/?limits=logged-out&route=/t3sidebar-limits`);
      await loggedOut.waitForSelector('.su-pooled .su-line.su-projected');
      await loggedOut.waitForSelector('.sf-footer .sf-limit');
      const state = await loggedOut.evaluate(() => {
        const row = document.querySelector('.su-provider-limits[data-auth="logged_out"]'), r = el => el.getBoundingClientRect();
        return { sections: [...document.querySelectorAll('.su-provider-limits')].map(node => node.dataset.provider), text: row?.querySelector('.su-logged-out-row')?.textContent, chart: !!row?.querySelector('.su-pooled'), disclosure: !!row?.querySelector('.su-disclosure'),
          height: row ? r(row).height : null, mark: !!row?.querySelector('svg[data-provider-mark]'), footer: [...document.querySelectorAll('.sf-footer .sf-limit')].map(item => item.dataset.provider).join() };
      });
      console.log(`USAGE LIMITS LOGGED OUT: ${JSON.stringify(state)}`);
      check('Logged-out Anthropic is a compact muted row after the Codex chart, without a chart or accounts, and is left out of the footer', state.sections.join() === 'openai-codex,anthropic'
        && state.text === 'Anthropic · logged out in Hermes — sign in to track limits' + 'No usable Anthropic credential in the Hermes pool' && !state.chart && !state.disclosure && state.mark && state.height < 60 && state.footer === 'openai-codex');
      await loggedOut.evaluate(() => { const page = document.querySelector('.su'); page.scrollTop = page.scrollHeight; });
      await loggedOut.locator('.harness-page').screenshot({ path: join(usageDir, 'v6-limits-logged-out.png') });
      await loggedOut.close();
    }
    {
      // The light scenario: the same accounts with a gentle Codex workload, so Pro 100's reset throws quota away and nothing runs out.
      const light = await browser.newPage({ viewport: { width: 1300, height: 1000 }, deviceScaleFactor: 1, timezoneId: 'Europe/Paris' });
      light.on('pageerror', error => errors.push(error.message));
      await light.emulateMedia({ reducedMotion: 'reduce' });
      await light.clock.install({ time: new Date('2026-10-28T15:00:00+01:00') });
      // A provider saved by the retired Limits tabs must not matter.
      await light.goto(`http://127.0.0.1:${server.address().port}/?limits=light`);
      await light.evaluate(() => localStorage.setItem('hermes.plugin.hermes-t3sidebar.usage-preferences', JSON.stringify({ provider: 'anthropic' })));
      await light.reload();
      await light.waitForSelector('.sf-footer .sf-limit');
      const footer = await light.evaluate(() => { const items = [...document.querySelectorAll('.sf-limit')]; return { items: items.map(item => `${item.dataset.provider}:${item.dataset.status}:${item.querySelector('[data-verdict-icon] svg')?.getAttribute('data-icon')}:${item.dataset.severity}`), label: document.querySelector('.sf-limits').getAttribute('aria-label') }; });
      check('Footer items show the clock-x for every pool whose quota will expire unused, coloured by severity (Codex over a third: orange; Anthropic under: muted)', footer.items.join() === 'openai-codex:waste:ClockX:medium,anthropic:waste:ClockX:low' && /OpenAI Codex: \d+ \/ 120 units · \d+ units will expire unused by \w{3}\./.test(footer.label));
      await light.locator('.sf-footer .sf-limits').click();
      // The mark itself is 0px wide (its line and arrows overflow it), so wait for it in the DOM rather than for visibility.
      await light.waitForSelector(`${CODEX} .su-pooled .su-waste`, { state: 'attached' });
      const opened = await light.evaluate(() => ({ route: document.querySelector('.harness-route')?.dataset.route, sections: [...document.querySelectorAll('.su-provider-limits')].map(node => node.dataset.provider).join() }));
      check('Clicking the Limits button opens the overview of every provider, ignoring a stored provider choice', opened.route === '/t3sidebar-limits' && opened.sections === 'openai-codex,anthropic');
      await settle(light);
      const waste = await wasteGeometry(light, CODEX);
      const empty = await light.locator(`${CODEX} .su-measure[data-kind="empty"]`).count();
      console.log(`USAGE LIMITS WASTE (light): ${JSON.stringify({ waste, empty })}`);
      check('Limits light week: a factual waste verdict after an orange clock-x (over a third of the capacity) and a waste measurement at the reset, no time-to-empty', waste.verdict?.status === 'waste' && waste.verdict.severity === 'medium' && waste.verdict.icon === 'ClockX'
        && waste.verdict.iconColor[0] > waste.verdict.iconColor[2] + 60 && /^\d+(\.\d)? units will expire unused by \w{3}$/.test(waste.verdict.text) && waste.marks.length >= 1 && waste.marks.every(mark => wasteOk(mark, 'chatgpt1 · Pro 100')) && waste.apart && empty === 0);
      await light.mouse.move(5, 5);
      await light.locator('.harness-page').screenshot({ path: join(usageDir, 'v6-limits-7d-waste.png') });
      await light.close();
    }
    // A narrow workspace keeps both pages usable without horizontal scrolling.
    await usage.setViewportSize({ width: 900, height: 1000 });
    await usage.waitForSelector('.su-pooled .su-measures');
    // Labels are re-clamped by a ResizeObserver; a fixed number of frames raced its delivery, so wait until every label's width budget matches its row's current width.
    await usage.waitForFunction(() => [...document.querySelectorAll('.su-measures')].every(row => {
      const width = row.getBoundingClientRect().width, gap = side => side === 'left' || side === 'right' ? 1 : 0;
      return [...row.querySelectorAll('.su-measure-text')].every(label => Math.abs(parseFloat(label.style.maxWidth) - Math.max(0, (Number(label.dataset.high) - Number(label.dataset.low)) / 100 * width - gap(label.dataset.side) * 12)) < 1);
    }), null, { timeout: 5000 });
    await settle(usage);
    {
      const geometry = await measure(), other = await measureIn(ANTHROPIC), overflow = await usage.evaluate(() => { const root = document.querySelector('.su'); return root.scrollWidth - root.clientWidth; });
      console.log(`USAGE LIMITS NARROW: ${JSON.stringify({ geometry, other, overflow })}`);
      // Too narrow for a whole averaging label left of Now: it is ellipsized (full text in its title) rather than crossing Now.
      check('Limits page fits a narrow workspace: no overflow and every chart keeps its measurement labels on their side of Now', overflow <= 0 && averageOk(geometry) && labelsOk(geometry, { full: false }) && averageOk(other) && labelsOk(other, { full: false }));
    }
    await usageButton.click();
    await usage.waitForSelector('.su-chart[data-metric="tokens"]');
    layout = await usageLayout();
    check('Usage page fits a narrow workspace without horizontal overflow', layout.overflowX <= 0 && layout.inside && layout.aligned);
    await usage.locator('.harness-page').screenshot({ path: join(usageDir, 'usage-narrow.png') });
    await usage.close();
  }
  check('no browser page errors', errors.length === 0);
  console.log(`Browser smoke: ${checks.length} checks passed; screenshots ${screenshotDir}/{frontend,hovered,actions,dense-400,dense-650,short-300-error}.png`);
} finally { await browser?.close(); server.close(); }
