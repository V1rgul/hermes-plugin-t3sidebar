// The sidebar forgets an empty session's draft presence once that session is no longer an empty-session candidate.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import { createController, captureScope, scopeKey, HermesT3Sidebar } from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let root, controller;
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
const row = id => document.querySelector(`[data-session-id="${id}"]`);
// The presence set is internal state with no rendering of its own, so it is read from the mounted sidebar's hooks: the only Set held directly in its state.
function presence() {
	const container = document.querySelector('#app');
	let fiber = container[Object.keys(container).find(key => key.startsWith('__reactContainer$'))].stateNode.current;
	const pending = [fiber];
	while ((fiber = pending.pop())) {
		if (fiber.type?.name === 'ScopedSidebar') break;
		if (fiber.sibling) pending.push(fiber.sibling);
		if (fiber.child) pending.push(fiber.child);
	}
	for (let hook = fiber.memoizedState; hook; hook = hook.next) if (hook.memoizedState instanceof Set) return [...hook.memoizedState];
	throw new Error('presence state not found');
}
afterEach(async () => {
	if (root) { await act(async () => root.unmount()); root = null; }
	controller?.dispose(); controller = null;
	mock.reset();
});

test('an empty session that gains history leaves the draft presence set', async () => {
	mock.control.rows.push({ id: 'fresh', source: 'desktop', message_count: 0, cwd: '/projects/docs', project: { id: 'synthetic:/projects/docs', name: 'docs', cwd: '/projects/docs', is_home: false }, last_active: Date.now() / 1000 - 30 });
	mock.control.drafts.fresh = 'typed in its composer';
	controller = createController(mock.ctx);
	root = createRoot(document.querySelector('#app'));
	await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(HermesT3Sidebar, { ctx: mock.ctx, controller }))));
	await tick(); await tick();
	assert.equal(row('fresh') !== null, true, 'its draft keeps the empty session listed');
	assert.deepEqual(presence(), [JSON.stringify(['fresh', 'fresh'])]);
	Object.assign(mock.control.rows.find(item => item.id === 'fresh'), { message_count: 2, title: 'Now with history' });
	await act(async () => mock.queryClient.invalidateQueries({ queryKey: scopeKey(captureScope()) })); await tick(); await tick();
	assert.equal(row('fresh').querySelector('.sf-row-title').textContent, 'Now with history');
	assert.deepEqual(presence(), []);
});
