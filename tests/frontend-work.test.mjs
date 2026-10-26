// Synthetic fixtures measure deterministic work in the shipped React components, not latency.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, Profiler } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import * as flow from '../desktop/plugin.js?performance-test';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const h = React.createElement;
let root, controller;
const tick = async () => act(async () => new Promise(resolve => setTimeout(resolve, 15)));
async function render(tree) {
	root ||= createRoot(document.getElementById('app'));
	await act(async () => root.render(tree));
}
afterEach(async () => {
	if (root) await act(async () => root.unmount()); root = null;
	controller?.dispose(); controller = null; mock.reset();
});

function observeViewport(t) {
	const previous = globalThis.ResizeObserver, observers = [];
	globalThis.ResizeObserver = class {
		constructor(callback) { this.callback = callback; observers.push(this); }
		observe(target) { (this.targets ||= []).push(target); }
		disconnect() { this.disconnected = true; }
	};
	t.after(() => { if (previous === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = previous; });
	return async (body, height) => {
		const observer = observers.find(observer => observer.targets.includes(body));
		assert.ok(observer);
		await act(async () => observer.callback([{ target: body, contentRect: { height } }]));
	};
}
function windowFixture() {
	const navigators = { current: new Map() }, rowRefs = { current: new Map() };
	let keyReads = 0, renders = 0;
	const entries = Array.from({ length: 500 }, (_, index) => ({ get key() { keyReads++; return `window-${index}`; } }));
	const tree = rows => h('div', { className: 'sf-section-body' }, h(flow.SessionWindow, {
		entries: rows, section: 'active', navigators, rowRefs,
		renderRow(row) {
			renders++;
			return h('button', { 'data-session-id': row.key, ref: node => { if (node) rowRefs.current.set(row.key, node); else rowRefs.current.delete(row.key); } }, row.key);
		}
	}));
	return { entries, tree, navigators, reset() { keyReads = 0; renders = 0; }, get keyReads() { return keyReads; }, get renders() { return renders; } };
}

test('window scrolling keeps layout-effect bookkeeping bounded to mounted rows', async t => {
	const resize = observeViewport(t), fixture = windowFixture();
	await render(fixture.tree(fixture.entries));
	const body = document.querySelector('.sf-section-body');
	await resize(body, 112);
	fixture.reset();
	await act(async () => { body.scrollTop = 56 * 30; body.dispatchEvent(new Event('scroll')); });
	assert.ok(document.querySelector('[data-session-id="window-30"]'));
	assert.ok(fixture.renders <= 8, `only the viewport and overscan render: ${fixture.renders}`);
	assert.ok(fixture.keyReads < 100, `scroll must not revisit 500 logical keys: ${fixture.keyReads}`);
});

test('small-list resizes and scrolling update caches/fades without rendering unused viewport state', async t => {
	const resize = observeViewport(t), fixture = windowFixture(), entries = fixture.entries.slice(0, 4);
	await render(fixture.tree(entries));
	const body = document.querySelector('.sf-section-body');
	Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 500 });
	await resize(body, 112);
	fixture.reset();
	for (const height of [100, 90, 80, 70]) await resize(body, height);
	await act(async () => { body.scrollTop = 56; body.dispatchEvent(new Event('scroll')); });
	assert.equal(body.dataset.moreBelow, 'true');
	await act(async () => { body.scrollTop = 500; body.dispatchEvent(new Event('scroll')); });
	assert.equal(body.dataset.moreBelow, 'false');
	assert.equal(fixture.renders, 0, 'non-windowed lists must not render for viewport-only changes');
});

test('small-list keyboard reveal consumes focus immediately without stealing later input focus', async t => {
	const resize = observeViewport(t);
	mock.control.rows = Array.from({ length: 6 }, (_, index) => ({ id: `focus-${index}`, title: `Focus probe ${index}`, message_count: 2, last_active: 100 - index }));
	mock.control.extra = []; mock.control.live = []; mock.control.metadata = { version: 1, sessions: {} };
	mock.host.state.focusedStoredSessionId.set(null);
	controller = flow.createController(mock.ctx);
	await render(h(QueryClientProvider, { client: mock.queryClient }, h(React.Fragment, null,
		h(flow.HermesT3Sidebar, { ctx: mock.ctx, controller }), h('textarea', { 'aria-label': 'Composer probe' }))));
	await tick(); await tick();
	const body = document.querySelector('[data-section=active] .sf-section-body');
	await resize(body, 112);
	const keyDown = async (card, key) => act(async () => card.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
	for (const [id, key, scrollTop, inputLabel] of [
		['focus-5', 'End', 0, 'Search sessions'],
		['focus-5', 'ArrowDown', 0, 'Composer probe'],
		['focus-0', 'Home', 224, 'Search sessions'],
		['focus-0', 'ArrowUp', 224, 'Composer probe'],
		['focus-0', 'Home', 0, 'Search sessions']
	]) {
		const card = document.querySelector(`[data-session-id="${id}"] .sf-open`);
		await act(async () => card.focus());
		await act(async () => { body.scrollTop = scrollTop; body.dispatchEvent(new Event('scroll')); });
		await keyDown(card, key);
		assert.equal(body.scrollTop, id === 'focus-5' ? 224 : 0, `${key} reveals the already-focused boundary card`);
		const input = document.querySelector(`[aria-label="${inputLabel}"]`);
		await act(async () => input.focus());
		assert.ok(document.activeElement === input, `${key} must not leave pending focus that steals ${inputLabel}`);
	}
});

test('crossing the window threshold synchronizes cached scroll and last-positive viewport height', async t => {
	const resize = observeViewport(t), fixture = windowFixture(), small = fixture.entries.slice(0, 80), large = fixture.entries.slice(0, 81);
	await render(fixture.tree(small));
	const body = document.querySelector('.sf-section-body');
	await resize(body, 112);
	await act(async () => { body.scrollTop = 56 * 30; body.dispatchEvent(new Event('scroll')); });
	await resize(body, 0);
	await render(fixture.tree(large));
	assert.equal(document.querySelectorAll('[data-session-id]').length, 8);
	assert.ok(document.querySelector('[data-session-id="window-30"]'));
	await act(async () => fixture.navigators.current.get('active')('window-80'));
	assert.equal(document.activeElement.dataset.sessionId, 'window-80');
	await act(async () => document.activeElement.blur());
	await render(fixture.tree(small));
	assert.equal(document.querySelectorAll('[data-session-id]').length, 80);
	await act(async () => { body.scrollTop = 0; body.dispatchEvent(new Event('scroll')); });
	await resize(body, 224);
	await render(fixture.tree(large));
	assert.equal(document.querySelectorAll('[data-session-id]').length, 7);
	assert.ok(document.querySelector('[data-session-id="window-0"]'));
});

test('snooze clock-only polls retain classification/search until deadlines cross in either direction', async () => {
	const realNow = Date.now, start = Math.floor(realNow() / 1000) * 1000; let now = start;
	const originalSort = Array.prototype.sort, lower = String.prototype.toLowerCase;
	let sorts = 0, corpora = 0;
	Date.now = () => now;
	try {
		mock.control.rows = Array.from({ length: 120 }, (_, index) => ({ id: `deadline-${index}`, title: `Deadline probe ${index}`, message_count: 2, last_active: start / 1000 - 59 - index }));
		mock.control.extra = []; mock.control.live = [];
		mock.control.metadata = { version: 1, sessions: {
			'deadline-1': { state: 'snoozed', pinned: false, wake_at: start / 1000 + 60 },
			'deadline-2': { state: 'snoozed', pinned: false, wake_at: start / 1000 + 120 }
		} };
		mock.host.state.focusedStoredSessionId.set('deadline-0');
		controller = flow.createController(mock.ctx);
		await render(h(QueryClientProvider, { client: mock.queryClient }, h(flow.HermesT3Sidebar, { ctx: mock.ctx, controller })));
		await tick(); await tick();
		const input = document.querySelector('[aria-label="Search sessions"]');
		await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'deadline probe'); input.dispatchEvent(new Event('input', { bubbles: true })); });
		await tick();
		const prefix = flow.scopeKey(flow.captureScope()), previous = mock.queryClient.getQueryData([...prefix, 'sessions']);
		Array.prototype.sort = function (...args) { if (this[0]?.section) sorts++; return originalSort.apply(this, args); };
		String.prototype.toLowerCase = function () { if (String(this).includes('Deadline probe')) corpora++; return lower.call(this); };
		const poll = async (seconds, resource = 'sessions') => {
			now = start + seconds * 1000;
			await act(async () => mock.queryClient.refetchQueries({ queryKey: [...prefix, resource], exact: true })); await tick();
		};
		for (const [index, resource] of ['sessions', 'runtime', 'metadata', 'archives'].entries()) await poll(10 + index, resource);
		assert.equal(mock.queryClient.getQueryData([...prefix, 'sessions']), previous);
		assert.equal(sorts, 0, 'future snoozes must not cause clock-only shelf sorts');
		assert.equal(corpora, 0, 'future snoozes must not discard cached search text');
		assert.equal(document.querySelector('[data-session-id="deadline-0"] .sf-time').textContent, '1m');
		const section = id => document.querySelector(`[data-session-id="deadline-${id}"]`).closest('section').dataset.section;
		await poll(60);
		assert.equal(section(1), 'active', 'the exact first deadline wakes');
		assert.equal(section(2), 'snoozed');
		assert.equal(document.querySelector('[data-session-id="deadline-1"] .sf-status').textContent, 'Woke');
		assert.ok(sorts > 0);
		sorts = 0; corpora = 0;
		await poll(75);
		assert.equal(sorts, 0); assert.equal(corpora, 0);
		await poll(30);
		assert.equal(section(1), 'snoozed', 'a backwards clock re-evaluates unmaterialized deadlines');
		await poll(180);
		assert.equal(section(1), 'active'); assert.equal(section(2), 'active', 'a clock jump crosses every due deadline');
		sorts = 0; corpora = 0;
		await poll(240);
		assert.equal(sorts, 0, 'already-due snoozes do not rebuild on every later poll'); assert.equal(corpora, 0);
	} finally { Array.prototype.sort = originalSort; String.prototype.toLowerCase = lower; Date.now = realNow; }
});

function timerFixture(t, initialNow) {
	const realNow = Date.now, interval = globalThis.setInterval, clear = globalThis.clearInterval;
	const timers = new Map(); let now = initialNow;
	Date.now = () => now;
	globalThis.setInterval = (callback, delay, ...args) => {
		if (delay !== 1000) return interval(callback, delay, ...args);
		const token = { unref() {} }; timers.set(token, callback); return token;
	};
	globalThis.clearInterval = token => { if (!timers.delete(token)) clear(token); };
	t.after(() => { Date.now = realNow; globalThis.setInterval = interval; globalThis.clearInterval = clear; });
	return { timers, async advance(milliseconds) { now += milliseconds; await act(async () => { for (const callback of timers.values()) callback(); }); } };
}

test('Working labels skip unchanged minutes, unsubscribe while hidden and refresh before reopening', async t => {
	const start = Date.now(), clock = timerFixture(t, start);
	let commits = 0;
	const tree = hidden => h(Profiler, { id: 'duration', onRender: () => commits++ }, h(flow.WorkingDuration, { startedAt: (start - 65_000) / 1000, hidden }));
	await render(tree(false));
	assert.equal(document.querySelector('.sf-working-duration').textContent, '1m');
	assert.equal(clock.timers.size, 1); commits = 0;
	await clock.advance(1000);
	assert.equal(commits, 0, 'an unchanged minute must not commit a render');
	await clock.advance(54_000);
	assert.equal(document.querySelector('.sf-working-duration').textContent, '2m');
	assert.equal(commits, 1);
	await render(tree(true));
	assert.equal(clock.timers.size, 0, 'folding the last timer stops the shared interval');
	commits = 0;
	await clock.advance(60_000);
	assert.equal(commits, 0);
	await render(tree(false));
	assert.equal(document.querySelector('.sf-working-duration').textContent, '3m');
	assert.equal(clock.timers.size, 1);
	await act(async () => root.unmount()); root = null;
	assert.equal(clock.timers.size, 0);
});

test('Working labels keep one shared timer, second/minute/hour boundaries and changed starts fresh', async t => {
	const start = Date.now(), clock = timerFixture(t, start);
	const tree = (startedAt, hidden = false) => h(React.Fragment, null,
		h(flow.WorkingDuration, { key: 'first', startedAt, hidden }),
		h(flow.WorkingDuration, { key: 'second', startedAt: start / 1000 }));
	const label = () => document.querySelector('.sf-working-duration').textContent;
	await render(tree((start - 59_000) / 1000));
	assert.equal(clock.timers.size, 1);
	assert.equal(label(), '59s');
	await clock.advance(1000); assert.equal(label(), '1m');
	await clock.advance(3540_000); assert.equal(label(), '1h 0m');
	await render(tree((start + 3541_000) / 1000));
	assert.equal(label(), '0s', 'changing the run refreshes without waiting for a tick');
	await clock.advance(1000); assert.equal(label(), '1s');
	await render(tree(start / 1000, true));
	assert.equal(clock.timers.size, 1, 'another visible label keeps the shared interval alive');
	await act(async () => root.unmount()); root = null;
	assert.equal(clock.timers.size, 0);
});

test('folded Working and running Snoozed cards both suspend their duration subscriptions', async t => {
	const start = Date.now(), clock = timerFixture(t, start);
	mock.control.rows = ['plain', 'snoozed'].map(id => ({ id, title: `Working ${id}`, message_count: 2 }));
	mock.control.extra = [];
	mock.control.live = ['plain', 'snoozed'].map(id => ({ id: `runtime-${id}`, session_key: id, status: 'working', turn_started_at: start / 1000 - 10 }));
	mock.control.metadata = { version: 1, sessions: { snoozed: { state: 'snoozed', pinned: false, wake_at: start / 1000 + 3600 } } };
	mock.host.state.focusedStoredSessionId.set(null);
	controller = flow.createController(mock.ctx);
	await render(h(QueryClientProvider, { client: mock.queryClient }, h(flow.HermesT3Sidebar, { ctx: mock.ctx, controller })));
	await tick(); await tick();
	const toggle = async name => {
		const button = document.querySelector(`[aria-label="${name} (1)"]`);
		assert.ok(button); await act(async () => button.click());
	};
	assert.equal(document.querySelectorAll('.sf-working-duration').length, 2);
	await toggle('Working'); assert.equal(clock.timers.size, 1);
	await toggle('Snoozed'); assert.equal(clock.timers.size, 0);
	await clock.advance(5000);
	await toggle('Snoozed');
	assert.equal(clock.timers.size, 1);
	assert.equal(document.querySelector('[data-session-id="snoozed"] .sf-working-duration').textContent, '15s');
	await toggle('Working');
	assert.equal(document.querySelector('[data-session-id="plain"] .sf-working-duration').textContent, '15s');
});
