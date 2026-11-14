// Deterministic work counts for the sidebar's poll, keystroke and render paths (synthetic fixtures; no timing).
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import { createController, captureScope, scopeKey, draftSyncKey, HermesT3Sidebar } from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let root, controller;
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const row = id => document.querySelector(`[data-session-id="${id}"]`);
const button = label => [...document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label);
async function type(node, value) {
	await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
	await tick();
}
async function mount() {
	controller = createController(mock.ctx);
	root = createRoot(document.querySelector('#app'));
	await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(HermesT3Sidebar, { ctx: mock.ctx, controller }))));
	await tick(); await tick();
}
// Replaces a prototype method with a counting wrapper for the duration of `work`.
async function counting(target, name, count, work) {
	const original = target[name];
	target[name] = function(...args) { count(this, args); return original.apply(this, args); };
	try { await work(); } finally { target[name] = original; }
}
afterEach(async () => {
	if (root) { await act(async () => root.unmount()); root = null; }
	controller?.dispose(); controller = null;
	mock.reset();
});

test('a draft-view change does not merge history, runtimes and archives again', async () => {
	await mount();
	let reads = 0;
	// A stored row whose source getter counts every merge pass that visits it; merged copies do not inherit the getter.
	class CountedRow { constructor(fields) { Object.assign(this, fields); } get source() { reads++; return 'desktop'; } }
	const scope = captureScope();
	await act(async () => mock.queryClient.setQueryData([...scopeKey(scope), 'sessions'], previous => ({ ...previous,
		sessions: [...previous.sessions, new CountedRow({ id: 'counted', title: 'Counted history', cwd: '/projects/docs', message_count: 2, last_active: Date.now() / 1000 - 60 })] })));
	await tick();
	assert.equal(row('counted') !== null, true);
	assert.ok(reads > 0, 'the merge visits the row when history changes');
	reads = 0;
	await act(async () => mock.queryClient.setQueryData(draftSyncKey(scope), [{ session_id: 'remote-draft', cwd: '/projects/remote', project: null, edited_at: Date.now() / 1000 }]));
	await tick();
	assert.equal(row('remote-draft') !== null, true, 'the new draft card is shown');
	assert.equal(reads, 0, 'the draft change reuses the merged history');
});

test('search keystrokes do not render the empty-session draft observers again', async () => {
	mock.control.rows.push({ id: 'fresh', source: 'desktop', message_count: 0, cwd: '/projects/docs', project: { id: 'synthetic:/projects/docs', name: 'docs', cwd: '/projects/docs', is_home: false }, last_active: Date.now() / 1000 - 30 });
	// A server draft keeps the empty session listed without asking its observer; the search below hides its card.
	mock.control.serverDrafts = [{ session_id: 'fresh', text: 'synthetic draft', cwd: '/projects/docs', edited_at: Date.now() / 1000, seq: 1, project: null }];
	await mount(); await tick();
	assert.equal(row('fresh') !== null, true);
	let identities = 0;
	await counting(JSON, 'stringify', (_, [value]) => { if (Array.isArray(value) && value.length === 2 && value[0] === 'fresh') identities++; }, async () => {
		await type(document.querySelector('input[type=search]'), 'zz');
		await type(document.querySelector('input[type=search]'), 'zzz');
	});
	assert.equal(row('fresh') === null, true);
	assert.equal(identities, 0, 'the observer list is kept while its inputs are unchanged');
});

test('hidden empty sessions keep their draft observer', async () => {
	mock.control.rows.push({ id: 'fresh', source: 'desktop', message_count: 0, cwd: '/projects/docs', project: { id: 'synthetic:/projects/docs', name: 'docs', cwd: '/projects/docs', is_home: false }, last_active: Date.now() / 1000 - 30 });
	await mount();
	assert.equal(row('fresh') === null, true, 'an empty session without a draft is hidden');
	mock.control.drafts.fresh = 'typed in its composer';
	await act(async () => mock.queryClient.invalidateQueries({ queryKey: [...scopeKey(captureScope()), 'runtime'] })); await tick(); await tick();
	assert.equal(row('fresh') !== null, true, 'its observer still notices the draft');
});

test('card keydown rejects other keys before scanning the visible cards, and navigation scans them once', async () => {
	await mount();
	const cards = document.querySelectorAll('.sf-row').length;
	const order = [...document.querySelectorAll('.sf-row')].map(node => node.dataset.sessionId);
	let visits = 0;
	// Only the visible-card list spans every unfolded shelf; per-shelf lists are shorter.
	const count = (array, [callback]) => { if (Array.isArray(array) && array.length === cards && typeof callback === 'function' && array[0]?.section) visits += array.length; };
	const press = key => act(async () => row(order[1]).querySelector('.sf-open').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
	for (const name of ['map', 'find', 'findIndex', 'filter', 'some']) await counting(Array.prototype, name, count, () => press('a'));
	assert.equal(visits, 0, 'a key that does not navigate visits no card');
	row(order[1]).querySelector('.sf-open').focus();
	let finds = 0;
	await counting(Array.prototype, 'find', (array, [callback]) => { if (Array.isArray(array) && array.length === cards && typeof callback === 'function' && array[0]?.section) finds++; }, () => press('ArrowDown'));
	await tick();
	assert.equal(finds, 0, 'the target comes from the index already found');
	assert.equal(document.activeElement.closest('[data-session-id]').dataset.sessionId, order[2]);
});

test('hidden token counts are not formatted when a card renders', async () => {
	mock.ctx.storage.set('show-tokens', false);
	await mount();
	const descriptor = Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype, 'format');
	let formatted = 0;
	Object.defineProperty(Intl.NumberFormat.prototype, 'format', { ...descriptor, get() { const format = descriptor.get.call(this); return value => { formatted++; return format(value); }; } });
	try {
		await act(async () => mock.queryClient.setQueryData([...scopeKey(captureScope()), 'sessions'], previous => ({ ...previous, sessions: previous.sessions.map(item => item.id === 'design' ? { ...item, title: 'Retitled' } : item) })));
		await tick();
	} finally { Object.defineProperty(Intl.NumberFormat.prototype, 'format', descriptor); }
	assert.equal(row('design').querySelector('.sf-row-title').textContent, 'Retitled');
	assert.equal(formatted, 0);
});

test('the custom snooze time is validated only in the snooze menu, for a value, and still on submit', async () => {
	await mount();
	let validations = 0;
	const isWakePattern = regex => regex.source === String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$`;
	await counting(RegExp.prototype, 'test', regex => { if (isWakePattern(regex)) validations++; }, async () => {
		await act(async () => row('design').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))); await tick();
		assert.ok(document.querySelector('[role=dialog][aria-label="Session actions"]'));
		await act(async () => button('Rename').click()); await tick();
	});
	assert.equal(validations, 0, 'the ordinary menu has no custom field to validate');
	await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await tick();
	await counting(RegExp.prototype, 'test', regex => { if (isWakePattern(regex)) validations++; }, async () => {
		await act(async () => row('design').querySelector('[aria-label="Snooze session"]').click()); await tick();
	});
	assert.equal(validations, 0, 'an empty custom field needs no validation');
	const field = document.querySelector('[aria-label="Custom snooze date and time"]'), apply = () => button('Apply custom snooze');
	await type(field, '2001-01-01T09:00');
	assert.equal(apply().getAttribute('data-valid'), 'false');
	const future = new Date(Date.now() + 86400000 * 3), pad = value => String(value).padStart(2, '0');
	await type(field, `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T10:00`);
	assert.equal(apply().getAttribute('data-valid'), 'true');
	await type(field, '2001-01-01T09:00');
	await act(async () => apply().click()); await tick();
	assert.match(document.querySelector('[role=dialog][aria-label="Snooze session"] [role=alert]').textContent, /future time/);
});
