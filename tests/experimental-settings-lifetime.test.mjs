// An experimental save belongs to the plugin registration, not to the settings page that started it: a remounted page sees it still running, and a disposed plugin never publishes it.
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
const settingsQueries = () => mock.queryClient.getQueryCache().getAll().filter(query => query.queryKey[0] === 'hermes-t3sidebar-settings');
async function mount() {
	root = createRoot(document.querySelector('#app'));
	await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, mock.control.settings.render())));
	await tick(); await tick();
}
async function unmount() { await act(async () => root.unmount()); root = null; }
// The backend applies each PUT at once; the first PUT's readback is then held until release().
function holdFirstSave() {
	let release, puts = 0;
	const gate = new Promise(resolve => { release = resolve; });
	mock.ctx.rest = async (path, options) => {
		const value = await rest.call(mock.ctx, path, options);
		if (options?.method === 'PUT' && ++puts === 1) await gate;
		return value;
	};
	return { puts: () => puts, release: () => act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 15)); }) };
}
afterEach(async () => {
	if (root) await unmount();
	mock.ctx.rest = rest;
	mock.control.disposers.forEach(dispose => dispose());
	mock.reset();
	mock.queryClient.setQueryDefaults(['hermes-t3sidebar-settings'], { gcTime: 0 });
});

test('a remounted settings page keeps the switch disabled while the previous page\'s save is still running', async () => {
	plugin.register(mock.ctx);
	await mount();
	const held = holdFirstSave();
	await act(async () => toggle().click()); await tick();
	assert.equal(held.puts(), 1);
	await unmount();
	await mount();
	assert.equal(toggle().getAttribute('aria-checked'), 'true', 'the remounted page reads the applied value');
	assert.equal(toggle().disabled, true, 'the save started by the previous page is still in flight');
	await act(async () => toggle().click()); await tick();
	assert.equal(held.puts(), 1, 'no second save starts while the first is in flight');
	await held.release(); await tick();
	assert.equal(toggle().getAttribute('aria-checked'), 'true');
	assert.equal(toggle().disabled, false, 'the switch is usable again once the save has answered');
	assert.equal(JSON.stringify(mock.control.experimentalSaved), '{"pool_credits":true}');
});

test('a save answered after plugin disposal does not recreate the removed settings root', async () => {
	// Desktop keeps unobserved queries for the default five minutes; with the mock's zero a recreated query would vanish before it is inspected.
	mock.queryClient.setQueryDefaults(['hermes-t3sidebar-settings'], { gcTime: 300000 });
	plugin.register(mock.ctx);
	await mount();
	const held = holdFirstSave();
	await act(async () => toggle().click()); await tick();
	assert.equal(held.puts(), 1);
	await unmount();
	mock.control.disposers.forEach(dispose => dispose());
	assert.equal(settingsQueries().length, 0, 'disposal removes the settings root');
	await held.release(); await tick();
	assert.equal(JSON.stringify(settingsQueries().map(query => query.queryKey)), '[]', 'a disposed registration publishes nothing');
});
