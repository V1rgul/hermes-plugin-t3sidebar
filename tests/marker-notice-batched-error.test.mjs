// A late marker-acknowledgment failure decides against the action error already queued, not only the one last rendered.
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
const microtasks = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const notes = () => [...document.querySelectorAll('.sf-strip li[data-error=true]')].map(node => node.textContent);
afterEach(async () => {
	if (root) { await act(async () => root.unmount()); root = null; }
	controller?.dispose(); controller = null; mock.ctx.rest = rest;
	mock.reset();
});

test('a marker failure does not replace a foreground error queued in the same render batch', async () => {
	const wokeAt = Math.floor(Date.now() / 1000) - 60;
	mock.control.metadata.sessions.design = { state: 'active', pinned: false, settled_at: null, wake_at: null, woke_at: wokeAt, updated_at: wokeAt };
	// The Woke acknowledgment's write is held until fail(); the retry that follows stays pending, so the outcome is observed once.
	let fail, attempts = 0;
	const held = new Promise((_, reject) => { fail = reject; });
	mock.ctx.rest = (path, options) => options?.body?.action !== 'ack_wake' ? rest.call(mock.ctx, path, options) : attempts++ ? new Promise(() => {}) : held;
	controller = createController(mock.ctx);
	// Signals the moment the sidebar reads the refused archive's message to queue it as the action error; the message itself is unchanged.
	let foregroundQueued;
	const queued = new Promise(resolve => { foregroundQueued = resolve; });
	const mutate = controller.mutate;
	controller.mutate = async (...args) => {
		try { return await mutate.apply(controller, args); }
		catch (error) {
			if (args[2]?.action === 'archive') {
				const message = error.message;
				Object.defineProperty(error, 'message', { get() { foregroundQueued(); return message; } });
			}
			throw error;
		}
	};
	root = createRoot(document.querySelector('#app'));
	await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(HermesT3Sidebar, { ctx: mock.ctx, controller }))));
	await tick(); await tick();
	assert.equal(attempts, 1, 'the Woke acknowledgment is in flight, holding the writer');
	await act(async () => {
		document.querySelector('[data-session-id="readme"] [aria-label="Archive session"]').click();
		await queued;
		// Still inside the same batch, before the foreground error is rendered.
		fail(new Error('fixture acknowledgment failed'));
		await microtasks();
	});
	await tick();
	assert.deepEqual(notes(), ['Another hermes-t3sidebar change is still saving.']);
});
