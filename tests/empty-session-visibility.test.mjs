import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import { captureScope, scopeKey, createController, HermesT3Sidebar, mergeRows } from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let root, controller;
const tick = async () => act(async () => new Promise(resolve => setTimeout(resolve, 30)));
const row = id => document.querySelector(`[data-session-id="${id}"]`);
async function mount() {
	controller = createController(mock.ctx);
	root = createRoot(document.getElementById('app'));
	await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(HermesT3Sidebar, { ctx: mock.ctx, controller }))));
	await tick(); await tick();
}
async function refresh() {
	await act(async () => mock.queryClient.invalidateQueries({ queryKey: scopeKey(captureScope()) }));
	await tick(); await tick();
}
function fixtures() {
	mock.control.rows = [{ id: 'stored-empty', message_count: 0 }, { id: 'history', title: 'Existing history', message_count: 2 }];
	mock.control.live = [{ id: 'runtime-empty', session_key: 'live-empty', status: 'idle', source: 'desktop', message_count: 0,
		cwd: '/robot', project: { id: 'robot', name: 'Robot', cwd: '/robot', icon: 'tools', color: '#ff6000' }, provider: 'anthropic' }];
	mock.control.metadata = { version: 1, sessions: {}, completions: {} };
	mock.host.state.focusedStoredSessionId.set('live-empty');
}
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; controller?.dispose(); controller = null; mock.reset(); });

test('both persisted and runtime-only empty sessions are absent without a prompt; real and unknown history stay visible', async () => {
	fixtures(); mock.control.rows.push({ id: 'unknown' });
	await mount();
	assert.equal(!!row('stored-empty'), false);
	assert.equal(!!row('live-empty'), false);
	assert.ok(row('history')); assert.ok(row('unknown'));
	assert.ok(mock.calls.some(call => call[0] === 'getDraft' && call[1] === 'live-empty'), 'hidden rows still inspect their own draft');
	assert.equal(Boolean(document.querySelector('[data-section="active"] .sf-empty')), false);
});

test('draft-bearing empty session displays exact runtime project, glyph, color and provider, then disappears on clear', async () => {
	fixtures(); mock.control.mountedDrafts['live-empty'] = 'PRIVATE unsent prompt';
	await mount();
	const draft = row('live-empty'); assert.ok(draft);
	assert.equal(draft.querySelector('.sf-project-name').textContent, 'Robot');
	assert.equal(draft.querySelector('[data-codicon]').dataset.codicon, 'tools');
	assert.equal(draft.querySelector('.sf-project-icon').style.color, 'rgb(255, 96, 0)');
	assert.ok(draft.querySelector('[data-provider-mark="anthropic"]'));
	assert.equal(draft.dataset.hasDraft, 'true');
	assert.equal(document.body.textContent.includes('PRIVATE'), false);
	assert.equal(JSON.stringify(mock.queryClient.getQueryCache().getAll().map(query => query.state.data)).includes('PRIVATE'), false);
	// Without backend support the only write is the refused draft persistence request, which carries identities only.
	const posts = mock.calls.filter(call => call[0] === 'rest' && call[2]?.method === 'POST');
	assert.deepEqual(posts.map(call => [call[1], call[2].body]), [['/sessions/live-empty/draft', { runtime_id: 'runtime-empty' }]]);
	mock.control.mountedDrafts['live-empty'] = '';
	await act(async () => mock.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar-drafts'] })); await tick();
	assert.equal(!!row('live-empty'), false);
	mock.control.mountedDrafts['live-empty'] = 'typed again';
	await act(async () => mock.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar-drafts'] })); await tick();
	assert.ok(row('live-empty'), 'the hidden draft observer survives card removal');
});

test('inactive stored draft survives filtering, and the first real message keeps its card after draft clears', async () => {
	fixtures(); mock.control.drafts['stored-empty'] = 'stashed prompt';
	await mount(); assert.ok(row('stored-empty'));
	mock.control.drafts['stored-empty'] = '';
	Object.assign(mock.control.rows[0], { title: 'First reply', message_count: 2 });
	await refresh(); assert.ok(row('stored-empty'));
	assert.equal(row('stored-empty').querySelector('.sf-row-title').textContent, 'First reply');
});

const draftPosts = () => mock.calls.filter(call => call[0] === 'rest' && call[2]?.method === 'POST' && call[1].endsWith('/draft'));

test('typing into an unsaved session persists its row once, and the card stays tinted after the composer is cleared', async () => {
	fixtures(); mock.control.draftPersistence = true; mock.control.mountedDrafts['live-empty'] = 'PRIVATE unsent prompt';
	await mount(); await tick();
	assert.deepEqual(mock.control.draftRequests, [{ id: 'live-empty', body: { runtime_id: 'runtime-empty' } }]);
	assert.equal(JSON.stringify(mock.calls.filter(call => call[0] === 'rest')).includes('PRIVATE'), false);
	assert.equal(mock.calls.some(call => call[0] === 'rest' && call[2]?.method === 'POST' && !call[1].endsWith('/draft')), false, 'no plugin metadata is written');
	// The stored row replaces the runtime-only card, keeping the runtime's project and provider.
	await refresh();
	let card = row('live-empty'); assert.ok(card);
	assert.equal(card.querySelector('.sf-row-title').textContent, 'New session');
	assert.equal(card.querySelector('.sf-project-name').textContent, 'Robot');
	// Cleared composer: the session no longer disappears, and stays orange once another session is focused.
	mock.control.mountedDrafts['live-empty'] = '';
	await act(async () => mock.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar-drafts'] })); await tick();
	await act(async () => mock.host.state.focusedStoredSessionId.set('history')); await tick(); await refresh();
	card = row('live-empty'); assert.ok(card);
	assert.equal(card.dataset.current, 'false');
	assert.equal(card.dataset.hasDraft, 'true');
	assert.equal(draftPosts().length, 1, 'a stored session is not persisted again');
	// The first message ends the draft treatment.
	Object.assign(mock.control.rows.find(item => item.id === 'live-empty'), { title: 'First reply', message_count: 2 });
	await refresh();
	assert.equal(row('live-empty').querySelector('.sf-row-title').textContent, 'First reply');
	assert.equal(row('live-empty').dataset.hasDraft, 'false');
});

test('a stored empty Desktop row stays visible and tinted without composer text; other sources and runtime-only rows do not', async () => {
	fixtures(); mock.control.draftPersistence = true;
	mock.control.rows.push({ id: 'acp-empty', source: 'acp', message_count: 0 }, { id: 'desktop-empty', source: 'desktop', message_count: 0 });
	await mount();
	assert.ok(row('desktop-empty')); assert.equal(row('desktop-empty').dataset.hasDraft, 'true');
	assert.equal(row('desktop-empty').querySelector('.sf-row-title').textContent, 'New session');
	assert.equal(!!row('acp-empty'), false, 'empty non-Desktop rows such as ACP health checks stay hidden');
	assert.equal(!!row('stored-empty'), false, 'rows without known Desktop provenance stay hidden');
	assert.equal(!!row('live-empty'), false, 'an unsaved session without text stays hidden');
	assert.equal(draftPosts().length, 0, 'stored rows are never persisted again');
});

test('a refused or unconfirmed persistence backs off instead of repeating every render', async () => {
	fixtures(); mock.control.mountedDrafts['live-empty'] = 'typed';
	await mount(); await refresh(); await refresh();
	assert.equal(draftPosts().length, 1);
	assert.ok(row('live-empty'), 'the text still shows the card while unsupported');
	mock.reset(); if (root) await act(async () => root.unmount()); root = null; controller?.dispose();
	fixtures(); mock.control.draftPersistence = true; mock.control.draftWrongId = 'another'; mock.control.mountedDrafts['live-empty'] = 'typed';
	await mount(); await refresh();
	assert.equal(draftPosts().length, 1);
});

test('empty visibility remains fail-closed on failed composer reads', async () => {
	fixtures(); mock.control.drafts['stored-empty'] = '  \n '; mock.control.draftError = true;
	await mount(); assert.equal(!!row('stored-empty'), false); assert.equal(!!row('live-empty'), false); assert.ok(row('history'));
});

test('whitespace and an unavailable composer do not reveal empty cards', async () => {
	fixtures(); mock.control.drafts['stored-empty'] = ' \n	 ';
	const composer = mock.host.composer;
	try {
		delete mock.host.composer;
		await mount(); assert.equal(!!row('stored-empty'), false); assert.equal(!!row('live-empty'), false);
		mock.host.composer = composer;
		await act(async () => mock.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar-drafts'] })); await tick();
		assert.equal(!!row('stored-empty'), false); assert.equal(!!row('live-empty'), false);
	} finally { mock.host.composer = composer; }
});

test('hidden empty candidates keep focused polling and running/input sessions remain visible', async () => {
	fixtures(); await mount();
	const query = mock.queryClient.getQueryCache().find({ queryKey: ['hermes-t3sidebar-drafts', 'source-a', 'default', mock.epoch, 'live-empty', 'live-empty'] });
	assert.ok(query); assert.ok(query.observers.some(observer => observer.options.refetchInterval === 2000));
	assert.equal(!!row('live-empty'), false);
	for (const status of ['working', 'waiting']) {
		mock.control.live[0].status = status; await refresh();
		assert.ok(row('live-empty'), `${status} cannot be hidden by a draft filter`);
	}
});

test('missing metadata on a persisted empty row is enriched from its exact runtime but stored content is never overwritten', () => {
	const live = [{ id: 'rt', session_key: 'empty', message_count: 0, cwd: '/robot', project: { id: 'p', name: 'Robot', icon: 'tools' }, provider: 'anthropic' }];
	const [empty] = mergeRows([{ id: 'empty', message_count: 0 }], [], live);
	assert.equal(empty.cwd, '/robot'); assert.equal(empty.project.name, 'Robot'); assert.equal(empty.provider, 'anthropic');
	const stored = { id: 'empty', message_count: 2, cwd: '/stored', project: { name: 'Stored' }, provider: 'openai-codex' };
	const [history] = mergeRows([stored], [], live);
	assert.equal(history.cwd, '/stored'); assert.equal(history.provider, 'openai-codex'); assert.equal(history.project.name, 'Stored');
});

test('provider icon survives the first prompt becoming persisted while tokens remain zero', async () => {
	fixtures(); mock.control.mountedDrafts['live-empty'] = 'Unsent fixture prompt';
	await mount();
	const provider = () => row('live-empty').querySelector('.sf-provider')?.getAttribute('aria-label');
	assert.equal(provider(), 'Provider: anthropic');
	mock.control.mountedDrafts['live-empty'] = '';
	mock.control.rows.push({ id: 'live-empty', source: 'desktop', message_count: 1, provider: null, total_tokens: 0,
		cwd: '/stored', project: { name: 'Stored workspace' } });
	Object.assign(mock.control.live[0], { status: 'working', message_count: 1, turn_started_at: Date.now() / 1000 });
	await refresh();
	assert.equal(provider(), 'Provider: anthropic');
	assert.equal(row('live-empty').querySelector('.sf-token').textContent, '0');
	assert.equal(row('live-empty').querySelector('.sf-project-name').textContent, 'Stored workspace');
	assert.equal(row('live-empty').dataset.working, 'true');
	Object.assign(mock.control.rows.at(-1), { title: 'First response', message_count: 2, provider: 'anthropic', total_tokens: 2000 });
	Object.assign(mock.control.live[0], { status: 'idle', message_count: 2, provider: null });
	await refresh();
	assert.equal(provider(), 'Provider: anthropic');
	assert.equal(row('live-empty').querySelector('.sf-token').textContent, '2K');
});

test('runtime provider fallback is independent of message count and preserves concrete stored providers', () => {
	const runtime = { id: 'rt', session_key: 'new', source: 'desktop', provider: 'anthropic' };
	for (const message_count of [0, 1, 2, undefined]) {
		for (const provider of [null, undefined, '', 'auto', ' Unknown ', 'default', 'none', 42]) {
			const [merged] = mergeRows([{ id: 'new', message_count, provider, total_tokens: 0 }], [], [runtime]);
			assert.equal(merged.provider, 'anthropic');
			assert.equal(merged.total_tokens, 0);
		}
		for (const provider of ['openai-codex', 'unsupported-explicit-provider']) {
			const [merged] = mergeRows([{ id: 'new', message_count, provider }], [], [runtime]);
			assert.equal(merged.provider, provider);
		}
		for (const provider of [null, undefined, '', 'auto', ' Unknown ', 'default', 'none', 42]) {
			const [merged] = mergeRows([{ id: 'new', message_count, provider: null }], [], [{ ...runtime, provider }]);
			assert.equal(merged.provider, null);
		}
	}
});

test('provider fallback uses only an unambiguous surfaced-tip runtime, not ancestors or internal runs', () => {
	for (const stored of [
		{ id: 'tip', _lineage_root_id: 'root', _lineage_ids: ['root', 'tip'] },
		{ id: 'root', resolved_id: 'tip', _lineage_ids: ['root', 'tip'] }
	]) {
		const row = { ...stored, message_count: 1, provider: null };
		const root = { id: 'rt-root', session_key: 'root', source: 'desktop', provider: 'openai-codex' };
		const tip = { id: 'rt-tip', session_key: 'tip', source: 'desktop', provider: 'anthropic' };
		assert.equal(mergeRows([row], [], [root, tip])[0].provider, 'anthropic');
		for (const live of [[root], [tip, { ...tip, id: 'duplicate-tip' }], ...['cron', 'tool', 'oneshot', 'kanban', 'subagent'].map(source => [{ ...tip, source }])]) {
			assert.equal(mergeRows([row], [], live)[0].provider, null);
		}
	}
});

test('unknown runtime metadata preserves stored draft project/provider while explicit Home replaces workspace', async () => {
	fixtures();
	Object.assign(mock.control.rows[0], { cwd: '/chosen', project: { name: 'Chosen', icon: 'tools', color: '#ff6000' }, provider: 'openai-codex' });
	mock.control.drafts['stored-empty'] = 'Unsent chosen task';
	await mount();
	const project = () => row('stored-empty').querySelector('.sf-project-name').textContent;
	assert.equal(project(), 'Chosen');
	mock.control.live.push({ id: 'rt-chosen', session_key: 'stored-empty', source: 'desktop', status: 'idle', message_count: 0, cwd: null, project: null, provider: null });
	await refresh();
	assert.equal(project(), 'Chosen'); assert.ok(row('stored-empty').querySelector('[data-provider-mark="openai-codex"]'));
	assert.equal(row('stored-empty').querySelector('[data-codicon]').dataset.codicon, 'tools');
	Object.assign(mock.control.live.at(-1), { project: { id: '__no_project__', name: 'Home', icon: null, is_home: true, cwd: null } });
	await refresh();
	assert.equal(project(), 'Home'); assert.equal(row('stored-empty').querySelector('[data-codicon]').dataset.codicon, 'home');
	assert.ok(row('stored-empty').querySelector('[data-provider-mark="openai-codex"]'), 'unknown provider does not erase independent stored evidence');
	const [merged] = mergeRows([mock.control.rows[0]], [], [mock.control.live.at(-1)]);
	assert.equal(merged.cwd, null);
});

test('ambiguous or internal runtimes cannot supply another empty card metadata', () => {
	const row = { id: 'empty', message_count: 0 };
	const runtime = { id: 'rt', session_key: 'empty', source: 'desktop', message_count: 0, cwd: '/robot', project: { name: 'Robot' }, provider: 'anthropic' };
	for (const live of [[runtime, { ...runtime, id: 'rt2', cwd: '/other' }], [{ ...runtime, source: 'cron' }]]) {
		const [merged] = mergeRows([row], [], live);
		assert.equal(merged.cwd, undefined); assert.equal(merged.project, undefined); assert.equal(merged.provider, undefined);
	}
});

test('a late draft response from a previous owner cannot reveal a same-ID empty session in the new scope', async () => {
	fixtures(); let finish;
	mock.control.readDraft = id => id === 'live-empty' ? new Promise(resolve => { finish = resolve; }) : null;
	await mount(); assert.equal(!!row('live-empty'), false); assert.equal(typeof finish, 'function');
	const finishOldOwner = finish;
	mock.control.readDraft = () => null;
	await act(async () => mock.switchScope('source-b'));
	await act(async () => finishOldOwner('old-owner private prompt')); await tick();
	assert.equal(!!row('live-empty'), false);
});
