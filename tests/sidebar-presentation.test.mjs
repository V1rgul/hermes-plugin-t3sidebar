// Sidebar presentation: the status strip, the no-match state, skeleton loading, the draft pencil, the shared card tooltip and the footer page toggle.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import { createController, HermesT3Sidebar, UsagePage, USAGE_ROUTE, LIMITS_ROUTE } from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const h = React.createElement;
let root, controller;
const page = mock.atom(null);
const tick = async (ms = 15) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const $ = selector => document.querySelector(selector);
const all = selector => [...document.querySelectorAll(selector)];
const row = id => $(`[data-session-id="${id}"]`);
const button = label => all('button').find(node => node.getAttribute('aria-label') === label || node.textContent === label);
async function click(node) { assert.ok(node, 'button exists'); await act(async () => { node.click(); }); await tick(); }
async function input(node, value) {
	await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); }); await tick();
}
async function refresh() { await act(async () => mock.queryClient.invalidateQueries()); await tick(); }
// The workspace beside the sidebar: a plugin page while `page` names one, as Desktop mounts route pages.
function Workspace() {
	const route = mock.useValue(page);
	return h(React.Fragment, null, h(HermesT3Sidebar, { ctx: mock.ctx, controller }), route ? h(UsagePage, { ctx: mock.ctx, view: route === LIMITS_ROUTE ? 'limits' : 'usage' }) : null);
}
async function mount() {
	controller = createController(mock.ctx);
	root = createRoot($('#app'));
	await act(async () => root.render(h(QueryClientProvider, { client: mock.queryClient }, h(Workspace))));
	await tick(); await tick();
}
async function show(route) { await act(async () => page.set(route)); await tick(); }
afterEach(async () => {
	if (root) { await act(async () => root.unmount()); root = null; }
	controller?.dispose(); controller = null; page.set(null); mock.control.listGate = null;
	mock.reset();
});

test('several problems share one single-line strip; its details keep every complete message', async () => {
	mock.control.runtimeError = true; mock.control.backendMissing = true;
	await mount();
	const strips = all('.sf-strip');
	assert.equal(strips.length, 1, 'one strip, not a box per problem');
	assert.equal(all('.sf-note[role=alert]').length, 0);
	const [strip] = strips, toggle = strip.querySelector('.sf-strip-toggle'), details = strip.querySelector('.sf-strip-details');
	assert.equal(strip.getAttribute('role'), 'alert');
	assert.equal(toggle.getAttribute('aria-expanded'), 'false'); assert.equal(details.hidden, true);
	const messages = [...details.querySelectorAll('li')].map(item => item.textContent);
	assert.ok(messages.length >= 2);
	assert.equal(strip.querySelector('.sf-strip-more').textContent, `+${messages.length - 1}`);
	assert.ok(messages.some(text => /^hermes-t3sidebar backend unavailable: 404 backend not enabled\. Read-only browsing/.test(text)));
	assert.ok(messages.some(text => /^Runtime status unavailable: /.test(text)));
	await click(toggle);
	assert.equal(toggle.getAttribute('aria-expanded'), 'true'); assert.equal(details.hidden, false);
	assert.equal(toggle.getAttribute('aria-controls'), details.id);
	// Retry reads the failed feeds again.
	const before = mock.calls.length;
	mock.control.runtimeError = false; mock.control.backendMissing = false;
	await click(button('Retry')); await tick(); await tick();
	assert.ok(mock.calls.length > before);
	assert.equal(all('.sf-strip').length, 0, 'the strip disappears once nothing is wrong');
});

test('a list-wide runtime outage hides the per-card "?" through the list, while each card still says status unknown', async () => {
	await mount();
	assert.equal($('.sf-scroll').dataset.runtimeUnknown, 'false');
	mock.control.runtimeError = true; await refresh();
	assert.equal($('.sf-scroll').dataset.runtimeUnknown, 'true');
	assert.match(row('design').querySelector('.sf-open').getAttribute('aria-label'), /status unknown/);
	assert.match($('.sf-strip-summary').textContent, /Runtime status unavailable/);
});

test('a search without loaded matches says so under the search field and offers only older history, with its scope', async () => {
	mock.control.rows = Array.from({ length: 500 }, (_, index) => ({ id: `s${index}`, title: `Recent ${index}` }));
	mock.control.extra = [{ id: 'older', title: 'Forgotten experiment', cwd: '/older' }];
	await mount();
	await input($('input[type=search]'), 'Forgotten experiment');
	const empty = $('.sf-no-match');
	assert.ok(empty);
	assert.equal(empty.parentElement.classList.contains('sf-scroll'), true);
	assert.ok(empty.compareDocumentPosition($('.sf-section')) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'above every shelf');
	assert.match(empty.textContent, /^No matching sessions/);
	assert.doesNotMatch(document.body.textContent, /All caught up/);
	assert.equal(empty.querySelector('.sf-no-match-hint').textContent, 'Search covers loaded sessions only.');
	// The search field's cross already clears the query: the state adds no Clear search or Clear filter action.
	assert.deepEqual([...empty.querySelectorAll('button')].map(node => node.textContent), ['Browse older sessions']);
	assert.equal(all('button').filter(node => node.textContent === 'Browse older sessions').length, 1, 'the list foot does not repeat it');
	await click(empty.querySelector('button')); await tick();
	assert.ok(row('older'), 'the older match is found once its page loads');
	assert.equal(all('.sf-no-match').length, 0);
});

test('a search without matches and no more history shows neither the hint nor the browse action', async () => {
	await mount();
	await input($('input[type=search]'), 'no-such-session-4711');
	assert.match($('.sf-no-match').textContent, /^No matching sessions$/);
	assert.equal(all('.sf-no-match-hint').length, 0);
	assert.equal(all('.sf-no-match button').length, 0);
});

test('the first load shows busy skeleton cards that announce loading, replaced by the real cards', async () => {
	let release;
	mock.control.listGate = new Promise(resolve => { release = resolve; });
	await mount();
	const skeleton = $('.sf-skeleton');
	assert.ok(skeleton);
	assert.equal(skeleton.getAttribute('role'), 'status'); assert.equal(skeleton.getAttribute('aria-busy'), 'true');
	assert.equal(skeleton.textContent, 'Loading sessions…');
	assert.equal(skeleton.querySelectorAll('.sf-skeleton-card[aria-hidden=true]').length, 3);
	assert.equal(all('.sf-note').filter(node => /Loading sessions/.test(node.textContent)).length, 0, 'no boxed loading note');
	await act(async () => release()); await tick(); await tick();
	assert.equal(all('.sf-skeleton').length, 0);
	assert.ok(row('design'));
});

test('the draft pencil marks every card with a draft, the viewed one included, following its focused composer', async () => {
	mock.control.drafts.readme = 'unsent text';
	await mount();
	const mark = id => row(id).querySelector('.sf-draft-mark');
	assert.equal(row('readme').dataset.current, 'false');
	assert.equal(row('readme').dataset.hasDraft, 'true');
	assert.equal(mark('readme').getAttribute('aria-label'), 'Unsent draft');
	assert.equal(mark('readme').getAttribute('role'), 'img');
	// Right of the time and the status badge: the last item of the metadata line, where the hover actions cover it, so the card's own tip and description name the draft.
	assert.equal(mark('readme') === row('readme').querySelector('.sf-card-meta').lastElementChild, true);
	assert.equal(mark('readme').previousElementSibling.classList.contains('sf-time'), true);
	const readme = row('readme').querySelector('.sf-open');
	assert.match(readme.dataset.sfTip, /\nUnsent draft$/);
	assert.match(readme.getAttribute('aria-description'), /, Unsent draft$/);
	assert.doesNotMatch(row('design').querySelector('.sf-open').dataset.sfTip, /Unsent draft/);
	assert.equal(!!mark('design'), false);
	// The viewed card follows its composer through its own existing read, which Desktop repeats every two seconds (React Query runs no intervals here, having loaded before the DOM, so the test runs that read itself; the browser smoke covers the interval).
	const readComposers = async () => { await act(async () => mock.queryClient.refetchQueries({ queryKey: ['hermes-t3sidebar-drafts'], type: 'active' })); await tick(); };
	assert.equal(row('design').dataset.current, 'true');
	mock.control.mountedDrafts.design = 'typing';
	await readComposers();
	assert.ok(mark('design'), 'typed text marks the viewed card');
	assert.equal(row('design').dataset.current, 'true');
	mock.control.mountedDrafts.design = '';
	await readComposers();
	assert.equal(!!mark('design'), false, 'an emptied or sent composer drops the pencil');
});

test('card details open one shared tooltip on hover instead of a native title', async () => {
	await mount();
	const open = row('design').querySelector('.sf-open');
	assert.equal(open.getAttribute('title'), null, 'never both a native title and the SDK tooltip');
	assert.equal(open.dataset.sfTip, 'Sidebar layout\n/projects/hermes-t3sidebar\nfeature/sidebar\nidle');
	assert.match(open.getAttribute('aria-description'), /\/projects\/hermes-t3sidebar, feature\/sidebar/);
	const over = target => act(async () => { target.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true })); });
	await over(open.querySelector('.sf-row-title'));
	await tick(300);
	assert.equal(all('[role=tooltip]').length, 0, 'a card waits longer than a control before its tip');
	await tick(400);
	const tip = $('[role=tooltip]');
	assert.ok(tip);
	const lines = [...tip.querySelectorAll('span > span')];
	assert.deepEqual(lines.map(node => node.textContent), ['Sidebar layout', '/projects/hermes-t3sidebar', 'feature/sidebar', 'idle']);
	// The title leads in bold and only the folder line is dimmed.
	assert.deepEqual(lines.map(node => [node.style.fontWeight, node.style.opacity]), [['700', ''], ['', '0.6'], ['', ''], ['', '']]);
	assert.equal(tip.dataset.side, 'right', 'out of the pane rather than over the neighbouring cards');
	// Moving to another labelled part while a tip shows switches at once.
	await over(row('design').querySelector('.sf-archive'));
	assert.equal($('[role=tooltip]').textContent, 'Archive session');
	await act(async () => { row('design').dispatchEvent(new window.MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })); });
	assert.equal(all('[role=tooltip]').length, 0);
});

test('a trigger whose menu is open shows no tip, even when the pointer armed it before the click', async t => {
	// Hovering the card starts its title reveal, which runs on animation frames.
	const saved = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
	Object.assign(globalThis, { requestAnimationFrame: callback => setTimeout(() => callback(performance.now()), 16), cancelAnimationFrame: clearTimeout });
	t.after(() => Object.assign(globalThis, { requestAnimationFrame: saved.raf, cancelAnimationFrame: saved.caf }));
	await mount();
	const over = target => act(async () => { target.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true })); });
	const snooze = () => row('design').querySelector('[aria-label="Snooze session"]');
	await over(snooze());
	await act(async () => snooze().click()); await tick();
	// Opening the menu remounts the trigger, whose pointerover arms the tip again.
	await over(snooze());
	await tick(300);
	assert.equal(snooze().getAttribute('aria-expanded'), 'true');
	assert.equal(all('[role=tooltip]').length, 0, 'the tip would cover the menu and take its first Escape');
	// Once the menu is closed, the same trigger shows its tip again.
	await act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await tick();
	await act(async () => { row('design').dispatchEvent(new window.MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })); });
	await over(snooze());
	await tick(300);
	assert.equal($('[role=tooltip]')?.textContent, 'Snooze session');
});

test('re-clicking the shown page\'s footer button returns to the session it covered, also after switching pages', async () => {
	await mount();
	await click(button('Usage'));
	assert.deepEqual(mock.calls.filter(call => call[0] === 'navigate').at(-1), ['navigate', USAGE_ROUTE]);
	await show(USAGE_ROUTE);
	const usage = $(`.sf-footer [data-route="${USAGE_ROUTE}"]`);
	assert.equal(usage.getAttribute('aria-current'), 'page'); assert.equal(usage.getAttribute('aria-label'), 'Close Usage');
	// The host may drop its selection while a page is up; the session shown before the page is what comes back.
	await act(async () => mock.host.state.focusedStoredSessionId.set(null));
	// Limits from Usage switches pages; re-clicking Limits goes back past Usage to the session.
	await click($(`.sf-footer [data-route="${LIMITS_ROUTE}"]`));
	assert.deepEqual(mock.calls.filter(call => call[0] === 'navigate').at(-1), ['navigate', LIMITS_ROUTE]);
	await show(LIMITS_ROUTE);
	const limits = $(`.sf-footer [data-route="${LIMITS_ROUTE}"]`);
	assert.match(limits.getAttribute('aria-label'), /^Close Limits/);
	const navigations = mock.calls.filter(call => call[0] === 'navigate').length;
	await click(limits); await tick();
	assert.deepEqual(mock.calls.filter(call => call[0] === 'open').map(call => call[1]), ['design']);
	assert.equal(mock.calls.filter(call => call[0] === 'navigate').length, navigations, 'not back to Usage');
});

test('closing a page whose covered session is gone starts a new chat; closing over a new draft returns to the chat route', async () => {
	await mount();
	await show(USAGE_ROUTE);
	mock.control.rows = mock.control.rows.filter(item => item.id !== 'design'); await refresh();
	await click($(`.sf-footer [data-route="${USAGE_ROUTE}"]`)); await tick();
	assert.equal(mock.calls.some(call => call[0] === 'open'), false);
	assert.equal(mock.calls.filter(call => call[0] === 'new').length, 1);
	await show(null);
	await act(async () => mock.host.state.focusedStoredSessionId.set(null)); await tick();
	await show(USAGE_ROUTE);
	await click($(`.sf-footer [data-route="${USAGE_ROUTE}"]`));
	assert.deepEqual(mock.calls.filter(call => call[0] === 'navigate').at(-1), ['navigate', '/']);
	assert.equal(mock.calls.filter(call => call[0] === 'new').length, 1, 'the draft that was shown is kept');
});
