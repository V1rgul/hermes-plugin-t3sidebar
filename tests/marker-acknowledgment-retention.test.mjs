// Acknowledged Done/Woke markers are remembered only while the metadata still carries them, so the set stays bounded and a marker that returns is acknowledged again.
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
const acks = action => mock.calls.filter(call => call[0] === 'rest' && call[2]?.method === 'POST' && call[2].body?.action === action).map(call => [call[1], call[2].body]);
async function refreshMetadata() { await act(async () => mock.queryClient.invalidateQueries({ queryKey: [...scopeKey(captureScope()), 'metadata'] })); await tick(); await tick(); }
afterEach(async () => {
	if (root) { await act(async () => root.unmount()); root = null; }
	controller?.dispose(); controller = null;
	mock.reset();
});

test('a Woke or Done marker that returns after its acknowledgment is acknowledged again, exactly', async () => {
	const wokeAt = Math.floor(Date.now() / 1000) - 60;
	mock.control.metadata.sessions.design = { state: 'active', pinned: false, settled_at: null, wake_at: null, woke_at: wokeAt, updated_at: wokeAt };
	mock.control.metadata.completions = { design: { done_token: 'done-1', done_at: wokeAt } };
	controller = createController(mock.ctx);
	root = createRoot(document.querySelector('#app'));
	await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(HermesT3Sidebar, { ctx: mock.ctx, controller }))));
	await tick(); await tick(); await tick();
	assert.deepEqual(acks('ack_wake'), [['/sessions/design', { action: 'ack_wake', woke_at: wokeAt }]]);
	assert.deepEqual(acks('ack_done'), [['/sessions/design', { action: 'ack_done', done_token: 'done-1' }]]);
	await refreshMetadata();
	assert.equal(acks('ack_wake').length + acks('ack_done').length, 2, 'an acknowledged marker is not written again');
	// The same markers come back, as another client restoring them would leave them.
	mock.control.metadata.sessions.design.woke_at = wokeAt;
	mock.control.metadata.completions = { design: { done_token: 'done-1', done_at: wokeAt } };
	await refreshMetadata(); await tick();
	assert.deepEqual(acks('ack_wake').map(([, body]) => body.woke_at), [wokeAt, wokeAt]);
	assert.deepEqual(acks('ack_done').map(([, body]) => body.done_token), ['done-1', 'done-1']);
});
