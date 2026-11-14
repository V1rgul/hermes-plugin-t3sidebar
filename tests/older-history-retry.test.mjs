// A failed first "Browse older sessions" request leaves the button in place, so the pane itself can retry.
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
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const browse = () => [...document.querySelectorAll('button')].find(node => node.textContent === 'Browse older sessions');
const row = id => document.querySelector(`[data-session-id="${id}"]`);
afterEach(async () => {
	if (root) { await act(async () => root.unmount()); root = null; }
	controller?.dispose(); controller = null; mock.ctx.rest = rest;
	mock.reset();
});

test('the older-sessions button stays usable after its first request fails, and a retry loads the page', async () => {
	mock.control.rows = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, title: `Recent ${i}` }));
	mock.control.extra = [{ id: 'older', title: 'Older session', cwd: '/older' }];
	let failing = true;
	mock.ctx.rest = async (path, options) => {
		if (failing && path === '/sessions?offset=500&limit=500') throw new Error('fixture older page unavailable');
		return rest.call(mock.ctx, path, options);
	};
	controller = createController(mock.ctx);
	root = createRoot(document.querySelector('#app'));
	await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(HermesT3Sidebar, { ctx: mock.ctx, controller }))));
	await tick(); await tick();
	await act(async () => browse().click()); await tick(); await tick();
	assert.match(document.body.textContent, /Older sessions could not load: fixture older page unavailable/);
	assert.equal(browse() !== undefined, true, 'the button remains after the failed first expansion');
	assert.equal(browse().disabled, false);
	failing = false;
	await act(async () => browse().click()); await tick(); await tick();
	assert.equal(row('older') !== null, true);
	assert.equal(browse() === undefined, true, 'no older page remains');
});
