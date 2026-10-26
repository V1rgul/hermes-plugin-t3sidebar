import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import { compactTokens, cardStatus, buildSections, captureScope, scopeKey, createController, HermesT3Sidebar } from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let root, controller;
const tick = async () => act(async () => new Promise(resolve => setTimeout(resolve, 20)));
const button = (label, parent = document) => [...parent.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label);
const click = async node => { assert.ok(node); await act(async () => node.click()); await tick(); };
async function mount() {
	controller = createController(mock.ctx);
	root = createRoot(document.getElementById('app'));
	await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(HermesT3Sidebar, { ctx: mock.ctx, controller }))));
	await tick(); await tick();
}
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; controller?.dispose(); controller = null; mock.reset(); });

test('tokens have whole-thousand resolution and exactly one decimal for millions', () => {
	for (const [value, label] of [[0, '0'], [1, '0K'], [499, '0K'], [500, '1K'], [1250, '1K'], [1500, '2K'], [999499, '999K'], [999500, '1.0M'], [1000000, '1.0M'], [1250000, '1.3M'], [12000000, '12.0M']]) assert.equal(compactTokens({ total_tokens: value }), label);
	assert.equal(compactTokens({ total_tokens: NaN }), '—');
});

test('archived history is viewable without unarchiving and carries no Done, snooze or pin controls', async () => {
	mock.control.metadata.sessions.archived = { state: 'snoozed', pinned: true, wake_at: Date.now() / 1000 + 3600 };
	mock.control.metadata.completions = { archived: { done_token: 'old-done', done_at: 1 } };
	mock.control.rows.find(row => row.id === 'archived').unread = true;
	await mount();
	const row = document.querySelector('[data-session-id="archived"]');
	assert.equal(row.closest('section').getAttribute('aria-label'), 'Archived');
	assert.equal(row.querySelector('.sf-pin'), null); assert.equal(row.querySelector('.sf-status'), null);
	assert.equal(row.querySelector('[aria-label="Snooze session"]'), null);
	await click(row.querySelector('.sf-open'));
	assert.equal(mock.control.rows.find(row => row.id === 'archived').archived, true);
	assert.ok(!mock.calls.some(call => call[2] === 'session.archive'));
	await click(button('Actions for SDK inventory'));
	const menu = document.querySelector('[aria-label="Session actions"]');
	assert.equal(button('Pin', menu), undefined); assert.equal(button('Unpin', menu), undefined); assert.equal(button('Restore to Ready', menu), undefined);
	assert.equal(cardStatus({ archived: true, status: 'idle', unread: true, completion: { done_token: 'old' }, woke: true }), null);
});

test('active archived runtimes immediately leave Archived even before persisted activity restoration refreshes', () => {
	for (const status of ['working', 'starting', 'waiting']) {
		// "starting" is work only with an in-flight turn (a prompt sent while the agent builds).
		const sections = buildSections([{ id: 'root', archived: true }], { sessions: { root: { state: 'snoozed', wake_at: 9999, pinned: true } } }, [{ session_key: 'root', status, turn_started_at: status === 'starting' ? 90 : undefined }], { now: 100 });
		assert.equal(sections.archived.length, 0);
		assert.equal(sections[status === 'waiting' ? 'active' : 'working'][0].key, 'root');
	}
	// Opening an archived session only rebuilds its agent: it stays Archived, and not idle, so it is not unarchived or deleted mid-build.
	const opened = buildSections([{ id: 'root', archived: true }], { sessions: {} }, [{ session_key: 'root', status: 'starting' }], { now: 100 });
	assert.equal(opened.archived[0]?.key, 'root');
	assert.equal(opened.archived[0].status, 'starting');
});

test('archived metadata guard prevents pin/snooze writes including stale menu clicks', async () => {
	controller = createController(mock.ctx);
	for (const payload of [{ action: 'pin' }, { action: 'snooze', wake_at: Date.now() / 1000 + 3600 }]) await assert.rejects(controller.mutate(captureScope(), 'archived', payload), /Unarchive/);
	assert.ok(!mock.calls.some(call => call[0] === 'rest' && call[2]?.method === 'POST'));
});

function target() {
	mock.control.projects.push({ id: 'p_target', label: 'Target', path: '/target', repos: [{ path: '/target' }], icon: 'tools' });
	return { id: 'p_target:/target', name: 'Target', path: '/target', isNoProject: false };
}

test('Move to project submenu sits directly above Project and moves without opening a session', async () => {
	target(); await mount(); await click(button('Actions for Sidebar layout'));
	const menu = document.querySelector('[aria-label="Session actions"]');
	const actions = [...menu.querySelectorAll('.sf-menu-action')].map(node => node.getAttribute('aria-label') || node.textContent);
	assert.deepEqual(actions.slice(-2), ['Move to project', 'Project']);
	await click(button('Move to project', menu));
	await click(button('Move to Target'));
	assert.equal(mock.control.rows.find(row => row.id === 'design').cwd, '/target');
	assert.equal(document.querySelector('[data-session-id="design"] .sf-project-name').textContent, 'Target');
	const writes = mock.calls.filter(call => call[2] === 'session.workspace.move');
	assert.equal(writes.length, 1); assert.deepEqual(writes[0][3], { session_key: 'design', cwd: '/target' });
	assert.ok(!mock.calls.some(call => ['open', 'new'].includes(call[0])));
});

test('move requires exact workspace readback and fences profile switches', async () => {
	const project = target(), scope = captureScope(), row = { ...mock.control.rows.find(row => row.id === 'design'), status: 'idle' };
	controller = createController(mock.ctx);
	const key = [...scopeKey(scope), 'sessions'];
	mock.queryClient.setQueryData(key, { sessions: [row] });
	mock.control.dropMove = true;
	await assert.rejects(controller.moveProject(scope, row, project), /did not confirm/);
	assert.equal(mock.queryClient.getQueryData(key).sessions[0].cwd, row.cwd);
	mock.control.dropMove = false; mock.control.afterMove = () => mock.switchScope();
	await assert.rejects(controller.moveProject(scope, row, project), /Source\/profile changed/);
	assert.equal(mock.queryClient.getQueryData(key).sessions[0].cwd, row.cwd);
});

test('move reuses one asynchronously discovered route but later project reads and moves discover independently', async () => {
	const project = target(), scope = captureScope(), row = { ...mock.control.rows.find(row => row.id === 'design'), status: 'idle' };
	let discoveries = 0;
	controller = createController(mock.ctx, mock.queryClient, { capture: captureScope, routes: async () => {
		discoveries++; await Promise.resolve(); return mock.host.profileRoutes();
	}, host: mock.host });
	await controller.moveProject(scope, row, project);
	assert.equal(discoveries, 1, 'the move operation must reuse its route for projects.tree');
	const tree = mock.calls.find(call => call[2] === 'projects.tree');
	const move = mock.calls.find(call => call[2] === 'session.workspace.move');
	assert.equal(tree[1], move[1], 'tree and move use the same operation authority');
	await controller.projects(scope);
	assert.equal(discoveries, 2, 'public projects() must discover its own fresh route');
	await controller.moveProject(scope, row, project);
	assert.equal(discoveries, 3, 'another move must not reuse a settled route');
});

test('move route discovery failure retries and tree reads remain scope/epoch fenced', async () => {
	for (const stop of ['discovery', 'scope', 'epoch']) {
		mock.reset();
		const project = target(), scope = captureScope(), row = { ...mock.control.rows.find(row => row.id === 'design'), status: 'idle' };
		let discoveries = 0;
		controller = createController(mock.ctx, mock.queryClient, { capture: captureScope, routes: async () => {
			discoveries++; await Promise.resolve();
			if (stop === 'discovery' && discoveries === 1) throw new Error('route discovery unavailable');
			return mock.host.profileRoutes();
		}, host: { ...mock.host, async requestProfile(route, method, params) {
			const value = await mock.host.requestProfile(route, method, params);
			if (method === 'projects.tree' && stop !== 'discovery') {
				mock.switchScope(); if (stop === 'epoch') mock.switchScope('source-a');
			}
			return value;
		} } });
		await assert.rejects(controller.moveProject(scope, row, project), stop === 'discovery' ? /route discovery unavailable/ : /Source\/profile changed/);
		assert.equal(discoveries, 1);
		assert.equal(mock.calls.some(call => call[2] === 'session.workspace.move'), false);
		if (stop === 'discovery') {
			await controller.moveProject(scope, row, project);
			assert.equal(discoveries, 2, 'a failed discovery must not survive into retry');
		}
		controller.dispose();
	}
});

test('compressed conversation move targets its surfaced resume tip rather than the ended root', async () => {
	const project = target(), scope = captureScope(); controller = createController(mock.ctx);
	mock.control.live = [];
	const row = { ...mock.control.rows.find(row => row.id === 'tip'), status: 'idle' };
	await controller.moveProject(scope, row, project);
	const write = mock.calls.find(call => call[2] === 'session.workspace.move');
	assert.deepEqual(write[3], { session_key: 'tip', cwd: '/target' });
	assert.ok(mock.calls.some(call => call[0] === 'rest' && call[1] === '/sessions/tip/workspace'));
});

test('move refuses busy, unknown, unsaved and missing project targets before mutation', async () => {
	const project = target(), scope = captureScope(); controller = createController(mock.ctx);
	for (const row of [{ id: 'design', status: 'working' }, { id: 'design', status: 'unknown' }, { id: 'design', status: 'idle', _liveOnly: true }]) await assert.rejects(controller.moveProject(scope, row, project), /confirmed idle/);
	mock.control.projects = [];
	await assert.rejects(controller.moveProject(scope, { id: 'design', status: 'idle' }, project), /changed or was removed/);
	assert.ok(!mock.calls.some(call => call[2] === 'session.workspace.move'));
});
