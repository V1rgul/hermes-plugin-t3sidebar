import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import plugin, { createController, captureScope, scopeKey, HermesT3Sidebar } from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let client, controller, root;
const tick = async () => act(async () => new Promise(resolve => setTimeout(resolve, 20)));
const requests = () => mock.calls.filter(call => call[0] === 'rest' && call[1].startsWith('/archives?')).map(call => call[1]);
function fixture(count = 1101) {
	mock.control.rows = [{ id: 'ordinary', title: 'Ordinary history', message_count: 2 }];
	mock.control.extra = Array.from({ length: count }, (_, index) => ({ id: `archive-${index}`, archived: true, title: `Archive ${index}`, message_count: 2, cwd: '/archive' }));
	mock.control.live = []; mock.control.metadata = { version: 1, sessions: {} };
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	controller = createController(mock.ctx, client);
	return captureScope();
}
afterEach(async () => {
	if (root) await act(async () => root.unmount()); root = null;
	controller?.dispose(); controller = null; client?.clear(); client = null;
	mock.control.disposers.forEach(dispose => dispose()); mock.reset();
});

test('archive first page is 100; each expansion fetches only a fresh head and the next 500-row page', async () => {
	const scope = fixture();
	const first = await controller.archives(scope);
	assert.equal(first.sessions.length, 100); assert.equal(first.has_more, true);
	assert.deepEqual(requests(), ['/archives?offset=0&limit=100']);
	mock.calls.length = 0;
	assert.equal((await controller.archives(scope, 1)).sessions.length, 600);
	assert.deepEqual(requests(), ['/archives?offset=0&limit=100', '/archives?offset=100&limit=500']);
	mock.calls.length = 0;
	assert.equal((await controller.archives(scope, 2)).sessions.length, 1100);
	assert.deepEqual(requests(), ['/archives?offset=0&limit=100', '/archives?offset=600&limit=500']);
	mock.calls.length = 0;
	assert.equal((await controller.archives(scope, 2)).sessions.length, 1100);
	assert.deepEqual(requests(), ['/archives?offset=0&limit=100'], 'ordinary polls must not replay older archive reads');
});

test('a changed head refreshes every loaded offset and an exhausted head drops the old tail', async () => {
	const scope = fixture(); await controller.archives(scope, 2);
	mock.control.extra.unshift({ id: 'new-archive', archived: true, title: 'New archive' });
	mock.calls.length = 0;
	const shifted = await controller.archives(scope, 2);
	assert.deepEqual(requests(), ['/archives?offset=0&limit=100', '/archives?offset=100&limit=500', '/archives?offset=600&limit=500']);
	assert.deepEqual(shifted.sessions.map(row => row.id), mock.control.extra.slice(0, 1100).map(row => row.id));
	mock.control.extra = mock.control.extra.slice(0, 10);
	const short = await controller.archives(scope, 2);
	assert.equal(short.sessions.length, 10); assert.equal(short.has_more, false);
});

test('older archive changes recover on the bounded stale interval and shifted pages refresh their suffix', async () => {
	const scope = fixture(); await controller.archives(scope, 2);
	const realNow = Date.now;
	const now = realNow();
	try {
		Date.now = () => now + 31_000;
		const laterKey = [...scopeKey(scope), 'archive-page', 600];
		client.setQueryData(laterKey, client.getQueryData(laterKey), { updatedAt: now + 30_000 });
		mock.control.extra.splice(200, 1);
		mock.calls.length = 0;
		const changed = await controller.archives(scope, 2);
		assert.deepEqual(requests(), ['/archives?offset=0&limit=100', '/archives?offset=100&limit=500', '/archives?offset=600&limit=500']);
		assert.deepEqual(changed.sessions.map(row => row.id), mock.control.extra.slice(0, 1100).map(row => row.id));
	} finally { Date.now = realNow; }
});

test('history events invalidate archive page caches while runtime events leave them fresh', async () => {
	const scope = fixture(700);
	controller.dispose(); client.clear(); client = mock.queryClient;
	controller = createController(mock.ctx, client);
	plugin.register(mock.ctx);
	await controller.archives(scope, 1);
	mock.calls.length = 0;
	mock.control.listener({ type: 'session.updated' }); await tick();
	await controller.archives(scope, 1);
	assert.deepEqual(requests(), ['/archives?offset=0&limit=100']);
	mock.control.extra[150].title = 'Changed outside the plugin';
	mock.control.listener({ type: 'sessions.changed' }); await tick();
	mock.calls.length = 0;
	const refreshed = await controller.archives(scope, 1);
	assert.deepEqual(requests(), ['/archives?offset=0&limit=100', '/archives?offset=100&limit=500']);
	assert.equal(refreshed.sessions.find(row => row.id === 'archive-150').title, 'Changed outside the plugin');
});

test('tail reads stay fenced by mutation generation, profile epoch and disposal', async () => {
	for (const stop of ['mutation', 'scope', 'dispose']) {
		mock.reset();
		const scope = fixture(700); let release, reached;
		const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { reached = resolve; });
		controller.dispose();
		controller = createController({ ...mock.ctx, rest: async (path, options) => {
			const value = await mock.ctx.rest(path, options);
			if (path.startsWith('/archives?offset=100')) { reached(); await gate; }
			return value;
		} }, client);
		const pending = controller.archives(scope, 1);
		const rejected = assert.rejects(pending, /Superseded|Source\/profile changed|CancelledError/);
		await started;
		if (stop === 'mutation') await controller.mutate(scope, 'ordinary', { action: 'archive' });
		if (stop === 'scope') mock.switchScope();
		if (stop === 'dispose') controller.dispose();
		release(); await rejected;
		assert.equal(client.getQueryData([...scopeKey(scope), 'archive-page', 100]), undefined);
		controller.dispose(); client.clear();
	}
});

test('repeated sidebar expansion retains one aggregate per feed, never every aggregate prefix', async () => {
	const scope = fixture();
	mock.control.rows = Array.from({ length: 1501 }, (_, index) => ({ id: `ordinary-${index}`, title: `Ordinary ${index}`, message_count: 2 }));
	root = createRoot(document.getElementById('app'));
	await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(HermesT3Sidebar, { ctx: mock.ctx, controller }))));
	await tick(); await tick();
	const click = async label => {
		const button = [...document.querySelectorAll('button')].find(node => node.textContent === label);
		assert.ok(button, label); await act(async () => button.click()); await tick(); await tick();
	};
	for (let index = 0; index < 2; index++) {
		await click('Browse older sessions'); await click('Browse older archives');
	}
	const queries = client.getQueryCache().findAll({ queryKey: scopeKey(scope) });
	assert.equal(queries.filter(query => query.queryKey[4] === 'expanded').length, 1);
	assert.equal(queries.filter(query => query.queryKey[4] === 'archives').length, 1);
	assert.equal(queries.find(query => query.queryKey[4] === 'expanded').state.data.sessions.length, 1000);
	assert.equal(queries.find(query => query.queryKey[4] === 'archives').state.data.sessions.length, 1100);
});
