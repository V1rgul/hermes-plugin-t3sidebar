// Experimental settings belong to the backend of the active source and profile: reads and saves are fenced to it, and a save is confirmed by its own readback.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import plugin from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const rest = mock.ctx.rest;
let root;
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
const toggle = () => document.querySelector('section.sf-experimental [role=switch]');
const state = () => [toggle().getAttribute('aria-checked'), toggle().disabled];
const note = () => document.querySelector('section.sf-experimental [data-feature=pool_credits]')?.textContent ?? null;
let puts = 0;
async function render() {
	plugin.register(mock.ctx);
	root = createRoot(document.querySelector('#app'));
	await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, mock.control.settings.render())));
	await tick(); await tick();
}
// Holds the experimental-settings requests matching `when` until release() is called.
function hold(when) {
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	mock.ctx.rest = async (path, options) => {
		if (options?.method === 'PUT') puts++;
		if (path.startsWith('/settings/experimental') && when(path, options)) await gate;
		return rest.call(mock.ctx, path, options);
	};
	return () => act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 15)); });
}
afterEach(async () => {
	if (root) { await act(async () => root.unmount()); root = null; }
	mock.ctx.rest = rest; puts = 0;
	mock.control.disposers.forEach(dispose => dispose());
	mock.reset();
});

test('switching source shows the new backend\'s experimental settings, not the previous one\'s', async () => {
	await render();
	assert.deepEqual(state(), ['false', false]);
	mock.control.experimentalSaved = { pool_credits: true };
	await act(async () => mock.switchScope('source-b', 'other')); await tick(); await tick();
	assert.deepEqual(state(), ['true', false]);
});

test('a read answered after a source switch is not shown for the new source', async () => {
	const release = hold((path, options) => !options?.method && mock.host.state.connectionId.get() === 'source-a');
	mock.control.experimentalSaved = { pool_credits: true };
	await render();
	mock.control.experimentalSaved = { pool_credits: false };
	await act(async () => mock.switchScope('source-b', 'other')); await tick(); await tick();
	mock.control.experimentalSaved = { pool_credits: true };
	await release(); await tick();
	assert.deepEqual(state(), ['false', false], 'source-a\'s late answer must not replace source-b\'s state');
});

test('a save in flight disables its switch, so a second save cannot start', async () => {
	await render();
	const release = hold((path, options) => options?.method === 'PUT');
	await act(async () => toggle().click()); await tick();
	assert.deepEqual(state(), ['false', true], 'disabled while saving');
	await act(async () => toggle().click()); await tick();
	assert.equal(puts, 1);
	await release(); await tick();
	assert.deepEqual(state(), ['true', false]);
	assert.equal(note(), null);
});

test('a save whose readback does not hold the requested value is reported as not saved', async () => {
	await render();
	// The backend answers with its readback, but the write did not take.
	mock.ctx.rest = async (path, options) => rest.call(mock.ctx, path, options?.method === 'PUT' ? undefined : options);
	await act(async () => toggle().click()); await tick(); await tick();
	assert.equal(note(), 'The setting was not saved.');
	assert.equal(toggle().getAttribute('aria-checked'), 'false');
});

test('a save answered after a source switch neither publishes its value nor reports an error on the new source', async () => {
	await render();
	const release = hold((path, options) => options?.method === 'PUT');
	await act(async () => toggle().click()); await tick();
	await act(async () => mock.switchScope('source-b', 'other')); await tick(); await tick();
	mock.control.experimentalSaved = {};
	await release(); await tick(); await tick();
	assert.deepEqual(state(), ['false', false]);
	assert.equal(note(), null);
});

test('disposing the plugin removes the cached experimental settings', async () => {
	await render();
	assert.ok(mock.queryClient.getQueryCache().getAll().some(query => query.queryKey[0] === 'hermes-t3sidebar-settings'));
	mock.control.disposers.forEach(dispose => dispose());
	assert.equal(mock.queryClient.getQueryCache().getAll().some(query => query.queryKey[0] === 'hermes-t3sidebar-settings'), false);
});
