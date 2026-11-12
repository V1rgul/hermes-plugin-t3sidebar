// A marker acknowledgment that fails late reports only for the thread still shown, and never replaces a foreground action error.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import { createController, HermesT3Sidebar } from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const rest = mock.ctx.rest;
let root, controller;
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
const notes = () => [...document.querySelectorAll('.sf-note[role=alert]')].map(node => node.textContent);
// Holds the Woke acknowledgment's write until fail() rejects it; the retry that follows stays pending, so the outcome is observed once.
async function mountWithHeldAck() {
	const wokeAt = Math.floor(Date.now() / 1000) - 60;
	mock.control.metadata.sessions.design = { state: 'active', pinned: false, settled_at: null, wake_at: null, woke_at: wokeAt, updated_at: wokeAt };
	let fail, attempts = 0;
	const held = new Promise((_, reject) => { fail = reject; });
	mock.ctx.rest = (path, options) => options?.body?.action !== 'ack_wake' ? rest.call(mock.ctx, path, options) : attempts++ ? new Promise(() => {}) : held;
	controller = createController(mock.ctx);
	root = createRoot(document.querySelector('#app'));
	await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(HermesT3Sidebar, { ctx: mock.ctx, controller }))));
	await tick(); await tick();
	return async () => { await act(async () => { fail(new Error('fixture acknowledgment failed')); }); await tick(); };
}
afterEach(async () => {
	if (root) { await act(async () => root.unmount()); root = null; }
	controller?.dispose(); controller = null; mock.ctx.rest = rest;
	mock.reset();
});

test('a late failure for a thread no longer shown publishes no notice', async () => {
	const fail = await mountWithHeldAck();
	await act(async () => mock.host.state.focusedStoredSessionId.set('readme')); await tick();
	await fail();
	assert.deepEqual(notes().filter(text => /marker could not be acknowledged/.test(text)), []);
});

test('a late failure does not replace a foreground action error', async () => {
	const fail = await mountWithHeldAck();
	await act(async () => document.querySelector('[data-session-id="readme"] [aria-label="Archive session"]').click()); await tick();
	assert.deepEqual(notes(), ['Another hermes-t3sidebar change is still saving.']);
	await fail();
	assert.deepEqual(notes(), ['Another hermes-t3sidebar change is still saving.']);
});

test('a failure for the thread still shown is reported', async () => {
	const fail = await mountWithHeldAck();
	await fail();
	assert.deepEqual(notes(), ['Thread opened, but its Woke marker could not be acknowledged: fixture acknowledgment failed']);
});
