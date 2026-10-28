import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import plugin, { snoozePresets } from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const storage = mock.ctx.storage;
let root;
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
const $ = selector => document.querySelector(selector);
const button = label => [...document.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label);
async function click(node) { assert.ok(node); await act(async () => node.click()); await tick(); }
async function input(node, value) {
	await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
	await tick();
}
async function render() {
	root = createRoot($('#app'));
	await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient },
		React.createElement(React.Fragment, null, mock.control.settings.render(), mock.control.contributions[0].render()))));
	await tick(); await tick();
}
afterEach(async () => {
	if (root) { await act(async () => root.unmount()); root = null; }
	mock.control.disposers.forEach(dispose => dispose());
	mock.ctx.storage = storage; mock.reset();
});

test('preset time defaults to 09:00 and a verified settings save updates both options in an already-open menu', async () => {
	plugin.register(mock.ctx); await render();
	assert.equal($('[aria-label="Snooze preset time"]').value, '09:00');
	const originalDeadline = mock.control.metadata.sessions.snoozed.wake_at;
	await click($('[data-session-id="design"] [aria-label="Snooze session"]'));
	assert.ok(button('Tomorrow at 9:00')); assert.ok(button('Next Monday at 9:00'));
	assert.equal(document.querySelectorAll('.sf-snooze-info').length, 0, 'unsnoozed sessions have no existing-wake information');
	await input($('[aria-label="Snooze preset time"]'), '14:35');
	assert.equal(storage.get('snooze-time'), '14:35');
	assert.ok(button('Tomorrow at 14:35')); assert.ok(button('Next Monday at 14:35'));
	assert.equal(button('Tomorrow at 9:00'), undefined);
	assert.equal(mock.control.metadata.sessions.snoozed.wake_at, originalDeadline, 'a preference change cannot reschedule existing snoozes');
	const expected = snoozePresets(Date.now(), '14:35')[2].wake_at;
	await click(button('Tomorrow at 14:35'));
	assert.equal(mock.control.metadata.sessions.design.wake_at, expected);
	await click($('[data-session-id="design"] [aria-label="Snooze session"]'));
	const monday = snoozePresets(Date.now(), '14:35')[3].wake_at;
	await click(button('Next Monday at 14:35'));
	assert.equal(mock.control.metadata.sessions.design.wake_at, monday);
});

test('preset time persists through a fresh query cache/remount and is a Desktop preference across sources', async () => {
	plugin.register(mock.ctx); await render();
	await input($('[aria-label="Snooze preset time"]'), '07:15');
	await act(async () => root.unmount()); root = null;
	mock.queryClient.clear(); await render();
	assert.equal($('[aria-label="Snooze preset time"]').value, '07:15');
	await act(async () => mock.switchScope('source-b', 'other')); await tick(); await tick();
	await click($('[data-session-id="design"] [aria-label="Snooze session"]'));
	assert.ok(button('Tomorrow at 7:15')); assert.ok(button('Next Monday at 7:15'));
});

for (const saved of ['24:00', '9:00', null, {}]) test(`invalid stored preset time ${JSON.stringify(saved)} safely uses the default`, async () => {
	storage.set('snooze-time', saved); plugin.register(mock.ctx); await render();
	assert.equal($('[aria-label="Snooze preset time"]').value, '09:00');
	await click($('[data-session-id="design"] [aria-label="Snooze session"]'));
	assert.ok(button('Tomorrow at 9:00')); assert.ok(button('Next Monday at 9:00'));
});

test('settings rejects empty input and failed storage writes without publishing a false saved value', async () => {
	plugin.register(mock.ctx); await render();
	await input($('[aria-label="Snooze preset time"]'), '');
	assert.match($('[role=alert]').textContent, /valid time/);
	assert.equal($('[aria-label="Snooze preset time"]').value, '09:00');
	mock.ctx.storage = { ...storage, set() { throw new Error('fixture storage unavailable'); } };
	await input($('[aria-label="Snooze preset time"]'), '12:45');
	assert.match($('[role=alert]').textContent, /storage unavailable/);
	assert.equal($('[aria-label="Snooze preset time"]').value, '09:00');
	mock.ctx.storage = { ...storage, set() {} };
	await input($('[aria-label="Snooze preset time"]'), '12:45');
	assert.match($('[role=alert]').textContent, /not saved/);
	assert.equal($('[aria-label="Snooze preset time"]').value, '09:00');
	await click($('[data-session-id="design"] [aria-label="Snooze session"]'));
	assert.ok(button('Tomorrow at 9:00')); assert.ok(button('Next Monday at 9:00'));
});

test('unavailable storage reads leave settings and default presets usable', async () => {
	mock.ctx.storage = { ...storage, get() { throw new Error('fixture storage unavailable'); } };
	plugin.register(mock.ctx); await render();
	assert.equal($('[aria-label="Snooze preset time"]').value, '09:00');
	await click($('[data-session-id="design"] [aria-label="Snooze session"]'));
	assert.ok(button('Tomorrow at 9:00')); assert.ok(button('Next Monday at 9:00'));
});

test('the Detailed Working indicator setting defaults off, persists, switches every card without a reload and rejects failed saves', async () => {
	mock.control.live.find(item => item.id === 'runtime-worker').running_subagents = 2;
	mock.control.live.push({ id: 'runtime-design', session_key: 'design', status: 'idle', running_subagents: null, awaiting_processes: true });
	plugin.register(mock.ctx); await render();
	const toggle = () => $('[role=switch][aria-label="Detailed Working indicator"]');
	const badge = id => {
		const status = $(`[data-session-id="${id}"] .sf-status`);
		return { agent: status.dataset.agent ?? null, glyph: status.querySelector('svg')?.querySelectorAll('path').length ?? 0, count: status.querySelector('.sf-subagents')?.textContent ?? null, label: status.querySelector('.sf-sr').textContent };
	};
	const plain = { agent: null, glyph: 8, count: null, label: 'Working' };
	// Default: the plain dashed circle everywhere, even when the count is unknown, and no details in the hover title.
	assert.equal(toggle().getAttribute('aria-checked'), 'false');
	assert.deepEqual(badge('root'), plain);
	assert.deepEqual(badge('design'), plain);
	assert.equal($('[data-session-id="root"] .sf-open').title.split('\n').at(-1), 'working');
	await click(toggle());
	assert.equal(storage.get('working-details'), true);
	assert.equal(toggle().getAttribute('aria-checked'), 'true');
	assert.deepEqual(badge('root'), { agent: 'true', glyph: 1, count: '+2', label: 'Working: Agent working · 2 subagents running' });
	assert.deepEqual(badge('design'), { agent: null, glyph: 0, count: null, label: 'Working' });
	assert.equal($('[data-session-id="root"] .sf-open').title.split('\n').at(-1), 'Agent working · 2 subagents running');
	// Persisted: a fresh mount reads it back.
	await act(async () => root.unmount()); mock.queryClient.removeQueries({ queryKey: ['hermes-t3sidebar-preferences'] }); await render();
	assert.equal(toggle().getAttribute('aria-checked'), 'true');
	assert.deepEqual(badge('root'), { agent: 'true', glyph: 1, count: '+2', label: 'Working: Agent working · 2 subagents running' });
	await click(toggle());
	assert.equal(storage.get('working-details'), false);
	assert.deepEqual(badge('root'), plain);
	mock.ctx.storage = { ...storage, set() { throw new Error('fixture storage unavailable'); } };
	await click(toggle());
	assert.match($('[role=alert]').textContent, /storage unavailable/);
	assert.equal(toggle().getAttribute('aria-checked'), 'false');
	assert.deepEqual(badge('root'), plain);
});
