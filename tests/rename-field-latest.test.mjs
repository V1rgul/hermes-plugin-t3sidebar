// Rename fields start from the title or project name current when Rename is chosen, not when the menu opened, and never overwrite what the user types.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import { createController, captureScope, scopeKey, HermesT3Sidebar } from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let root, controller;
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const dialog = label => document.querySelector(`[role=dialog][aria-label="${label}"]`);
const button = (parent, label) => [...parent.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label);
async function click(node) { assert.ok(node); await act(async () => node.click()); await tick(); }
async function type(node, value) {
	await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
	await tick();
}
// A poll bringing a change made elsewhere to the design session while its menu stays open.
async function poll(change) {
	await act(async () => mock.queryClient.setQueryData([...scopeKey(captureScope()), 'sessions'], previous => ({ ...previous, sessions: previous.sessions.map(row => row.id === 'design' ? change(row) : row) })));
	await tick();
}
async function openActions() {
	controller = createController(mock.ctx);
	root = createRoot(document.querySelector('#app'));
	await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(HermesT3Sidebar, { ctx: mock.ctx, controller }))));
	await tick(); await tick();
	await act(async () => document.querySelector('[data-session-id="design"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))); await tick();
	assert.ok(dialog('Session actions'));
}
afterEach(async () => {
	if (root) { await act(async () => root.unmount()); root = null; }
	controller?.dispose(); controller = null;
	mock.reset();
});

test('session rename starts from the title current when Rename is chosen and keeps the typed text across polls', async () => {
	await openActions();
	await poll(row => ({ ...row, title: 'Renamed elsewhere' }));
	await click(button(dialog('Session actions'), 'Rename'));
	const field = () => dialog('Session actions').querySelector('input[aria-label="Session title"]');
	assert.equal(field().value, 'Renamed elsewhere');
	await type(field(), 'My own title');
	await poll(row => ({ ...row, title: 'Renamed again' }));
	assert.equal(field().value, 'My own title');
	assert.equal(button(dialog('Session actions'), 'Rename'), undefined, 'the field replaces the title and its Rename button while editing');
});

test('project rename starts from the project name current when Rename is chosen and keeps the typed text across polls', async () => {
	await openActions();
	await click(button(dialog('Session actions'), 'Project'));
	assert.ok(dialog('Project actions'));
	await poll(row => ({ ...row, project: { ...row.project, name: 'Renamed project' } }));
	await click(button(dialog('Project actions'), 'Rename project'));
	const field = () => dialog('Project actions').querySelector('input[aria-label="Project name"]');
	assert.equal(field().value, 'Renamed project');
	await type(field(), 'My project');
	await poll(row => ({ ...row, project: { ...row.project, name: 'Renamed again' } }));
	assert.equal(field().value, 'My project');
});
