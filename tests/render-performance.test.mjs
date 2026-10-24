import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import plugin, * as flow from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let root, controller;
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
const row = id => document.querySelector(`[data-session-id="${id}"]`);
const button = name => [...document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === name || node.textContent === name);
async function click(node) { assert.ok(node); await act(async () => node.click()); await tick(); }
async function input(node, value) {
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
  await tick();
}
async function mount() {
  controller = flow.createController(mock.ctx);
  root = createRoot(document.querySelector('#app'));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(flow.HermesT3Sidebar, { ctx: mock.ctx, controller }))));
  await tick(); await tick();
}
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; }
  controller?.dispose(); controller = null;
  mock.control.disposers.forEach(dispose => dispose()); mock.reset();
});

test('toolbar/search retain cards; folding and focus only render affected cards and preserve local menu state', async () => {
  await mount();
  const descriptor = Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype, 'format');
  let formatted = 0;
  Object.defineProperty(Intl.NumberFormat.prototype, 'format', { ...descriptor, get() {
    const format = descriptor.get.call(this);
    return value => { formatted++; return format(value); };
  } });
  try {
    await click(button('Filter sessions'));
    assert.equal(formatted, 0, 'opening toolbar must not render any card');
    await click(button('Filter sessions'));
    await input(document.querySelector('input[type=search]'), ' ');
    assert.equal(formatted, 0, 'a matching search retains card identities');
    await click(button('Working (1)'));
    assert.equal(formatted, 1, 'fold only updates Working visibility');
    await click(button('Working (1)'));
    assert.equal(formatted, 2, 'unfold retains mounted cards');
    formatted = 0;
    await act(async () => mock.host.state.focusedStoredSessionId.set('readme')); await tick();
    assert.ok(formatted <= 4, `only two focus cards plus their draft observers may render, got ${formatted}`);
    assert.equal(row('readme').dataset.current, 'true');
    assert.equal(row('design').dataset.current, 'false');
    await act(async () => row('design').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))); await tick();
    await click(button('Filter sessions'));
    assert.ok(document.querySelector('[role=dialog][aria-label="Session actions"]'), 'card-local menu remains open across unrelated toolbar state');
    const before = formatted;
    await input(document.querySelector('input[type=search]'), 'Sidebar');
    assert.equal(formatted, before, 'retained matching card does not render or lose menu state');
    assert.ok(document.querySelector('[role=dialog][aria-label="Session actions"]'));
  } finally { Object.defineProperty(Intl.NumberFormat.prototype, 'format', descriptor); }
});

test('memoized cards refresh title/provider/project/tokens and retain exact open-tip handler inputs', async () => {
  await mount();
  const key = [...flow.scopeKey(flow.captureScope()), 'sessions'];
  await act(async () => mock.queryClient.setQueryData(key, previous => ({ ...previous, sessions: previous.sessions.map(item => item.id === 'design'
    ? { ...item, title: 'Changed title', resolved_id: 'new-tip', _lineage_ids: ['design', 'new-tip'], provider: 'anthropic', total_tokens: 4500, project: { name: 'Changed project', icon: 'tools' } }
    : item) })));
  await tick();
  assert.equal(row('design').querySelector('.sf-row-title').textContent, 'Changed title');
  assert.equal(row('design').querySelector('.sf-project-name').textContent, 'Changed project');
  assert.equal(row('design').querySelector('.sf-provider').getAttribute('aria-label'), 'Provider: anthropic');
  assert.equal(row('design').querySelector('.sf-token').textContent, '5K');
  await click(row('design').querySelector('.sf-open'));
  assert.equal(mock.calls.filter(call => call[0] === 'open').at(-1)[1], 'new-tip', 'memo equality must not preserve a stale handler row');
});

test('successful structurally-shared poll advances age and due snooze without a new timer', async () => {
  const realNow = Date.now, start = realNow();
  let now = start;
  Date.now = () => now;
  try {
    mock.control.rows.find(item => item.id === 'design').last_active = (start - 59_000) / 1000;
    await mount();
    const key = [...flow.scopeKey(flow.captureScope()), 'sessions'];
    const previousData = mock.queryClient.getQueryData(key);
    assert.equal(row('design').querySelector('.sf-time').textContent, 'now');
    assert.equal(row('snoozed').querySelector('.sf-snooze-time').textContent, '1h');
    now += 6_000;
    await act(async () => mock.queryClient.refetchQueries({ queryKey: key, exact: true })); await tick();
    assert.equal(mock.queryClient.getQueryData(key), previousData, 'the age test must exercise structural sharing');
    assert.equal(row('design').querySelector('.sf-time').textContent, '1m');
    now = start + 61_000;
    await act(async () => mock.queryClient.refetchQueries({ queryKey: key, exact: true })); await tick();
    assert.equal(mock.queryClient.getQueryData(key), previousData);
    assert.equal(row('snoozed').querySelector('.sf-snooze-time').textContent, '59m', 'existing structurally-shared polls advance the countdown');
    const deadline = mock.control.metadata.sessions.snoozed.wake_at;
    now = deadline * 1000 + 1;
    await act(async () => mock.queryClient.refetchQueries({ queryKey: key, exact: true })); await tick();
    assert.equal(row('snoozed').closest('section').dataset.section, 'active', 'clock-dependent classification updates on the existing successful poll');
    assert.equal(row('snoozed').querySelector('.sf-status').textContent, 'Woke');
  } finally { Date.now = realNow; }
});

test('open snooze menu precise minutes update even when rounded card duration stays unchanged', async () => {
  const realNow = Date.now, start = realNow();
  let now = start;
  Date.now = () => now;
  try {
    const deadline = start / 1000 + 2 * 86400 + 16 * 3600 + 12 * 60;
    mock.control.metadata.sessions.snoozed.wake_at = deadline;
    await mount();
    await click(row('snoozed').querySelector('[aria-label="Snooze session"]'));
    const key = [...flow.scopeKey(flow.captureScope()), 'sessions'], previousData = mock.queryClient.getQueryData(key);
    const info = () => document.querySelector('.sf-snooze-info');
    assert.equal(row('snoozed').querySelector('.sf-time').textContent, '3d');
    assert.equal(info().textContent, '2d 16h 12min left');
    now += 61_000;
    await act(async () => mock.queryClient.refetchQueries({ queryKey: key, exact: true })); await tick();
    assert.equal(mock.queryClient.getQueryData(key), previousData);
    assert.equal(row('snoozed').querySelector('.sf-time').textContent, '3d');
    assert.equal(info().textContent, '2d 16h 11min left');
    assert.equal(mock.control.metadata.sessions.snoozed.wake_at, deadline);
  } finally { Date.now = realNow; }
});

function denseHistory(archives = 500) {
	mock.control.rows = Array.from({ length: 500 + archives }, (_, index) => ({ id: `dense-${index}`, title: `Dense conversation ${index}`, archived: index >= 500, last_active: Date.now() / 1000 - index, total_tokens: 12345 }));
	mock.control.extra = []; mock.control.live = []; mock.control.metadata = { version: 1, sessions: {} };
	mock.host.state.focusedStoredSessionId.set('dense-0');
}

test('observed viewport height avoids geometry reads on scroll and keyboard navigation', async () => {
	const previousObserver = globalThis.ResizeObserver;
	const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
	const observers = [];
	let reads = 0;
	globalThis.ResizeObserver = class {
		constructor(callback) { this.callback = callback; observers.push(this); }
		observe(target) { this.target = target; }
		disconnect() { this.disconnected = true; }
	};
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { reads++; return 112; } });
	try {
		denseHistory(); await mount();
		const section = document.querySelector('[data-section=active]'), body = section.querySelector('.sf-section-body');
		const observer = observers.find(observer => observer.target === body);
		assert.ok(observer, 'observe the actual viewport, not the full-height spacer');
		const resize = async height => { await act(async () => observer.callback([{ target: body, contentRect: { height } }])); await tick(); };
		await resize(112);
		assert.equal(section.querySelectorAll('.sf-row').length, 5, 'two viewport rows plus lower overscan at the top');
		reads = 0;
		for (const top of [560, 1120, 1680]) {
			await act(async () => { body.scrollTop = top; body.dispatchEvent(new Event('scroll')); }); await tick();
		}
		assert.ok(row('dense-30'), 'scrolling still moves the mounted window');
		const card = row('dense-30').querySelector('.sf-open');
		await act(async () => { card.focus(); card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); }); await tick();
		assert.equal(document.activeElement.closest('[data-session-id]')?.dataset.sessionId, 'dense-31');
		assert.equal(reads, 0, 'observed viewport height must be reused by scroll and reveal');
		await act(async () => { document.activeElement.blur(); body.scrollTop = 0; body.dispatchEvent(new Event('scroll')); }); await tick();
		await resize(336);
		assert.equal(section.querySelectorAll('.sf-row').length, 9, 'ResizeObserver updates the visible range without a clientHeight read');
		await resize(0);
		assert.equal(section.querySelectorAll('.sf-row').length, 9, 'a collapsed viewport preserves its last positive window height');
		await act(async () => { const first = row('dense-0').querySelector('.sf-open'); first.focus(); first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); }); await tick();
		assert.equal(body.scrollTop, 0, 'navigation during an observer zero-height interval reuses the last positive height');
		assert.equal(reads, 0);
		await act(async () => root.unmount()); root = null;
		assert.ok(observers.every(observer => observer.disconnected), 'unmount disconnects all observers');
	} finally {
		if (descriptor) Object.defineProperty(HTMLElement.prototype, 'clientHeight', descriptor);
		else delete HTMLElement.prototype.clientHeight;
		if (previousObserver === undefined) delete globalThis.ResizeObserver;
		else globalThis.ResizeObserver = previousObserver;
	}
});

test('clients without ResizeObserver retain measured scrolling and resize fallback', async () => {
	const previousObserver = globalThis.ResizeObserver;
	const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
	let height = 112, reads = 0;
	delete globalThis.ResizeObserver;
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { reads++; return height; } });
	try {
		denseHistory(); await mount();
		const section = document.querySelector('[data-section=active]'), body = section.querySelector('.sf-section-body');
		assert.equal(section.querySelectorAll('.sf-row').length, 5);
		height = 336; reads = 0;
		await act(async () => body.dispatchEvent(new Event('scroll'))); await tick();
		assert.equal(section.querySelectorAll('.sf-row').length, 9);
		assert.ok(reads > 0, 'older clients still measure instead of freezing a stale height');
	} finally {
		if (descriptor) Object.defineProperty(HTMLElement.prototype, 'clientHeight', descriptor);
		else delete HTMLElement.prototype.clientHeight;
		if (previousObserver !== undefined) globalThis.ResizeObserver = previousObserver;
	}
});

test('500-row shelves bound mounted cards, fold renders and fresh draft reads to the viewport', async () => {
	denseHistory(); await mount(); await click(button('Browse older archives'));
	assert.ok(document.querySelectorAll('.sf-row').length < 80, 'history size must not become mounted card count');
	const descriptor = Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype, 'format');
	let formatted = 0;
	Object.defineProperty(Intl.NumberFormat.prototype, 'format', { ...descriptor, get() {
		const format = descriptor.get.call(this); return value => { formatted++; return format(value); };
	} });
	try {
		await click(button('Archived (500)'));
		assert.ok(formatted < 80, `close renders are bounded, got ${formatted}`);
		formatted = 0; const start = mock.calls.length;
		await click(button('Archived (500)'));
		assert.ok(formatted < 80, `reopen renders are bounded, got ${formatted}`);
		const reads = mock.calls.slice(start).filter(call => call[0] === 'getDraft').length;
		assert.ok(reads > 0 && reads < 80, `visible archived drafts must be fresh without 500 reads, got ${reads}`);
		await input(document.querySelector('input[type=search]'), 'Dense conversation 999');
		assert.ok(row('dense-999'));
		await input(document.querySelector('input[type=search]'), '');
		assert.ok(document.querySelectorAll('.sf-row').length < 80, 'clearing search must not remount history');
	} finally { Object.defineProperty(Intl.NumberFormat.prototype, 'format', descriptor); }
});

test('windowed keyboard navigation reaches unmounted rows; search retains menus and never unfolds Archives', async () => {
	denseHistory(); await mount(); await click(button('Browse older archives'));
	const first = row('dense-0').querySelector('.sf-open');
	await act(async () => { first.focus(); first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); }); await tick();
	assert.equal(document.activeElement.closest('[data-session-id]')?.dataset.sessionId, 'dense-999');
	await act(async () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))); await tick();
	assert.equal(document.activeElement.closest('[data-session-id]')?.dataset.sessionId, 'dense-0');
	await act(async () => row('dense-0').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))); await tick();
	await input(document.querySelector('input[type=search]'), 'Dense conversation 0');
	assert.ok(document.querySelector('[role=dialog][aria-label="Session actions"]'), 'matching card menu survives changing from a window to a small result');
	await input(document.querySelector('input[type=search]'), '');
	await click(button('Archived (500)'));
	await input(document.querySelector('input[type=search]'), 'Dense conversation 999');
	assert.equal(document.querySelector('[data-section=archived]').dataset.closed, 'true');
});

function observeResources(scope = flow.captureScope()) {
  const reads = {}, unsubscribers = [];
  for (const resource of ['sessions', 'runtime', 'metadata', 'archives', 'expanded', 'page', 'projects', 'draft']) {
    const queryKey = resource === 'draft' ? ['hermes-t3sidebar-drafts', scope.connectionId, scope.profile, scope.epoch, 'design'] : [...flow.scopeKey(scope), resource];
    reads[resource] = 0;
    mock.queryClient.setQueryData(queryKey, { resource });
    const observer = new QueryObserver(mock.queryClient, { queryKey, staleTime: Infinity, gcTime: Infinity,
      queryFn: async () => { reads[resource]++; return { resource }; } });
    unsubscribers.push(observer.subscribe(() => {}));
  }
  return { reads, stop: () => unsubscribers.forEach(unsubscribe => unsubscribe()) };
}

test('token/delta events do zero reads; a 20-event runtime/input/subagent burst reads runtime once only', async () => {
  plugin.register(mock.ctx);
  const resources = observeResources();
  try {
    for (let index = 0; index < 20; index++) for (const type of ['message.delta', 'thinking.delta', 'session.usage', 'session.delta', 'subagent.text', 'subagent.thinking']) mock.control.listener({ type });
    await tick();
    assert.deepEqual(Object.values(resources.reads), Array(8).fill(0));
    mock.control.listener({ type: 'message.complete', connectionId: 'foreign-source', profile: 'default' });
    mock.control.listener({ type: 'message.complete', connectionId: 'source-a', profile: 'foreign-profile' });
    await tick();
    assert.deepEqual(Object.values(resources.reads), Array(8).fill(0), 'explicitly foreign events are inert');
    const types = ['session.updated', 'session.info', 'message.start', 'approval.request', 'question.request', 'server_request.resolved', 'subagent.start', 'subagent.complete'];
    for (let index = 0; index < 20; index++) mock.control.listener({ type: types[index % types.length] });
    await tick();
    assert.deepEqual(resources.reads, { sessions: 0, runtime: 1, metadata: 0, archives: 0, expanded: 0, page: 0, projects: 0, draft: 0 });
  } finally { resources.stop(); }
});

test('separate lifecycle bursts reuse an in-flight runtime request rather than cancelling and restarting it', async () => {
  plugin.register(mock.ctx);
  const queryKey = [...flow.scopeKey(flow.captureScope()), 'runtime'];
  mock.queryClient.setQueryData(queryKey, { sessions: [] });
  let release, reads = 0, aborts = 0;
  const observer = new QueryObserver(mock.queryClient, { queryKey, staleTime: Infinity, gcTime: Infinity,
    queryFn: ({ signal }) => { reads++; signal.addEventListener('abort', () => aborts++); return new Promise(resolve => { release = resolve; }); } });
  const unsubscribe = observer.subscribe(() => {});
  try {
    for (let burst = 0; burst < 3; burst++) {
      for (let event = 0; event < 20; event++) mock.control.listener({ type: 'subagent.complete' });
      await tick();
    }
    assert.equal(reads, 1); assert.equal(aborts, 0);
    release({ sessions: [] }); await tick();
    mock.control.listener({ type: 'subagent.start' }); await tick();
    assert.equal(reads, 2, 'a settled request is not a permanent event cache');
    release({ sessions: [] }); await tick();
  } finally { unsubscribe(); }
});

test('storage/title/archive/delete/completion events refresh rich history/pages but never projects or drafts', async () => {
  plugin.register(mock.ctx);
  const resources = observeResources();
  try {
    for (const event of [{ type: 'sessions.changed' }, { type: 'session.title' }, { type: 'session.archived' }, { type: 'session.deleted' }, { type: 'message.complete' }, { type: 'session.updated', payload: { operation: 'workspace' } }]) {
      for (const key of Object.keys(resources.reads)) resources.reads[key] = 0;
      mock.control.listener({ type: 'subagent.complete' });
      mock.control.listener(event);
      await tick();
      assert.deepEqual(resources.reads, { sessions: 1, runtime: 1, metadata: 1, archives: 1, expanded: 1, page: 1, projects: 0, draft: 0 }, event.type);
    }
  } finally { resources.stop(); }
});

test('scope change, ABA activation epoch and disposal cancel pending event invalidation', async () => {
  plugin.register(mock.ctx);
  const first = flow.captureScope(), resources = observeResources(first);
  try {
    mock.control.listener({ type: 'session.title' });
    mock.switchScope('source-b');
    await tick();
    assert.deepEqual(Object.values(resources.reads), Array(8).fill(0));
    mock.switchScope('source-a');
    const current = observeResources();
    try {
      mock.control.listener({ type: 'subagent.start' });
      await tick();
      assert.equal(current.reads.runtime, 1);
      assert.equal(resources.reads.runtime, 0, 'same source/profile at an old epoch is untouched');
      const listener = mock.control.listener;
      listener({ type: 'session.title' });
      mock.control.disposers.forEach(dispose => dispose());
      await tick();
      assert.equal(current.reads.sessions, 0, 'queued work cannot re-fetch after disposal');
      listener({ type: 'session.title' }); await tick();
      assert.equal(current.reads.sessions, 0, 'a retained obsolete event callback is inert');
    } finally { current.stop(); }
  } finally { resources.stop(); }
});
