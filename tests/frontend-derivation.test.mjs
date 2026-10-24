// Synthetic SDK fixtures exercise the real React tree; counters measure work, not latency.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import * as flow from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let root, controller;
const tick = async () => act(async () => new Promise(resolve => setTimeout(resolve, 15)));
const button = name => [...document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === name || node.textContent === name);
const input = async value => {
	const node = document.querySelector('[aria-label="Search sessions"]');
	await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
	await tick();
};
async function mount() {
	mock.control.rows = Array.from({ length: 120 }, (_, index) => ({ id: `probe-${index}`, title: `Search probe ${index}`, message_count: 2, last_active: Date.now() / 1000 - 59 - index }));
	mock.control.extra = []; mock.control.live = []; mock.control.metadata = { version: 1, sessions: {}, completions: {} };
	mock.host.state.focusedStoredSessionId.set('probe-0');
	controller = flow.createController(mock.ctx);
	root = createRoot(document.getElementById('app'));
	await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(flow.HermesT3Sidebar, { ctx: mock.ctx, controller }))));
	await tick(); await tick();
}
afterEach(async () => {
	if (root) await act(async () => root.unmount()); root = null;
	controller?.dispose(); controller = null; mock.reset();
});

test('unchanged polls without snoozes advance ages without reclassifying or sorting shelves', async () => {
	const realNow = Date.now, start = realNow(); let now = start;
	Date.now = () => now;
	const originalSort = Array.prototype.sort; let sorts = 0;
	try {
		await mount();
		const prefix = flow.scopeKey(flow.captureScope()), previous = mock.queryClient.getQueryData([...prefix, 'sessions']);
		Array.prototype.sort = function (...args) { if (this[0]?.section) sorts++; return originalSort.apply(this, args); };
		now += 6000;
		for (const resource of ['sessions', 'runtime', 'metadata', 'archives']) {
			await act(async () => mock.queryClient.refetchQueries({ queryKey: [...prefix, resource], exact: true })); await tick();
		}
		assert.equal(mock.queryClient.getQueryData([...prefix, 'sessions']), previous);
		assert.equal(sorts, 0, 'clock-only refreshes must not sort classified shelves');
		assert.equal(document.querySelector('[data-session-id="probe-0"] .sf-time').textContent, '1m');
		const wakeAt = now / 1000 + 60;
		await act(async () => mock.queryClient.setQueryData([...prefix, 'metadata'], { version: 1, sessions: { 'probe-0': { state: 'snoozed', pinned: false, wake_at: wakeAt } }, completions: {} })); await tick();
		assert.equal(document.querySelector('[data-session-id="probe-0"]').closest('section').dataset.section, 'snoozed');
		now += 61000;
		await act(async () => mock.queryClient.refetchQueries({ queryKey: [...prefix, 'sessions'], exact: true })); await tick();
		assert.equal(document.querySelector('[data-session-id="probe-0"]').closest('section').dataset.section, 'active', 'adding a snooze re-enables deadline-driven classification');
		assert.equal(document.querySelector('[data-session-id="probe-0"] .sf-status').textContent, 'Woke');
	} finally { Array.prototype.sort = originalSort; Date.now = realNow; }
});

test('session search reuses row text and normalizes each query once, then refreshes changed fields', async () => {
	await mount();
	const lower = String.prototype.toLowerCase, trim = String.prototype.trim;
	let corpora = 0, queryTrims = 0;
	String.prototype.toLowerCase = function () { if (String(this).includes('Search probe')) corpora++; return lower.call(this); };
	String.prototype.trim = function () { if (String(this) === 'search probe') queryTrims++; return trim.call(this); };
	try {
		await input('search probe');
		assert.equal(corpora, 120, 'prepare each searchable row only on first demand');
		assert.ok(queryTrims < 10, `query normalization must not repeat for every row: ${queryTrims}`);
		corpora = 0;
		await input('search probe 1');
		assert.equal(corpora, 0, 'another keystroke reuses the same searchable snapshot');
		assert.ok(document.querySelector('[data-session-id="probe-1"]'));
		await input('probe search');
		assert.ok(document.querySelector('[data-session-id="probe-0"]'), 'tokens use AND matching independent of order');
		assert.equal(corpora, 0);
		await input('   ');
		assert.equal(corpora, 0, 'whitespace matches without rebuilding text');
		const key = [...flow.scopeKey(flow.captureScope()), 'sessions'];
		await act(async () => mock.queryClient.setQueryData(key, previous => ({ ...previous, sessions: previous.sessions.map(row => row.id === 'probe-0' ? { ...row, title: 'Revised title', _lineage_ids: ['probe-0', 'fresh-alias'] } : row) }))); await tick();
		await input('revised fresh-alias');
		assert.ok(document.querySelector('[data-session-id="probe-0"]'), 'changed title and lineage invalidate the search corpus');
		await input('search probe 0');
		assert.equal(!!document.querySelector('[data-session-id="probe-0"]'), false, 'old text must not remain cached');
	} finally { String.prototype.toLowerCase = lower; String.prototype.trim = trim; }
});

test('toolbar renders reuse the logical visible list without stealing search focus', async () => {
	await mount();
	const original = Array.prototype.flatMap; let traversals = 0;
	Array.prototype.flatMap = function (...args) { if (this === flow.SECTIONS) traversals++; return original.apply(this, args); };
	try {
		const search = document.querySelector('[aria-label="Search sessions"]'); search.focus();
		await act(async () => button('Filter sessions').click()); await tick();
		await act(async () => button('Filter sessions').click()); await tick();
		await act(async () => button('New session').click()); await tick();
		assert.equal(traversals, 0, 'unrelated toolbar state must not flatten every logical shelf');
		assert.ok(document.activeElement === search, 'toolbar state must not move focus from search');
	} finally { Array.prototype.flatMap = original; }
});
