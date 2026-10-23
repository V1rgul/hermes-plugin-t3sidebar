import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import plugin, * as flow from '../desktop/plugin.js';
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let root, controller;
const tick = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 12)); }); };
const $ = selector => document.querySelector(selector);
const all = selector => [...document.querySelectorAll(selector)];
const row = id => { const element = $(`[data-session-id="${id}"]`); return element?.closest('[data-closed=true]') ? null : element; };
const shelf = name => $(`section[aria-label="${name}"]`);
const button = label => all('button').find(node => node.getAttribute('aria-label') === label || node.textContent === label);
async function click(node) { assert.ok(node, 'button exists'); await act(async () => { node.click(); }); await tick(); }
async function input(node, value) {
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); }); await tick();
}
async function refresh() { await act(async () => mock.queryClient.invalidateQueries({ queryKey: flow.scopeKey(flow.captureScope()) })); await tick(); }
async function mount() {
  controller = flow.createController(mock.ctx);
  root = createRoot($('#app'));
  await act(async () => { root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(flow.HermesT3Sidebar, { ctx: mock.ctx, controller }))); });
  await tick(); await tick();
}
afterEach(async () => { if (root) { await act(async () => root.unmount()); root = null; } controller?.dispose(); controller = null; mock.reset(); });

test('only supported import specifiers; opt-in left-pane registration and disposal', async () => {
  const source = await readFile(new URL('../desktop/plugin.js', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => match[1]), ['@hermes/plugin-sdk', 'react']);
  assert.equal(plugin.id, 'hermes-t3sidebar'); assert.equal(plugin.name, plugin.id); assert.equal(plugin.defaultEnabled, false);
  const [manifest, packageJson, lock, yaml] = await Promise.all(['../dashboard/manifest.json', '../package.json', '../package-lock.json', '../plugin.yaml'].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
  assert.equal(JSON.parse(manifest).name, plugin.id); assert.equal(JSON.parse(manifest).label, plugin.name);
  assert.equal(JSON.parse(packageJson).name, plugin.id); assert.equal(JSON.parse(lock).name, plugin.id); assert.equal(JSON.parse(lock).packages[''].name, plugin.id);
  assert.equal(yaml.split('\n')[0], `name: ${plugin.id}`);
  assert.doesNotMatch(source, /setInterval|document\.|window\.|localStorage|__reactFiber|restartGateway/);
  plugin.register(mock.ctx);
  assert.equal(mock.control.contributions[0].data.placement, 'left');
  assert.equal(mock.control.contributions[0].title, 't3sidebar'); assert.equal(mock.control.settings.title, plugin.name);
  assert.equal(mock.control.contributions[0].id, 'sidebar'); assert.equal(typeof mock.control.settings.render, 'function');
  mock.control.disposers.forEach(fn => fn()); assert.equal(mock.control.listener, null);
});

test('waiting outranks native archives, pin, legacy completion, snoozed and working across compression aliases', () => {
  for (const state of ['active', 'settled', 'snoozed']) {
    const result = flow.buildSections([{ id: 'tip', archived: true, _lineage_root_id: 'root', _lineage_ids: ['old'] }], { sessions: { root: { state, pinned: true, wake_at: 9999 } } }, [
      { id: 'worker', session_key: 'tip', status: 'working' }, { id: 'approval', session_key: 'old', status: 'waiting' }
    ], { now: 100 });
    assert.equal(result.active[0].key, 'root'); assert.equal(result.active[0].status, 'waiting');
    assert.equal(Object.values(result).flat().length, 1);
  }
});

test('working and starting dim shelf; idle pins; snooze wake; native archives by activity', () => {
  const rows = ['work', 'start', 'pin', 'due', 'later', 's1', 's2'].map(id => ({ id, archived: id.startsWith('s') && id !== 'start', last_active: id === 's2' ? 40 : id === 's1' ? 30 : 0 }));
  const result = flow.buildSections(rows, { sessions: {
    pin: { state: 'active', pinned: true }, due: { state: 'snoozed', wake_at: 100 }, later: { state: 'snoozed', wake_at: 101 },
    s1: { state: 'settled', settled_at: 30 }, s2: { state: 'settled', settled_at: 40 }
  } }, [{ session_key: 'work', status: 'working' }, { session_key: 'start', status: 'starting' }], { now: 100 });
  assert.deepEqual(result.working.map(r => r.id), ['start', 'work']); assert.equal(result.pinned[0].id, 'pin');
  assert.equal(result.active[0].id, 'due'); assert.equal(result.active[0].woke, true); assert.equal(result.snoozed[0].id, 'later');
  assert.deepEqual(result.archived.map(r => r.id), ['s2', 's1']);
});

test('pins outrank working and starting, including running children, but not snoozes or archive/input safety', () => {
  const rows = [{ id: 'tip', _lineage_root_id: 'root', _lineage_ids: ['old'] }];
  for (const status of ['idle', 'working', 'starting']) for (const running_subagents of [0, 2]) {
    const live = [{ id: 'runtime', session_key: 'old', status, running_subagents }];
    for (const [state, wake_at, expected] of [['active', null, 'pinned'], ['settled', null, 'pinned'], ['snoozed', 101, 'snoozed'], ['snoozed', 100, 'pinned']]) {
      const metadata = { sessions: { root: { state, pinned: true, wake_at } } };
      const sections = flow.buildSections(rows, metadata, live, { now: 100 });
      const card = sections[expected][0];
      assert.equal(card?.key, 'root', `${status}/${running_subagents}/${state}/${wake_at}`);
      assert.equal(card.status, status !== 'idle' || running_subagents ? 'working' : 'idle');
      assert.equal(Object.values(sections).flat().length, 1);
      assert.equal(flow.buildSections([{ ...rows[0], archived: true }], metadata, live, { now: 100 }).archived[0]?.key, 'root');
      assert.equal(flow.buildSections(rows, metadata, [{ ...live[0], status: 'waiting' }], { now: 100 }).active[0]?.status, 'waiting');
      assert.equal(flow.buildSections(rows, metadata, live, { now: 100, runtimeKnown: false }).active[0]?.status, 'unknown');
    }
  }
});

test('unknown runtime never silently classifies idle or hides in settled', () => {
  const result = flow.buildSections([{ id: 's' }], { sessions: { s: { state: 'settled' } } }, [], { runtimeKnown: false });
  assert.equal(result.active[0].status, 'unknown'); assert.equal(result.archived.length, 0);
});

test('running subagents keep an idle parent Working across compression aliases and clear with the snapshot', () => {
  const rows = [{ id: 'tip', _lineage_root_id: 'root', _lineage_ids: ['root', 'old', 'tip'], last_active: 100 }];
  const metadata = { sessions: { root: { state: 'active', pinned: true } } };
  const live = [{ id: 'runtime-parent', session_key: 'old', status: 'idle', running_subagents: 2, last_active: 9999 }];
  let sections = flow.buildSections(rows, metadata, live);
  assert.equal(sections.pinned[0]?.key, 'root');
  assert.equal(sections.pinned[0]?.status, 'working');
  assert.equal(sections.pinned[0]?.activity, 100);
  metadata.sessions.root.pinned = false;
  assert.equal(flow.buildSections(rows, metadata, live).working[0]?.key, 'root');
  metadata.sessions.root.pinned = true;
  live[0].running_subagents = 1;
  assert.equal(flow.buildSections(rows, metadata, live).pinned[0]?.status, 'working');
  for (const count of [0, null, undefined, -1, '1', Infinity, 1.5]) {
    live[0].running_subagents = count;
    sections = flow.buildSections(rows, metadata, live);
    assert.equal(sections.working.length, 0, String(count));
    assert.equal(sections.pinned[0]?.key, 'root');
  }
  live[0].running_subagents = 1;
  assert.equal(flow.buildSections(rows, metadata, live, { runtimeKnown: false }).active[0]?.status, 'unknown');
});

test('waiting retains priority over running children and unrelated sessions cannot lend Working status', () => {
  const rows = [{ id: 'parent' }, { id: 'other' }], meta = { sessions: {} };
  const live = [{ session_key: 'parent', status: 'waiting', running_subagents: 3 }];
  const sections = flow.buildSections(rows, meta, live);
  assert.equal(sections.active.find(row => row.id === 'parent').status, 'waiting');
  assert.equal(sections.active.find(row => row.id === 'other').status, 'idle');
  assert.equal(sections.working.length, 0);
});

test('subagent lifecycle events refresh snapshots but streamed text does not fan out reads', async () => {
  plugin.register(mock.ctx);
  const scope = flow.captureScope(), key = [...flow.scopeKey(scope), 'runtime'];
  const draftKey = ['hermes-t3sidebar-drafts', scope.connectionId, scope.profile, scope.epoch, 'design'];
  mock.queryClient.setQueryData(key, { sessions: [] });
  mock.queryClient.setQueryData(draftKey, true);
  for (const type of ['subagent.text', 'subagent.thinking']) {
    mock.control.listener({ type });
    assert.equal(mock.queryClient.getQueryState(key).isInvalidated, false);
  }
  for (const type of ['subagent.start', 'subagent.complete']) {
    mock.control.listener({ type });
    await Promise.resolve();
    assert.equal(mock.queryClient.getQueryState(key).isInvalidated, true);
    assert.equal(mock.queryClient.getQueryState(draftKey).isInvalidated, false);
    mock.queryClient.setQueryData(key, { sessions: [] });
  }
  mock.control.disposers.forEach(fn => fn());
});

test('React reconstructs parent Working from child snapshots on remount and discards failed polls', async () => {
  mock.control.live.push({ id: 'runtime-design', session_key: 'design', status: 'idle', running_subagents: 1 });
  await mount();
  const section = () => row('design').closest('section').getAttribute('aria-label');
  assert.equal(section(), 'Working');
  assert.equal(row('design').querySelector('.sf-status').textContent, 'Working');
  await remount();
  assert.equal(section(), 'Working');
  mock.control.runtimeError = true; await refresh();
  assert.equal(section(), 'Ready');
  assert.equal(row('design').querySelector('.sf-status'), null);
  mock.control.runtimeError = false; mock.control.live.at(-1).running_subagents = 0; await refresh();
  assert.equal(section(), 'Ready');
  mock.control.live.at(-1).running_subagents = 2; await refresh();
  assert.equal(section(), 'Working');
  mock.control.live.at(-1).status = 'waiting'; await refresh();
  assert.equal(section(), 'Ready');
  assert.equal(row('design').querySelector('.sf-status').textContent, 'Input');
});

test('opening or resuming a stored session does not reset its activity or ordering', () => {
  const rows = [{ id: 'older', last_active: 100 }, { id: 'newer', last_active: 200 }];
  for (const status of ['idle', 'working', 'waiting']) {
    const sections = flow.buildSections(rows, { sessions: {} }, [{ id: 'runtime-older', session_key: 'older', status, last_active: 9999 }]);
    const older = Object.values(sections).flat().find(row => row.id === 'older');
    assert.equal(older.activity, 100);
    if (status === 'idle') assert.deepEqual(sections.active.map(row => row.id), ['newer', 'older']);
  }
  const next = flow.buildSections([{ id: 'older', last_active: 300 }, rows[1]], { sessions: {} }, []);
  assert.deepEqual(next.active.map(row => row.id), ['older', 'newer']);
});

test('waiting sorts first; ties stable; project filtering independent from grouping', () => {
  const result = flow.buildSections([{ id: 'z', cwd: '/a', title: 'Widget', last_active: 1000 }, { id: 'a', cwd: '/a', title: 'Widget', last_active: 1000 }, { id: 'wait', cwd: '/a', title: 'Widget', last_active: 1 }, { id: 'other', cwd: '/b' }], { sessions: {} }, [{ session_key: 'wait', status: 'waiting' }], { query: 'widget', project: '/a' });
  assert.deepEqual(result.active.map(r => r.id), ['wait', 'a', 'z']);
});

test('rich rows win RPC fallback; durable roots dedupe; orphan live sessions retained', () => {
  const rows = flow.mergeRows([{ id: 'tip', title: 'Rich', cwd: '/a', _lineage_root_id: 'root', _lineage_ids: ['old'] }], [{ id: 'tip', _lineage_root_id: 'root', title: 'Poor' }, { id: 'older' }], [{ session_key: 'old' }, { session_key: 'orphan', title: 'Live only' }]);
  assert.equal(rows.length, 3); assert.equal(rows[0].title, 'Rich'); assert.equal(rows[0]._limited, false); assert.equal(rows[1]._limited, true);
  assert.ok(flow.aliases(rows[0]).includes('old')); assert.equal(rows[2]._liveOnly, true);
});

test('relative timestamps and local future snooze validation', () => {
  assert.equal(flow.relative(940, 1000), '1m'); assert.equal(flow.relative(4600, 1000), 'in 1h'); assert.equal(flow.relative(null), '—');
  assert.equal(flow.seconds('2026-01-01T00:00:00Z'), 1767225600);
  const valid = flow.parseLocalWake('2030-01-01T12:00', new Date('2029-01-01').getTime()); assert.ok(valid > 0);
  assert.throws(() => flow.parseLocalWake('2029-02-30T12:00', 0), /does not exist/);
  assert.throws(() => flow.parseLocalWake('2020-01-01T12:00'), /future/);
  assert.throws(() => flow.parseLocalWake('invalid'), /Choose/);
  const presets = flow.snoozePresets(new Date('2026-10-23T17:00:00').getTime()); assert.equal(presets.length, 4);
  assert.equal(new Date(presets[2].wake_at * 1000).getHours(), 9);
});

test('scope keys separate same-profile sources and epochs; exact route required', () => {
  const a = { connectionId: 'a', profile: 'default', epoch: 1 }, b = { ...a, connectionId: 'b' };
  assert.deepEqual(flow.scopeKey(a), [plugin.id, 'a', 'default', 1]);
  assert.notDeepEqual(flow.scopeKey(a), flow.scopeKey(b)); assert.equal(flow.sameScope(a, b), false);
  assert.equal(flow.sameScope(a, { ...a, epoch: 2 }), false);
  assert.throws(() => flow.currentRoute(a, [{ ...b, targetProfile: 'default' }]), /unavailable/);
  assert.equal(flow.currentRoute({ ...a, connectionId: null }, []), null);
});

test('list uses only current source route and backend target profile', async () => {
  const scope = { connectionId: 'a', profile: 'alias', epoch: 1 }; let call;
  controller = flow.createController({ rest: async () => { throw new Error('companion unavailable'); } }, mock.queryClient, { capture: () => scope, routes: async () => [{ connectionId: 'a', profile: 'alias', targetProfile: 'actual' }, { connectionId: 'b', profile: 'default', targetProfile: 'default' }], host: { listPersistedSessions: async (...args) => { call = args; return { sessions: [] }; } } });
  await controller.list(scope); assert.deepEqual(call[1], { profile: 'actual', limit: 500 }); assert.equal(call[0].connectionId, 'a');
});

test('stale asynchronous reads rejected on source switch including ABA epoch', async () => {
  let current = { connectionId: 'a', profile: 'default', epoch: 1 }, finish;
  controller = flow.createController({ rest: () => new Promise(resolve => { finish = resolve; }) }, mock.queryClient, { capture: () => current });
  const promise = controller.metadata(current); current = { ...current, epoch: 3 }; finish({ version: 1, sessions: {} });
  await assert.rejects(promise, /Source\/profile changed/);
});

test('mutation confirms exact target readback; no optimistic or unconfirmed success', async () => {
  controller = flow.createController(mock.ctx); const scope = flow.captureScope();
  await controller.mutate(scope, 'weird/id', { action: 'settle' });
  assert.equal(mock.control.metadata.sessions['weird/id'].state, 'settled');
  const calls = mock.calls.filter(c => c[0] === 'rest'); assert.equal(calls[0][1], '/sessions/weird%2Fid'); assert.equal(calls[1][1], '/state');
  assert.equal(mock.queryClient.getQueryData([...flow.scopeKey(scope), 'metadata']).sessions['weird/id'].state, 'settled');
  mock.control.dropWrite = true; await assert.rejects(controller.mutate(scope, 'new-id', { action: 'settle' }), /did not confirm/);
});

test('Delete confirms before mutation, cancel is inert and errors remain retryable', async () => {
  await mount();
  const openDelete = async () => { await click(row('design').querySelector('[aria-label="Actions for Sidebar layout"]')); await click(button('Delete session')); };
  await openDelete();
  assert.equal($('[role=dialog]').getAttribute('aria-label'), 'Delete session?');
  assert.match($('[role=dialog]').textContent, /Sidebar layout.*cannot be undone/i);
  assert.equal(button('Delete').dataset.destructive, 'true');
  assert.equal(mock.calls.some(call => call[2] === 'session.mutate'), false);
  await click(button('Cancel')); assert.ok(row('design'));
  await openDelete(); mock.control.deleteError = true; await click(button('Delete'));
  assert.equal($('[role=dialog]').getAttribute('aria-label'), 'Delete session?');
  assert.match($('[role=alert]').textContent, /fixture delete unavailable/); assert.ok(row('design'));
  mock.control.deleteError = false; await click(button('Delete'));
  assert.equal(row('design'), null); assert.equal($('[role=dialog]'), null);
  assert.equal(mock.host.state.focusedStoredSessionId.get(), null);
  const writes = mock.calls.filter(call => call[2] === 'session.mutate');
  assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
  assert.deepEqual({ ...writes[0][3], request_id: 'retained' }, { session_id: 'design', request_id: 'retained', expected_revision: 0, expected_generation: 0, operation: 'delete', payload: {} });
  assert.ok(mock.calls.some(call => call[0] === 'new' && call[1].connectionId === 'source-a'));
});

test('Delete verifies every lineage ID and retries lost replies under the same identity', async () => {
  controller = flow.createController(mock.ctx); const scope = flow.captureScope();
  mock.control.live = [];
  const item = { ...mock.control.rows.find(row => row.id === 'tip'), status: 'idle' };
  mock.control.deleteLostReply = true;
  await assert.rejects(controller.delete(scope, item), /reply lost/);
  assert.equal(mock.control.rows.some(row => row.id === 'tip'), false);
  await controller.delete(scope, item);
  const calls = mock.calls.filter(call => call[2] === 'session.mutate');
  assert.deepEqual(calls[0], calls[1]); assert.equal(calls[0][3].session_id, 'root');
  for (const id of ['root', 'old', 'tip']) assert.ok(mock.calls.some(call => call[0] === 'rest' && call[1] === `/sessions/${id}/snapshot`));
});

test('Delete refuses busy or unsaved cards and catches work starting before confirmation', async () => {
  controller = flow.createController(mock.ctx); const scope = flow.captureScope();
  for (const item of [{ id: 'design', status: 'working' }, { id: 'design', status: 'unknown' }, { id: 'design', status: 'idle', _liveOnly: true }]) await assert.rejects(controller.delete(scope, item), /idle|unsaved/i);
  assert.equal(mock.calls.length, 0);
  mock.control.live.push({ id: 'runtime-design', session_key: 'design', status: 'idle', running_subagents: 1 });
  await assert.rejects(controller.delete(scope, { id: 'design', status: 'idle' }), /session_busy/);
  assert.ok(mock.control.rows.some(row => row.id === 'design'));
  assert.equal(mock.calls.some(call => call[2] === 'session.interrupt' || call[2] === 'session.close'), false);
});

test('Delete rejects dropped writes and wrong receipts instead of claiming success', async () => {
  for (const mode of ['drop', 'receipt']) {
    mock.reset(); controller = flow.createController(mock.ctx); const scope = flow.captureScope();
    if (mode === 'drop') mock.control.dropDelete = true;
    else mock.control.deleteResult = { session_id: 'foreign', operation: 'delete', revision: 1, execution_generation: 0, deleted_ids: ['foreign'] };
    await assert.rejects(controller.delete(scope, { id: 'design', status: 'idle' }), /still exists|exact session deletion/);
    assert.equal(mock.calls.some(call => call[0] === 'new'), false); controller.dispose();
  }
});

test('Delete validates snapshot owner, exact target and fences before mutation', async () => {
  for (const override of [{ profile: 'foreign' }, { session_id: 'foreign' }, { exists: null }, { runtime_revision: -1 }, { runtime_generation: null }]) {
    mock.reset(); controller = flow.createController(mock.ctx); mock.control.snapshotOverride = override;
    await assert.rejects(controller.delete(flow.captureScope(), { id: 'design', status: 'idle' }), /exact session deletion snapshot/);
    assert.equal(mock.calls.some(call => call[2] === 'session.mutate'), false); controller.dispose();
  }
});

test('Delete fences delayed snapshots and committed replies across source changes', async () => {
  for (const boundary of ['snapshot', 'reply']) {
    mock.reset(); const scope = flow.captureScope();
    const rest = async (...args) => { const result = await mock.ctx.rest(...args); if (boundary === 'snapshot' && args[0].endsWith('/snapshot')) mock.switchScope(); return result; };
    controller = flow.createController({ ...mock.ctx, rest });
    if (boundary === 'reply') mock.control.afterDelete = () => mock.switchScope();
    await assert.rejects(controller.delete(scope, { id: 'design', status: 'idle' }), /Source\/profile changed/);
    if (boundary === 'snapshot') assert.equal(mock.calls.some(call => call[2] === 'session.mutate'), false);
    assert.equal(mock.calls.some(call => call[0] === 'new'), false); controller.dispose();
  }
});

test('stale action never POSTs or opens another scope', async () => {
  controller = flow.createController(mock.ctx); const scope = flow.captureScope(); mock.switchScope();
  await assert.rejects(controller.mutate(scope, 'design', { action: 'settle' }), /Source\/profile changed/);
  await assert.rejects(controller.open(scope, { id: 'design' }), /Source\/profile changed/);
  assert.equal(mock.calls.length, 0);
});

test('old in-flight metadata cannot overwrite mutation; concurrent writers rejected', async () => {
  let finish; const rest = async (path, options) => path === '/state' && !options ? new Promise(resolve => { finish = resolve; }) : mock.ctx.rest(path, options);
  controller = flow.createController({ rest }); const scope = flow.captureScope(); const old = controller.metadata(scope); const oldFinish = finish;
  const write = controller.mutate(scope, 'design', { action: 'settle' }); await tick();
  await assert.rejects(controller.mutate(scope, 'readme', { action: 'settle' }), /still saving/);
  oldFinish({ version: 1, sessions: {} }); await assert.rejects(old, /Superseded/);
  finish(cloneState()); await write;
  assert.equal(mock.queryClient.getQueryData([...flow.scopeKey(scope), 'metadata']).sessions.design.state, 'settled');
});
function cloneState() { return JSON.parse(JSON.stringify(mock.control.metadata)); }

test('React mounts headerless Ready and Pinned, waiting stays Ready, dim working and native open', async () => {
  await mount(); assert.ok(row('approval')); assert.equal(row('approval').closest('section'), shelf('Ready'));
  assert.equal($('aside').getAttribute('aria-label'), plugin.name); assert.equal($('.sf-title'), null); assert.equal(shelf('Ready').querySelector('.sf-section-toggle'), null); assert.equal(shelf('Pinned').querySelector('.sf-section-toggle'), null);
  assert.equal($('.sf-scroll').firstElementChild, shelf('Pinned'));
  assert.equal(row('root').dataset.working, 'true'); assert.equal(row('pinned').closest('section'), shelf('Pinned'));
  assert.equal(row('snoozed').closest('section'), shelf('Snoozed')); assert.equal(row('archived').closest('section'), shelf('Archived'));
  await click(row('design').querySelector('.sf-open')); assert.ok(mock.calls.some(c => c[0] === 'open' && c[1] === 'design'));
  await click(button('New session')); assert.ok(button('New session in Synthetic Sidebar')); assert.equal(button('New session in Home'), undefined);
  assert.equal(mock.calls.some(c => c[0] === 'new'), false); assert.doesNotMatch(document.body.textContent, /native workspace selection/);
});

test('React search and exact project filter stay flat with keyboard navigation', async () => {
  await mount(); await input($('input[type=search]'), 'Sidebar'); assert.ok(row('design')); assert.equal(row('readme'), null);
  await input($('input[type=search]'), '');
  await click(button('Filter sessions')); await click(button('Filter by docs'));
  assert.ok(row('readme')); assert.equal(row('design'), null);
  assert.equal(button('Group by project'), undefined); assert.equal(button('Use flat list'), undefined); assert.equal($('.sf-group'), null);
  assert.equal(button('Show project details'), undefined); assert.equal($('.sf-row-detail'), null);
  const first = row('readme').querySelector('.sf-open'); first.focus();
  await act(async () => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  assert.equal(document.activeElement?.closest('[data-session-id]')?.dataset.sessionId, 'legacy');
});

test('context actions have decorative leading icons and Delete is marked destructive without bypassing confirmation', async () => {
  await mount(); await click(button('Actions for Sidebar layout'));
  const menu = $('.sf-menu'), actions = [...menu.querySelectorAll('.sf-menu-action')];
  assert.deepEqual(actions.map(action => action.getAttribute('aria-label') || action.querySelector('.sf-menu-label')?.textContent), ['Pin', 'Rename', 'Copy session ID', 'Delete session', 'Project']);
  for (const action of actions) {
    assert.equal(action.firstElementChild?.className, 'sf-menu-icon');
    assert.equal(action.firstElementChild?.getAttribute('aria-hidden'), 'true');
    assert.ok(action.firstElementChild?.querySelector('svg'));
  }
  assert.equal(button('Delete session').dataset.destructive, 'true');
  assert.equal(button('Pin').hasAttribute('data-destructive'), false);
  await click(button('Delete session'));
  assert.equal($('[role=dialog][aria-label="Delete session?"]') !== null, true);
  assert.equal(mock.calls.some(call => call[2] === 'session.mutate'), false, 'menu Delete still only opens confirmation');
});

test('a pinned working card keeps its Working status, stays undimmed and follows pin/snooze transitions', async () => {
  mock.control.metadata.sessions.root = { state: 'active', pinned: true };
  await mount();
  assert.equal(row('root').closest('section').getAttribute('aria-label'), 'Pinned');
  assert.equal(row('root').dataset.working, 'true');
  assert.equal(row('root').dataset.dimmed, 'false');
  assert.equal(row('root').querySelector('[data-status=working]')?.textContent, 'Working');
  mock.control.metadata.sessions.root = { state: 'snoozed', pinned: true, wake_at: Math.floor(Date.now() / 1000) + 3600 };
  await refresh(); assert.equal(row('root').closest('section').getAttribute('aria-label'), 'Snoozed');
  assert.equal(row('root').querySelector('[data-status=working]'), null);
  assert.equal(row('root').querySelector('.sf-snooze-time')?.textContent, '1h');
  mock.control.metadata.sessions.root = { state: 'active', pinned: true };
  await refresh(); assert.equal(row('root').closest('section').getAttribute('aria-label'), 'Pinned');
  await click(button('Actions for Runtime classification')); await click(button('Unpin'));
  assert.equal(row('root').closest('section').getAttribute('aria-label'), 'Working');
  await click(button('Actions for Runtime classification')); await click(button('Pin'));
  assert.equal(row('root').closest('section').getAttribute('aria-label'), 'Pinned');
  mock.control.live.find(item => item.id === 'runtime-worker').status = 'waiting';
  await refresh(); assert.equal(row('root').closest('section').getAttribute('aria-label'), 'Ready');
  assert.equal(row('root').querySelector('[data-status=input]')?.textContent, 'Input');
});

test('search keeps focus after its second character filters out the previously focused card', async () => {
  await mount();
  await act(async () => row('readme').querySelector('.sf-open').focus());
  const search = $('input[type=search]');
  await act(async () => search.focus());
  await input(search, 's');
  assert.ok(row('readme')); assert.equal(document.activeElement === search, true);
  await input(search, 'si');
  assert.equal(row('readme'), null);
  assert.equal($('input[type=search]') === search, true, 'search was not remounted');
  assert.equal(document.activeElement === search, true, 'filtering must not move focus to a card or composer');
  await input(search, 'sidebar'); assert.equal(document.activeElement === search, true);
  await input(search, 'no such session'); assert.equal(document.activeElement === search, true);
  await input(search, ''); assert.equal(document.activeElement === search, true);
});

test('a background refresh cannot steal composer focus when an earlier sidebar card disappears', async () => {
  await mount();
  const composer = document.createElement('textarea'); document.body.append(composer);
  try {
    await act(async () => row('readme').querySelector('.sf-open').focus());
    await act(async () => composer.focus());
    mock.control.rows = mock.control.rows.filter(item => item.id !== 'readme');
    await refresh();
    assert.equal(row('readme'), null);
    assert.equal(document.activeElement === composer, true);
  } finally { composer.remove(); }
});

test('card Snooze opens time choices and confirms organization without opening the session', async () => {
  await mount();
  await click(row('design').querySelector('[aria-label="Snooze session"]'));
  assert.equal($('[role=dialog]').getAttribute('aria-label'), 'Snooze session');
  assert.equal($('[role=dialog]').textContent.includes('Settle'), false);
  await click(button('In 1 hour'));
  assert.equal(row('design').closest('section'), shelf('Snoozed'));
  assert.equal($('[role=dialog]'), null);
  assert.equal(mock.calls.some(call => call[0] === 'open'), false);
  assert.equal(button('Undo'), undefined); assert.equal($('.sf-undo'), null);
  await click(button('Actions for Sidebar layout')); await click(button('Restore to Ready'));
  assert.equal(row('design').closest('section'), shelf('Ready'));
  assert.equal(row('approval').querySelector('[aria-label="Snooze session"]').disabled, false);
});

test('snooze countdown rounds to one whole unit with no left suffix or past durations', () => {
  for (const [seconds, expected] of [[-1, '0m'], [0, '0m'], [1, '1m'], [60, '1m'], [61, '1m'], [89, '1m'], [90, '2m'],
    [3599, '1h'], [3600, '1h'], [5399, '1h'], [5400, '2h'], [86399, '1d'], [86400, '1d'], [93600, '1d'], [129600, '2d'], [2 * 86400 + 16 * 3600, '3d']]) {
    assert.equal(flow.snoozeRemaining(100 + seconds, 100), expected);
    assert.match(expected, /^\d+[mhd]$/);
  }
});

for (const status of ['working', 'starting', 'running children', 'waiting', 'unknown']) test(`snooze and Unsnooze allow ${status} without native execution changes; Archive remains guarded`, async () => {
  const worker = mock.control.live.find(item => item.id === 'runtime-worker');
  worker.status = status === 'running children' ? 'idle' : status === 'unknown' ? 'working' : status;
  if (status === 'running children') worker.running_subagents = 1;
  if (status === 'unknown') mock.control.runtimeError = true;
  const before = structuredClone(mock.control.live);
  await mount();
  assert.equal(row('root').querySelector('[aria-label="Snooze session"]').disabled, false);
  assert.equal(row('root').querySelector('[aria-label="Archive session"]').disabled, true);
  await click(row('root').querySelector('[aria-label="Snooze session"]'));
  assert.equal(button('In 1 hour').disabled, false);
  assert.equal($('[aria-label="Custom snooze date and time"]').disabled, false);
  assert.equal(button('Unsnooze'), undefined);
  await click(button('In 1 hour'));
  assert.equal(mock.control.metadata.sessions.root.state, 'snoozed');
  if (!['waiting', 'unknown'].includes(status)) {
    assert.equal(row('root').closest('section'), shelf('Snoozed'));
    const countdown = row('root').querySelector('.sf-snooze-time');
    assert.equal(countdown.textContent, '1h');
    assert.equal(countdown.firstElementChild.tagName.toLowerCase(), 'svg');
    assert.equal(countdown.firstElementChild.getAttribute('aria-hidden'), 'true');
    assert.equal(countdown.lastElementChild.className, 'sf-snooze-duration');
    assert.equal(row('root').querySelector('.sf-status'), null, 'countdown replaces Working or attention badge on the Snoozed shelf');
  } else {
    assert.equal(row('root').closest('section'), shelf('Ready'), 'input/unknown safety remains visible');
    assert.equal(row('root').querySelector('.sf-snooze-time'), null);
  }
  await click(row('root').querySelector('[aria-label="Snooze session"]'));
  assert.equal($('form > button:not(:disabled)').textContent, 'Unsnooze');
  const information = all('form > .sf-snooze-info');
  assert.equal(information.length, 2);
  assert.equal(information[0].disabled && information[1].disabled, true);
  assert.match(information[0].textContent, /^\d+d \d+h \d+min left$/);
  assert.equal(information[1].textContent, new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(mock.control.metadata.sessions.root.wake_at * 1000)));
  assert.equal(button('Unsnooze').className.includes('sf-unsnooze'), true);
  await click(button('Unsnooze'));
  assert.equal(mock.control.metadata.sessions.root.state, 'active');
  assert.equal(mock.control.metadata.sessions.root.wake_at, null);
  assert.equal($('[role=dialog]'), null);
  assert.equal(row('root').querySelector('.sf-snooze-time'), null);
  assert.equal(row('root').closest('section'), shelf(['waiting', 'unknown'].includes(status) ? 'Ready' : 'Working'));
  assert.deepEqual(mock.control.live, before);
  assert.equal(mock.calls.some(call => call[0] === 'requestProfile' || call[0] === 'open' || call[0] === 'new'), false);
});

test('Unsnooze only dismisses and removes the countdown after exact backend confirmation', async () => {
  await mount();
  await click(row('snoozed').querySelector('[aria-label="Snooze session"]'));
  mock.control.dropWrite = true;
  await click(button('Unsnooze'));
  assert.match($('[role=alert]').textContent, /did not confirm/);
  assert.ok($('[role=dialog]'));
  assert.ok(row('snoozed').querySelector('.sf-snooze-time'));
  mock.control.dropWrite = false;
  await click(button('Unsnooze'));
  assert.equal($('[role=dialog]'), null);
  assert.equal(row('snoozed').closest('section'), shelf('Ready'));
  assert.equal(row('snoozed').querySelector('.sf-snooze-time'), null);
});

test('snooze menu actions use the requested leading icons while both disabled information rows stay icon-free', async () => {
  await mount();
  await click(row('snoozed').querySelector('[aria-label="Snooze session"]'));
  const actions = [...$('[role=dialog]').querySelectorAll('.sf-menu-action')];
  assert.deepEqual(actions.map(node => node.querySelector('[data-codicon]')?.getAttribute('data-codicon') || node.querySelector('[data-icon]')?.getAttribute('data-icon')),
    ['discard', 'Clock', 'Clock', 'Sun', 'calendar']);
  for (const node of actions) {
    assert.equal(node.firstElementChild.className, 'sf-menu-icon');
    assert.equal(node.firstElementChild.getAttribute('aria-hidden'), 'true');
    assert.equal(node.lastElementChild.className, 'sf-menu-label');
  }
  const info = [...$('[role=dialog]').querySelectorAll('.sf-snooze-info')];
  assert.equal(info.length, 2);
  assert.equal(info.every(node => node.disabled && !node.querySelector('.sf-menu-icon,svg,[data-codicon]')), true);
});

test('fourth snooze option persists next Monday at 09:00 without a toast or opening a session', async () => {
  await mount();
  const wake = flow.snoozePresets()[3].wake_at;
  await click(row('design').querySelector('[aria-label="Snooze session"]'));
  assert.deepEqual([...$('[role=dialog]').querySelectorAll('form > button')].map(node => node.textContent),
    ['In 1 hour', 'In 3 hours', 'Tomorrow at 9:00', 'Next Monday at 9:00']);
  await click(button('Next Monday at 9:00'));
  assert.equal(mock.control.metadata.sessions.design.wake_at, wake);
  assert.equal(row('design').closest('section'), shelf('Snoozed'));
  assert.equal($('[role=dialog]'), null); assert.equal($('.sf-undo'), null);
  assert.equal(button('Undo'), undefined); assert.equal(button('Dismiss undo'), undefined);
  assert.equal(mock.calls.some(call => call[0] === 'open'), false);
});

test('menu triggers and their owning card retain open state until dismissal or successful action', async () => {
  await mount();
  for (const label of ['Filter sessions', 'New session']) {
    const trigger = button(label);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    await click(trigger); assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    await act(async () => $('[role=dialog]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  }
  const trigger = row('design').querySelector('[aria-label="Snooze session"]');
  await click(trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true'); assert.equal(row('design').dataset.menuOpen, 'true');
  mock.control.dropWrite = true;
  await click(button('In 1 hour'));
  assert.match($('[role=alert]').textContent, /did not confirm/);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true'); assert.equal(row('design').dataset.menuOpen, 'true');
  mock.control.dropWrite = false;
  await click(button('Close session actions'));
  assert.equal(trigger.getAttribute('aria-expanded'), 'false'); assert.equal(row('design').dataset.menuOpen, 'false');
  await click(button('Actions for Sidebar layout'));
  assert.equal(row('design').dataset.menuOpen, 'true');
  await click(button('Pin'));
  assert.equal(row('design').dataset.menuOpen, 'false');
});

test('React archives and unarchives without Undo; archive-and-advance opens next', async () => {
  await mount(); await click(row('design').querySelector('[aria-label="Archive session"]'));
  assert.equal(row('design').closest('section'), shelf('Archived')); assert.equal(button('Undo'), undefined);
  await click(row('design').querySelector('[aria-label="Unarchive session"]')); assert.equal(row('design').closest('section'), shelf('Ready'));
  assert.equal(button('Undo'), undefined);
  await act(async () => row('design').querySelector('.sf-open').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))); await tick();
  assert.equal(row('design').closest('section'), shelf('Archived'));
  assert.ok(mock.calls.some(c => c[0] === 'open' && c[1] === 'approval'));
});

test('React hover snooze preset and custom validation, context Restore', async () => {
  await mount(); await act(async () => row('design').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))); await tick();
  assert.ok($('[role=dialog]')); assert.equal(button('In 1 hour'), undefined);
  await click(button('Close session actions')); await click(row('design').querySelector('[aria-label="Snooze session"]')); await click(button('In 1 hour'));
  assert.equal(row('design').closest('section'), shelf('Snoozed'));
  await click(button('Actions for Sidebar layout')); await click(button('Restore to Ready')); assert.equal(row('design').closest('section'), shelf('Ready'));
  await click(row('design').querySelector('[aria-label="Snooze session"]')); await input($('input[type=datetime-local]'), '2020-01-01T12:00');
  assert.equal(button('Snooze until chosen time'), undefined);
  await click(button('Apply custom snooze')); assert.match($('[role=alert]').textContent, /future/);
  await input($('input[type=datetime-local]'), '2030-01-01T12:00');
  await act(async () => $('input[type=datetime-local]').closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await tick();
  assert.equal(row('design').closest('section'), shelf('Snoozed'));
});

test('React waiting stays in headerless Ready and cannot be settled; secondary sections collapse', async () => {
  await mount(); assert.equal(button('Active (3)'), undefined); assert.ok(row('approval'));
  assert.equal(row('approval').querySelector('[aria-label="Archive session"]').disabled, true);
  await click(button('Actions for Approval request'));
  assert.equal([...$('[role=dialog]').querySelectorAll('button')].some(node => /^(?:Archive|Snooze)/.test(node.textContent)), false);
  await click(button('Close session actions')); await click(button('Archived (1)')); assert.equal(row('archived'), null);
});

test('React runtime failure shows unknown without flooding Ready with native archives', async () => {
  mock.control.runtimeError = true; await mount();
  assert.match(document.body.textContent, /Runtime status unavailable/); assert.equal(row('archived').closest('section'), shelf('Archived'));
  assert.match(row('archived').querySelector('.sf-open').getAttribute('aria-label'), /status unknown/);
});

test('React missing backend is read-only without local fallback; list errors visible', async () => {
  mock.control.backendMissing = true; await mount(); assert.match(document.body.textContent, /Read-only browsing/);
  assert.equal(row('design').querySelector('[aria-label="Archive session"]').disabled, true);
  await click(row('design').querySelector('.sf-open')); assert.ok(mock.calls.some(c => c[0] === 'open'));
  mock.control.listError = true; await refresh(); assert.match(document.body.textContent, /Session list failed/);
});

test('React older browsing uses bounded rich companion pages, never legacy RPC', async () => {
  mock.control.rows = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, title: `Recent ${i}` }));
  mock.control.extra = [{ id: 'older', title: 'Older session', cwd: '/older', git_branch: 'main' }]; await mount();
  assert.equal(row('older'), null); await click(button('Browse older sessions'));
  assert.ok(row('older')); assert.ok(mock.calls.some(c => c[0] === 'rest' && c[1] === '/sessions?offset=500&limit=500'));
  assert.equal(button('Browse older sessions'), undefined); assert.ok(!mock.calls.some(c => c[0] === 'session.list'));
});

test('unknown project data is not mislabeled as detached by the project filter', () => {
  const result = flow.buildSections([{ id: 'unknown', _limited: true }, { id: 'detached', cwd: '' }], { sessions: {} }, [], { project: '' });
  assert.deepEqual(result.active.map(row => row.id), ['detached']);
});

test('empty-session labels require affirmative zero messages and never infer empty lineage history', () => {
  for (const title of [undefined, null, '', '  ', 'Untitled Session', '  untitled session  ', 'UNTITLED SESSION']) {
    assert.equal(flow.isEmptySession({ id: 'empty', title, preview: '  ', message_count: 0 }), true);
  }
  for (const row of [
    { message_count: undefined }, { message_count: null }, { message_count: '0' }, { message_count: -1 }, { message_count: 1 }, { message_count: Infinity },
    { message_count: 0, title: 'Actual project notes' }, { message_count: 0, preview: 'A user message' },
    { message_count: 0, _lineage_root_id: 'ancestor' }, { message_count: 0, _lineage_ids: ['ancestor', 'empty'] }, { message_count: 0, resolved_id: 'next-tip' }
  ]) assert.equal(flow.isEmptySession({ id: 'empty', ...row }), false, JSON.stringify(row));
  assert.equal(flow.isEmptySession({ id: 'empty', message_count: 0, _lineage_ids: ['empty'] }), true);
  assert.equal(flow.isEmptySession({ id: 'empty' }, [{ message_count: 0 }]), true);
  assert.equal(flow.isEmptySession({ id: 'empty', message_count: 5 }, [{ message_count: 0 }]), false, 'stored history overrides runtime zero');
  assert.equal(flow.isEmptySession({ id: 'empty', message_count: 0 }, [{ message_count: 1 }]), false, 'runtime content overrides stale zero');
  assert.equal(flow.isEmptySession({ id: 'empty' }, [{ message_count: 0, title: 'Real live title' }]), false);
});

test('empty-session runtime evidence must match the qualified row and be available', () => {
  const rows = [{ id: 'fresh', title: 'Untitled Session' }, { id: 'unknown' }, { id: 'history', message_count: 3 }];
  const live = [{ session_key: 'fresh', status: 'idle', message_count: 0 }, { session_key: 'history', status: 'idle', message_count: 0 }];
  const sections = flow.buildSections(rows, { sessions: {} }, live);
  assert.deepEqual(sections.active.map(row => [row.id, row.newSession]).sort(), [['fresh', true], ['history', false], ['unknown', false]]);
  assert.ok(flow.buildSections(rows, { sessions: {} }, live, { runtimeKnown: false }).active.every(row => !row.newSession));
  assert.equal(flow.buildSections(rows, { sessions: {} }, live, { query: 'New session' }).active[0].id, 'fresh');
});

test('confirmed empty cards use New session consistently and retain genuine projects and later history', async () => {
  mock.control.rows = [
    { id: 'empty', title: 'Untitled Session', message_count: 0 },
    { id: 'project-empty', message_count: 0, cwd: '/docs', project: { name: 'Docs', icon: 'tools' } },
    { id: 'unknown', title: 'Untitled Session' },
    { id: 'content', message_count: 0, preview: 'Existing conversation' },
    { id: 'named', message_count: 0, title: 'Important notes' },
    { id: 'compressed', message_count: 0, _lineage_root_id: 'ancestor', _lineage_ids: ['ancestor', 'compressed'] }
  ];
  mock.control.live = []; mock.control.metadata = { version: 1, sessions: {} };
  await mount();
  const fresh = row('empty');
  assert.equal(fresh.querySelector('.sf-row-title').textContent, 'New session');
  assert.equal(fresh.querySelector('.sf-open').getAttribute('aria-label'), 'New session');
  assert.match(fresh.querySelector('.sf-open').title, /^New session\n/);
  assert.equal(fresh.querySelector('.sf-project-name'), null);
  assert.ok(fresh.querySelector('[aria-label="Actions for New session"]'));
  assert.equal(row('project-empty').querySelector('.sf-project-name').textContent, 'Docs');
  for (const id of ['unknown', 'content', 'named', 'ancestor']) {
    assert.notEqual(row(id).querySelector('.sf-row-title').textContent, 'New session', id);
    assert.equal(row(id).querySelector('.sf-project-name').textContent, 'Project unavailable', id);
  }
  await click(fresh.querySelector('[aria-label="Actions for New session"]'));
  assert.equal($('[role=dialog] .sf-menu-title').textContent, 'New session');
  await click(button('Pin')); assert.equal(row('empty').closest('section'), shelf('Pinned'));
  assert.equal($('.sf-undo'), null); assert.equal(button('Undo'), undefined);
  Object.assign(mock.control.rows[0], { message_count: 1, title: 'First task', preview: 'A real message' }); await refresh();
  assert.equal(row('empty').querySelector('.sf-row-title').textContent, 'First task');
});

test('project filter opens direct native-icon choices, marks selection and restores the default icon', async () => {
  for (const row of mock.control.rows.filter(item => item.cwd === '/projects/docs')) row.project = { name: 'Docs', icon: 'tools', color: '#123456' };
  mock.control.rows.push({ id: 'fallback', cwd: '/unregistered/folder' }, { id: 'unknown' });
  await mount();
  const trigger = button('Filter sessions');
  assert.equal(trigger.dataset.filtered, 'false'); assert.equal(trigger.querySelector('.sf-project-icon'), null);
  const defaultIcon = trigger.querySelector('path').getAttribute('d');
  await click(trigger);
  assert.equal($('[role=dialog]').getAttribute('aria-label'), 'Session filters');
  assert.equal($('select'), null); assert.equal(button('Refresh sessions'), undefined);
  assert.equal(button('All projects').getAttribute('aria-pressed'), 'true');
  assert.equal(button('Filter by Docs').textContent, 'Docs');
  assert.equal(button('Filter by /unregistered/folder').textContent, '/unregistered/folder');
  assert.equal(button('Filter by No project'), undefined, 'unknown workspace is not a detached project');
  assert.ok(button('Filter by Docs').querySelector('[data-codicon="tools"]'));
  assert.equal(all('[role=dialog] [aria-label="Filter by Docs"]').length, 1);
  await click(button('Filter by Docs')); assert.equal($('[role=dialog]'), null);
  assert.equal(trigger.dataset.filtered, 'true'); assert.equal(trigger.title, 'Filter sessions: Docs');
  assert.ok(trigger.querySelector('.sf-project-icon [data-codicon="tools"]'));
  assert.equal(trigger.querySelector('.sf-project-icon').style.color, 'rgb(18, 52, 86)');
  assert.ok(row('readme')); assert.equal(row('design'), null);
  await click(trigger); assert.equal(button('Filter by Docs').getAttribute('aria-pressed'), 'true');
  assert.equal(button('All projects').getAttribute('aria-pressed'), 'false');
  await click(button('All projects')); assert.equal($('[role=dialog]'), null);
  assert.equal(trigger.dataset.filtered, 'false'); assert.equal(trigger.title, 'Filter sessions');
  assert.equal(trigger.querySelector('path').getAttribute('d'), defaultIcon); assert.ok(row('design'));
});

test('project filter uses emoji glyphs and cwd fallbacks and resets on source changes', async () => {
  mock.control.rows = [{ id: 'emoji', cwd: '/emoji', project: { name: 'Emoji project', icon: '🌿' } }, { id: 'fallback', cwd: '/only/path' }];
  mock.control.live = []; await mount();
  await click(button('Filter sessions')); await click(button('Filter by Emoji project'));
  assert.equal(button('Filter sessions').querySelector('.sf-project-icon').textContent, '🌿');
  await click(button('Filter sessions')); await click(button('Filter by /only/path'));
  assert.equal(button('Filter sessions').title, 'Filter sessions: /only/path');
  assert.ok(button('Filter sessions').querySelector('[data-codicon="folder"]'));
  assert.ok(row('fallback')); assert.equal(row('emoji'), null);
  await act(async () => mock.switchScope('source-b')); await tick(); await tick();
  assert.equal(button('Filter sessions').dataset.filtered, 'false'); assert.ok(row('emoji'));
});

test('scope change after POST prevents wrong-source readback or cache publication', async () => {
  let scope = { connectionId: 'a', profile: 'default', epoch: 1 }; const original = { ...scope }; const paths = [];
  controller = flow.createController({ rest: async (path, options) => { paths.push(path); scope = { ...scope, connectionId: 'b', epoch: 2 }; return { version: 1, sessions: {} }; } }, mock.queryClient, { capture: () => scope });
  await assert.rejects(controller.mutate(original, 'design', { action: 'settle' }), /Source\/profile changed/);
  assert.deepEqual(paths, ['/sessions/design']); assert.equal(mock.queryClient.getQueryData([...flow.scopeKey(original), 'metadata']), undefined);
});

test('React route switch resets scoped metadata without Undo or cross-source cache collision', async () => {
  await mount(); await click(row('design').querySelector('[aria-label="Snooze session"]')); await click(button('In 1 hour')); assert.equal(button('Undo'), undefined);
  await act(async () => { mock.control.metadata = { version: 1, sessions: {} }; mock.switchScope('source-b', 'default'); }); await tick(); await tick();
  assert.equal(button('Undo'), undefined); assert.equal(row('design').closest('section'), shelf('Ready'));
  const keys = mock.queryClient.getQueryCache().getAll().map(q => q.queryKey); assert.ok(keys.some(key => key[1] === 'source-b'));
});

test('async route discovery fences list/open/new across switches and ABA', async () => {
  for (const method of ['list', 'open', 'newChat']) {
    for (const aba of [false, true]) {
      const original = { connectionId: 'a', profile: 'default', epoch: 1 }; let current = original, finish; const effects = [];
      const c = flow.createController({ rest: async () => { effects.push('rest'); } }, mock.queryClient, {
        capture: () => current, routes: () => new Promise(resolve => { finish = resolve; }),
        host: { listPersistedSessions: () => effects.push('list'), openSession: () => effects.push('open'), newChat: () => effects.push('new') }
      });
      const pending = c[method](original, { id: 'same-id' });
      current = aba ? { ...original, epoch: 3 } : { ...original, connectionId: 'b', epoch: 2 };
      finish([{ connectionId: 'a', profile: 'default' }]);
      await assert.rejects(pending, /Source\/profile changed/); assert.deepEqual(effects, []); c.dispose();
    }
  }
});

test('open/new preserve exact source route despite same profile and stored id collisions', async () => {
  const scope = { connectionId: 'a', profile: 'alias', epoch: 1 };
  const route = { connectionId: 'a', profile: 'alias', targetProfile: 'actual', mode: 'remote' }, calls = [];
  const c = flow.createController({}, mock.queryClient, { capture: () => scope,
    routes: async () => [{ ...route, connectionId: 'b' }, route],
    host: { openSession: async (...args) => calls.push(args), newChat: (...args) => calls.push(args) } });
  await c.open(scope, { id: 'root', resolved_id: 'tip' }); await c.newChat(scope);
  assert.deepEqual(calls, [['tip', { route, profile: 'alias', intent: 'in-place' }], [route]]); c.dispose();
});

test('foreign runtime profile cannot inject rows or contaminate matching stored id', async () => {
  mock.control.runtimeProfile = 'other';
  mock.control.live = [{ session_key: 'design', status: 'waiting' }, { session_key: 'foreign', status: 'working' }];
  await mount(); assert.equal(row('foreign'), null);
  assert.match(row('design').textContent, /\?/); assert.doesNotMatch(row('design').textContent, /Waiting/);
  assert.ok(!mock.calls.some(c => c[0] === 'session.active_list'));
});

test('focused stored tile identity, not runtime id, selects row only for matching owner', async () => {
  await mount(); assert.equal(row('design').dataset.current, 'true');
  await act(async () => { mock.host.state.focusedSessionOwner.set({ connectionId: 'foreign', profile: 'default' }); });
  assert.equal(row('design').dataset.current, 'false');
  await act(async () => {
    mock.host.state.focusedSessionOwner.set({ connectionId: 'source-a', profile: 'default' });
    mock.host.state.focusedStoredSessionId.set('old');
  });
  assert.equal(row('root').dataset.current, 'true'); assert.equal(row('design').dataset.current, 'false');
});

test('search reveals collapsed shelf hits and preserves collapsed preference on clearing', async () => {
  await mount(); await click(button('Working (1)')); assert.equal(row('root'), null);
  await input($('input[type=search]'), 'Runtime classification'); assert.ok(row('root'));
  assert.doesNotMatch(document.body.textContent, /No matching sessions/);
  await input($('input[type=search]'), ''); assert.equal(row('root'), null);
});

test('501st organized session survives remount and keeps rich project filtering after due wake', async () => {
  mock.control.rows = Array.from({ length: 500 }, (_, i) => ({ id: `recent${i}`, title: `Recent ${i}` }));
  mock.control.extra = [{ id: 'old-tip', _lineage_root_id: 'old-root', _lineage_ids: ['old-root', 'old-tip'], title: 'Old project session', cwd: '/old-project', git_branch: 'retained' }];
  await mount(); await click(button('Browse older sessions'));
  await click(row('old-root').querySelector('[aria-label="Archive session"]'));
  await act(async () => root.unmount()); root = null; controller.dispose(); mock.queryClient.clear();
  await mount(); assert.equal(row('old-root').closest('section'), shelf('Archived'));
  await click(row('old-root').querySelector('[aria-label="Unarchive session"]'));
  mock.control.metadata.sessions['old-root'] = { state: 'snoozed', pinned: false, wake_at: 1, settled_at: null, updated_at: 1 };
  await refresh(); assert.equal(row('old-root').closest('section'), shelf('Ready'));
  await click(button('Filter sessions')); await click(button('Filter by /old-project'));
  assert.ok(row('old-root')); assert.equal(all('.sf-row').length, 1);
});

test('SDK fallback below the limit reports loaded and available counts, not a cap', async () => {
  mock.control.sessionsMissing = true; mock.control.total = 270; await mount();
  assert.ok(row('design'));
  assert.match(document.body.textContent, /Read-only SDK browsing: \d+ loaded of 270 available/);
  assert.doesNotMatch(document.body.textContent, /capped at/);
  assert.equal(button('Browse older sessions'), undefined);
});

test('SDK fallback keeps 500 rich rows and discloses unavailable older organized recovery', async () => {
  mock.control.sessionsMissing = true; mock.control.total = 900; await mount();
  assert.ok(row('design')); assert.match(document.body.textContent, /capped at 500 of 900/);
  assert.equal(button('Browse older sessions'), undefined);
});


test('card metadata uses native project, provider and token totals without model inference', async () => {
  mock.control.rows[1].project.icon = '⚙';
  await mount();
  const card = row('design');
  assert.equal(card.querySelector('.sf-project-icon').textContent, '⚙');
  assert.equal(card.querySelector('.sf-project-name').textContent, 'hermes-t3sidebar');
  assert.equal(card.querySelector('.sf-token').textContent, '1.5K');
  assert.ok(card.querySelector('[data-provider-mark="openai-codex"]'));
  assert.deepEqual([...row('pinned').querySelector('.sf-project').children].map(el => el.className), ['sf-project-icon', 'sf-pin', 'sf-project-name']);
  assert.equal(flow.compactTokens({ input_tokens: 1000, output_tokens: 250 }), '1.3K');
  assert.equal(flow.compactTokens({ total_tokens: 0 }), '0');
  assert.equal(flow.compactTokens({ total_tokens: null, input_tokens: null, output_tokens: null }), '—');
});

test('native project icon identifiers render as Codicons while emoji and pin order survive', async () => {
  mock.control.rows[1].project.icon = 'tools';
  mock.control.rows[1].project.color = '#123456';
  mock.control.rows[2].project = { name: 'Home', is_home: true, icon: null };
  await mount();
  assert.ok(row('design').querySelector('.sf-project-icon [data-codicon="tools"]'));
  assert.equal(row('design').querySelector('.sf-project-icon').textContent, '');
  assert.ok(row('readme').querySelector('.sf-project-icon [data-codicon="home"]'));
  assert.deepEqual([...row('pinned').querySelector('.sf-project').children].map(el => el.className), ['sf-project-icon', 'sf-pin', 'sf-project-name']);
});

test('Working, Snoozed and Archived share dimming but Ready attention does not', async () => {
  await mount();
  for (const id of ['root', 'snoozed', 'archived']) assert.equal(row(id).dataset.dimmed, 'true', id);
  for (const id of ['approval', 'design', 'pinned']) assert.equal(row(id).dataset.dimmed, 'false', id);
});

test('missing project/provider/tokens remain neutral even when model resembles a provider', async () => {
  Object.assign(mock.control.rows[1], { project: null, provider: null, model: 'openai/gpt-fixture', total_tokens: null, input_tokens: null, output_tokens: null });
  await mount(); const card = row('design');
  assert.equal(card.querySelector('.sf-project-name').textContent, 'Project unavailable');
  assert.equal(card.querySelector('.sf-provider') === null, true);
  assert.equal(card.querySelector('.sf-token').textContent, '—');
  assert.equal(card.querySelector('[data-provider-mark]'), null);
});

test('provider icons stay absent until a supported concrete provider arrives and clear when it is lost', async () => {
  mock.control.rows[1].provider = null;
  await mount();
  for (const provider of [null, '', 'auto', 'unknown', 'unsupported-provider', 'constructor', '__proto__', 'openai-codex', 'anthropic', 'gemini', null]) {
    mock.control.rows[1].provider = provider;
    await refresh();
    const mark = row('design').querySelector('.sf-provider');
    if (['openai-codex', 'anthropic', 'gemini'].includes(provider)) {
      assert.equal(mark.getAttribute('aria-label'), `Provider: ${provider}`);
      assert.ok(mark.querySelector(`[data-provider-mark="${provider}"]`));
    } else assert.equal(mark === null, true, `no placeholder or spacer for ${provider}`);
    assert.equal(row('design').querySelector('.sf-token').textContent, '1.5K');
  }
});

test('cron excluded from recent, extra, organized, runtime and SDK fallback rows', async () => {
  const cron = { id: 'cron-fixture', title: 'Do not display', source: 'cron' };
  assert.deepEqual(flow.mergeRows([cron], [{ ...cron, id: 'extra' }], [{ ...cron, session_key: 'live' }]), []);
  assert.deepEqual(Object.values(flow.buildSections([cron], { sessions: { 'cron-fixture': { state: 'settled', pinned: true } } }, [])).flat(), []);
  mock.control.rows.push(cron); mock.control.sessionsMissing = true; await mount(); assert.equal(row('cron-fixture'), null);
});

test('Pinned absent when empty while Ready and all secondary categories remain', async () => {
  mock.control.metadata.sessions.pinned.pinned = false; await mount();
  assert.equal(shelf('Pinned'), null);
  for (const name of ['Ready', 'Working', 'Snoozed', 'Archived']) assert.ok(shelf(name));
});

test('public native tree always includes synthetic Home and expands multiple folder paths', async () => {
  mock.control.projects = [{ id: 'p_multi', label: 'Multi', path: null, icon: 'tools', color: '#123456', repos: [{ path: '/fixture/one' }, { path: '/fixture/two' }] }];
  controller = flow.createController(mock.ctx); const result = await controller.projects(flow.captureScope());
  assert.deepEqual(result.projects[0], { id: '__no_project__', name: 'Home', path: null, isNoProject: true });
  assert.deepEqual(result.projects.slice(1).map(p => p.path), ['/fixture/one', '/fixture/two']);
  assert.ok(result.projects.slice(1).every(p => p.icon === 'tools' && p.color === '#123456'));
  assert.equal(mock.calls.find(c => c[0] === 'requestProfile')[2], 'projects.tree');
});

test('new-session picker renders native project icons without Home or its warning', async () => {
  mock.control.projects = [{ id: 'p_infra', label: 'Infra', path: '/fixture/infra', icon: 'tools', color: '#123456' }];
  await mount(); await click(button('New session'));
  const infra = button('New session in Infra');
  assert.ok(infra.querySelector('.sf-project-icon [data-codicon="tools"]'));
  assert.equal(infra.textContent, 'Infra');
  assert.equal(button('New session in Home'), undefined);
  assert.doesNotMatch($('[role=dialog]').textContent, /Home|detached|unavailable/);
  assert.equal(mock.calls.some(c => c[0] === 'requestProfile' && c[2] === 'session.create'), false);
});

test('unsupported Add project is absent while the existing-project picker remains available', async () => {
  await mount();
  assert.equal(Boolean(button('Add project')), false);
  await click(button('New session')); assert.ok(button('New session in Synthetic Sidebar'));
  assert.equal(button('New session in Home'), undefined);
  assert.equal(mock.calls.some(c => c[0] === 'requestProfile' && c[2] === 'session.create'), false);
  assert.equal(button('Cancel'), undefined);
  await click(button('Close session actions'));
});

test('Home-only native project trees show no usable projects and retain the creation guard', async () => {
  mock.control.projects = [{ id: '__no_project__', label: 'Home', isNoProject: true }];
  await mount(); await click(button('New session'));
  assert.match($('[role=dialog]').textContent, /No projects available/);
  assert.doesNotMatch($('[role=dialog]').textContent, /Home|Home remains/);
  assert.equal(button('New session in Home'), undefined);
  const { projects } = await controller.projects(flow.captureScope());
  await assert.rejects(controller.newChat(flow.captureScope(), projects[0], 'guard-test'), /Home creation is unavailable/);
  assert.equal(mock.calls.some(call => call[0] === 'requestProfile' && call[2] === 'session.create'), false);
});

test('named project uses real route create/open/cwd contract and stable key, not native newChat or a prompt', async () => {
  await mount(); await click(button('New session')); await click(button('New session in Synthetic Sidebar'));
  const create = mock.calls.find(c => c[0] === 'requestProfile' && c[2] === 'session.create');
  assert.equal(create[1].connectionId, 'source-a');
  assert.deepEqual({ ...create[3], idempotency_key: 'stable' }, { source: 'desktop', cwd: '/projects/hermes-t3sidebar', cwd_explicit: true, close_on_disconnect: false, idempotency_key: 'stable' });
  const open = mock.calls.find(c => c[0] === 'open'); assert.equal(open[1], 'fixture-created');
  assert.equal(open[2].awaitHydration, true); assert.equal(open[2].expectHistory, false);
  assert.equal(mock.control.composerCwd, '/projects/hermes-t3sidebar');
  assert.equal(mock.calls.some(c => c[0] === 'new' || /prompt/.test(c[2] || '')), false);
});

test('project creation never sends final cwd setter after selection or source drift', async () => {
  for (const drift of ['stored', 'owner', 'scope']) {
    mock.reset(); controller = flow.createController(mock.ctx); const scope = flow.captureScope();
    mock.control.afterOpen = () => {
      if (drift === 'stored') mock.host.state.focusedStoredSessionId.set('user-navigated-away');
      if (drift === 'owner') mock.host.state.focusedSessionOwner.set({ connectionId: 'foreign', profile: 'default' });
      if (drift === 'scope') mock.switchScope();
    };
    await assert.rejects(controller.newChat(scope, { id: 'fixture', path: '/fixture/project' }, 'stable-key'), /cancelled|Source\/profile changed/);
    assert.equal(mock.calls.some(c => c[0] === 'requestProfile' && c[2] === 'session.cwd.set'), false);
    controller.dispose();
  }
});

test('legacy completion metadata never classifies native archives or migrates history', async () => {
  const rows = ['ready', 'pin', 'work', 'native'].map(id => ({ id, archived: id === 'native' }));
  const metadata = { sessions: Object.fromEntries(rows.map(r => [r.id, { state: 'settled', pinned: r.id === 'pin' }])) };
  const sections = flow.buildSections(rows, metadata, [{ session_key: 'work', status: 'working' }]);
  assert.deepEqual(sections.active.map(r => r.id), ['ready']);
  assert.deepEqual(sections.pinned.map(r => r.id), ['pin']);
  assert.deepEqual(sections.working.map(r => r.id), ['work']);
  assert.deepEqual(sections.archived.map(r => r.id), ['native']);
  await mount();
  assert.equal(row('legacy').closest('section')?.getAttribute('aria-label'), 'Ready');
  assert.equal(mock.calls.some(c => c[0] === 'requestProfile' && c[2] === 'session.archive' || c[0] === 'rest' && c[2]?.method === 'POST'), false);
  assert.doesNotMatch(document.body.textContent, /\bsettle(?:d)?\b/i);
  await click(button('Actions for Sidebar layout')); assert.doesNotMatch($('[role=dialog]').textContent, /\bsettle(?:d)?\b/i);
});

test('archives created elsewhere appear without plugin metadata and retain rich cards', async () => {
  await mount();
  mock.control.rows.push({ id: 'external', archived: true, title: 'Archived in another client', cwd: '/external', git_branch: 'retained', provider: 'anthropic', total_tokens: 1234, project: { name: 'External project', icon: '◇' } });
  await refresh();
  assert.equal(row('external').closest('section')?.getAttribute('aria-label'), 'Archived');
  assert.equal(row('external').querySelector('.sf-project-name').textContent, 'External project');
  assert.equal(mock.control.metadata.sessions.external, undefined);
  assert.equal(row('external').querySelector('[aria-label="Snooze session"]'), null);
  await click(row('external').querySelector('[aria-label="Unarchive session"]'));
  assert.equal(row('external').closest('section')?.getAttribute('aria-label'), 'Ready');
  assert.equal(mock.control.metadata.sessions.external.state, 'active');
  assert.equal(button('Undo'), undefined);
  await click(row('external').querySelector('[aria-label="Archive session"]'));
  assert.equal(row('external').closest('section')?.getAttribute('aria-label'), 'Archived');
});

test('native RPC uses exact owning route, durable root, explicit true/false and before/after persisted readback', async () => {
  controller = flow.createController(mock.ctx); const scope = flow.captureScope();
  const archived = await controller.mutate(scope, 'root', { action: 'archive' });
  assert.deepEqual(archived, { archived: true, before: false });
  const restored = await controller.mutate(scope, 'root', { action: 'unarchive' });
  assert.deepEqual(restored, { archived: false, before: true });
  const rpc = mock.calls.filter(c => c[0] === 'requestProfile');
  assert.deepEqual(rpc.map(c => [c[1].connectionId, c[1].profile, c[2], c[3]]), [
    ['source-a', 'default', 'session.archive', { session_id: 'root', archived: true }],
    ['source-a', 'default', 'session.archive', { session_id: 'root', archived: false }]
  ]);
  assert.equal(mock.calls.filter(c => c[0] === 'rest' && c[1] === '/sessions/root/archive').length, 4);
  assert.deepEqual(mock.calls.filter(c => c[0] === 'rest' && c[2]?.method === 'POST').map(c => [c[1], c[2].body]), [['/sessions/root', { action: 'restore' }]]);
});

test('exact native reader rejects wrong profile/id/missing flag/unsupported or missing ID BEFORE mutation', async () => {
  for (const flag of ['archiveReadProfile', 'archiveReadId', 'archiveReadMissingFlag', 'archiveReadError', 'missingId']) {
    mock.reset(); const c = flow.createController(mock.ctx);
    if (flag !== 'missingId') mock.control[flag] = flag === 'archiveReadProfile' || flag === 'archiveReadId' ? 'foreign' : true;
    await assert.rejects(c.mutate(flow.captureScope(), flag === 'missingId' ? 'absent' : 'design', { action: 'archive' }), /exact native archive state|unavailable|missing/);
    assert.equal(mock.calls.some(c => c[0] === 'requestProfile' && c[2] === 'session.archive'), false, flag);
    c.dispose();
  }
});

test('native post-RPC verification rejects malformed replies and dropped writes without metadata mutation', async () => {
  for (const flag of ['archiveReadProfile', 'archiveReadId', 'archiveReadMissingFlag', 'archiveReadError', 'dropArchiveWrite']) {
    mock.reset(); const c = flow.createController(mock.ctx);
    if (flag === 'dropArchiveWrite') mock.control.dropArchiveWrite = true;
    else mock.control.afterArchive = () => { mock.control[flag] = flag === 'archiveReadProfile' || flag === 'archiveReadId' ? 'foreign' : true; };
    await assert.rejects(c.mutate(flow.captureScope(), 'design', { action: 'archive' }), /did not confirm|unavailable/);
    assert.equal(mock.calls.filter(c => c[0] === 'requestProfile' && c[2] === 'session.archive').length, 1);
    assert.equal(mock.calls.some(c => c[0] === 'rest' && c[1] === '/state'), false, flag);
    assert.equal(mock.queryClient.getQueryData([...flow.scopeKey(flow.captureScope()), 'metadata']), undefined);
    c.dispose();
  }
});

test('source switch across native RPC cancels wrong-source readback and cache publication including ABA', async () => {
  for (const aba of [false, true]) {
    mock.reset(); controller = flow.createController(mock.ctx); const scope = flow.captureScope();
    mock.control.afterArchive = () => { mock.switchScope(); if (aba) mock.switchScope('source-a'); };
    await assert.rejects(controller.mutate(scope, 'design', { action: 'archive' }), /Source\/profile changed/);
    assert.equal(mock.calls.filter(c => c[0] === 'rest' && c[1].endsWith('/archive')).length, 1);
    assert.equal(mock.calls.some(c => c[0] === 'rest' && c[1] === '/state'), false);
    assert.equal(mock.queryClient.getQueryData([...flow.scopeKey(scope), 'metadata']), undefined);
    controller.dispose();
  }
});

test('archive readback validates backend target profile instead of display alias', async () => {
  const scope = { connectionId: 'a', profile: 'alias', epoch: 1 };
  const route = { ...scope, targetProfile: 'actual' }; const effects = []; let flag = false;
  controller = flow.createController({ rest: async path => {
    effects.push(path); return path === '/state' ? { version: 1, sessions: {} } : { profile: 'actual', id: 'root', archived: flag };
  } }, mock.queryClient, { capture: () => scope, routes: async () => [route], host: { requestProfile: async (...args) => { effects.push(args); flag = args[2].archived; } } });
  assert.deepEqual(await controller.mutate(scope, 'root', { action: 'archive' }), { archived: true, before: false });
  assert.deepEqual(effects[1], [route, 'session.archive', { session_id: 'root', archived: true }]);
});

test('Unarchive restores Ready/pin; rearchive uses controls without Undo or reviving old snooze', async () => {
  const wake_at = Math.floor(Date.now() / 1000) + 7200;
  mock.control.metadata.sessions.archived = { state: 'snoozed', pinned: true, wake_at };
  await mount();
  await click(row('archived').querySelector('[aria-label="Unarchive session"]'));
  assert.equal(row('archived').closest('section')?.getAttribute('aria-label'), 'Pinned');
  assert.equal(mock.control.metadata.sessions.archived.state, 'active');
  assert.equal(button('Undo'), undefined);
  await click(row('archived').querySelector('[aria-label="Archive session"]'));
  assert.equal(row('archived').closest('section')?.getAttribute('aria-label'), 'Archived');
  assert.equal(mock.control.metadata.sessions.archived.state, 'active');
  assert.equal(mock.control.metadata.sessions.archived.wake_at, null);
  assert.equal(mock.control.metadata.sessions.archived.pinned, true);
  assert.equal(row('archived').querySelector('[aria-label="Snooze session"]'), null);
});

test('native confirmed unarchive with metadata restore failure reports partial state, not success or false Undo', async () => {
  mock.control.metadata.sessions.archived = { state: 'snoozed', pinned: true, wake_at: Math.floor(Date.now() / 1000) + 7200 };
  mock.control.metadataWriteError = true; await mount();
  await click(row('archived').querySelector('[aria-label="Unarchive session"]'));
  assert.match(document.body.textContent, /Native unarchive confirmed, but organization restore failed/);
  assert.equal(mock.control.rows.find(r => r.id === 'archived').archived, false);
  assert.equal(button('Undo'), undefined);
  assert.equal(row('archived').closest('section')?.getAttribute('aria-label'), 'Snoozed');
});

test('archive pagination is independent from active expansion and invalidates cached pages beyond 500', async () => {
  mock.control.rows = Array.from({ length: 1001 }, (_, i) => ({ id: `active-${i}`, archived: false, title: `Active ${i}` }));
  mock.control.extra = Array.from({ length: 501 }, (_, i) => ({ id: `archive-${i}`, archived: true, cwd: '/archives', git_branch: 'retained' }));
  controller = flow.createController(mock.ctx); const scope = flow.captureScope(), key = flow.scopeKey(scope);
  const archives = await controller.archives(scope, 1);
  assert.equal(archives.sessions.length, 501); assert.equal(archives.has_more, false);
  assert.ok(archives.sessions.every(r => r.archived && r.git_branch === 'retained'));
  assert.equal(mock.calls.some(c => c[0] === 'rest' && c[1].startsWith('/sessions?')), false);
  const expanded = await controller.expanded(scope, 2); assert.equal(expanded.sessions.length, 501);
  assert.equal(mock.queryClient.getQueryData([...key, 'page', 1000]).sessions[0].id, 'active-1000');
  for (const suffix of [['sessions'], ['expanded', 2], ['archives', 1]]) mock.queryClient.setQueryData([...key, ...suffix], { fixture: true });
  const foreign = ['hermes-t3sidebar', 'foreign', scope.profile, scope.epoch, 'page', 500]; mock.queryClient.setQueryData(foreign, { retain: true });
  await controller.mutate(scope, 'active-1000', { action: 'archive' });
  assert.equal(mock.queryClient.getQueryData([...key, 'page', 500]), undefined);
  assert.equal(mock.queryClient.getQueryData([...key, 'page', 1000]), undefined);
  assert.deepEqual(mock.queryClient.getQueryData(foreign), { retain: true });
  for (const suffix of [['sessions'], ['expanded', 2], ['archives', 1]]) assert.equal(mock.queryClient.getQueryState([...key, ...suffix]).isInvalidated, true);
  assert.equal((await controller.expanded(scope, 2)).sessions.some(r => r.id === 'active-1000'), false);
  assert.equal((await controller.archives(scope, 1)).sessions.some(r => r.id === 'active-1000'), true);
  await controller.mutate(scope, 'active-1000', { action: 'unarchive' });
  assert.equal((await controller.expanded(scope, 2)).sessions.some(r => r.id === 'active-1000'), true);
});

test('old external Unarchive remains rich and Ready after remount beyond the first 500 active rows', async () => {
  mock.control.rows = Array.from({ length: 500 }, (_, i) => ({ id: `recent-${i}`, archived: false, title: `Recent ${i}` }));
  mock.control.extra = [{ id: 'external-old', archived: true, title: 'Old external archive', cwd: '/old-external', git_branch: 'retained', project: { name: 'External old project' } }];
  await mount(); await click(row('external-old').querySelector('[aria-label="Unarchive session"]'));
  assert.equal(row('external-old').closest('section')?.getAttribute('aria-label'), 'Ready');
  await act(async () => root.unmount()); root = null; controller.dispose(); mock.queryClient.clear();
  await mount();
  assert.equal(row('external-old').closest('section')?.getAttribute('aria-label'), 'Ready');
  assert.equal(row('external-old').querySelector('.sf-project-name').textContent, 'External old project');
  assert.equal(mock.control.metadata.sessions['external-old'].state, 'active');
});

test('late archive listing cannot publish across a native mutation generation', async () => {
  let finish; const scope = flow.captureScope();
  controller = flow.createController({ rest: (path, options) => path.startsWith('/archives?') ? new Promise(resolve => { finish = resolve; }) : mock.ctx.rest(path, options) });
  const pending = controller.archives(scope); await tick();
  await controller.mutate(scope, 'design', { action: 'archive' });
  const rejected = assert.rejects(pending, /Superseded/);
  finish({ profile: 'default', sessions: [], has_more: false }); await rejected;
});

test('picker retry keeps the same idempotency key after failed create', async () => {
  mock.control.createError = true; await mount(); await click(button('New session'));
  await click(button('New session in Synthetic Sidebar')); mock.control.createError = false;
  await click(button('New session in Synthetic Sidebar'));
  const creates = mock.calls.filter(c => c[0] === 'requestProfile' && c[2] === 'session.create');
  assert.equal(creates.length, 2); assert.equal(creates[0][3].idempotency_key, creates[1][3].idempotency_key);
});

test('server-owned completion shows Done with unread=false and clears only after successful open', async () => {
  mock.control.rows.find(item => item.id === 'readme').unread = false;
  const completion = { done_token: 'backend-turn-1', done_at: Date.now() / 1000 };
  mock.control.metadata.completions = { readme: completion };
  await mount();
  assert.equal(row('readme').querySelector('.sf-status')?.dataset.status, 'done');
  assert.equal(row('readme').dataset.unread, 'true');
  await remount();
  assert.equal(row('readme').querySelector('.sf-status')?.dataset.status, 'done');
  assert.equal([...mock.storageData.values()].some(value => value.includes('backend-turn-1')), false, 'the client does not persist completion flags');
  mock.control.openError = true;
  await click(row('readme').querySelector('.sf-open'));
  assert.equal(mock.control.metadata.completions.readme.done_token, completion.done_token);
  assert.equal(mock.calls.some(call => call[2]?.body?.action === 'ack_done'), false);
  mock.control.openError = false;
  await click(row('readme').querySelector('.sf-open'));
  assert.deepEqual(mock.control.metadata.completions, {});
  assert.equal(row('readme').querySelector('.sf-status') === null, true);
  const acknowledgments = mock.calls.filter(call => call[2]?.body?.action === 'ack_done');
  assert.equal(acknowledgments.length, 1);
  assert.deepEqual(acknowledgments[0][2].body, { action: 'ack_done', done_token: 'backend-turn-1' });
});

test('qualified focus serializes shared Woke and Done acknowledgments without creating Undo', async () => {
  const wake = Math.floor(Date.now() / 1000) - 1;
  mock.control.metadata.sessions.design = { state: 'active', pinned: false, woke_at: wake, updated_at: wake };
  mock.control.metadata.completions = { design: { done_token: 'viewed-turn', done_at: wake } };
  await mount(); await tick();
  assert.equal(mock.control.metadata.sessions.design.woke_at, null);
  assert.deepEqual(mock.control.metadata.completions, {});
  assert.deepEqual(mock.calls.filter(call => ['ack_wake', 'ack_done'].includes(call[2]?.body?.action)).map(call => call[2].body.action), ['ack_wake', 'ack_done']);
  await refresh();
  assert.equal(mock.calls.filter(call => call[2]?.body?.action === 'ack_done').length, 1);
  assert.equal(button('Undo'), undefined);
});

test('an older delayed open cannot acknowledge a newer backend completion generation', async () => {
  mock.control.rows.find(item => item.id === 'readme').unread = false;
  const previous = { done_token: 'old-result', done_at: Date.now() / 1000 };
  mock.control.metadata.completions = { readme: previous }; await mount();
  const original = mock.host.openSession; let finish;
  mock.host.openSession = () => new Promise(resolve => { finish = resolve; });
  try {
    const opening = controller.open(flow.captureScope(), { id: 'readme', completion: { ...previous } }); await tick();
    mock.control.metadata.completions.readme = { done_token: 'new-result', done_at: previous.done_at + 1 };
    await refresh();
    await act(async () => { finish(); await opening; }); await tick();
    assert.equal(mock.control.metadata.completions.readme.done_token, 'new-result');
    assert.equal(row('readme').querySelector('.sf-status')?.dataset.status, 'done');
    assert.deepEqual(mock.calls.find(call => call[2]?.body?.action === 'ack_done')[2].body, { action: 'ack_done', done_token: 'old-result' });
  } finally { mock.host.openSession = original; }
});

test('Done acknowledgments require confirmed readback and a matching focused owner', async () => {
  mock.control.rows.find(item => item.id === 'readme').unread = false;
  mock.control.metadata.completions = { readme: { done_token: 'read-me', done_at: Date.now() / 1000 } };
  mock.host.state.focusedStoredSessionId.set('readme');
  mock.host.state.focusedSessionOwner.set({ connectionId: 'foreign', profile: 'default' });
  await mount();
  assert.equal(mock.calls.some(call => call[2]?.body?.action === 'ack_done'), false);
  mock.control.dropWrite = true;
  await assert.rejects(controller.ackDone(flow.captureScope(), { id: 'readme', completion: mock.control.metadata.completions.readme }), /did not confirm/);
  assert.equal(mock.control.metadata.completions.readme.done_token, 'read-me');
  mock.control.dropWrite = false;
  await act(async () => mock.host.state.focusedSessionOwner.set({ connectionId: 'source-a', profile: 'default' })); await tick();
  assert.deepEqual(mock.control.metadata.completions, {});
});

test('backend completion metadata validates without synthesizing flags on older companions', () => {
  assert.equal(flow.validState({ version: 1, sessions: {} }).completions, undefined);
  assert.throws(() => flow.verifyAction({ version: 1, sessions: {} }, 'id', { action: 'ack_done', done_token: 'exact-token' }), /did not confirm/);
  for (const completions of [null, [], { id: {} }, { id: { done_token: false, done_at: 1 } }, { id: { done_token: '', done_at: 1 } }, { id: { done_token: 'valid', done_at: 0 } }]) {
    assert.throws(() => flow.validState({ version: 1, sessions: {}, completions }), /completion/);
  }
  const completion = { done_token: 'exact-token', done_at: 1 };
  for (const [fields, expected] of [[{ status: 'idle' }, 'done'], [{ status: 'working' }, 'working'], [{ status: 'waiting' }, 'input'], [{ status: 'idle', woke: true }, 'woke']]) {
    assert.equal(flow.cardStatus({ ...fields, completion, unread: false }), expected);
  }
  assert.equal(flow.cardStatus({ status: 'idle', completion, unread: false }, true), null);
});

test('backend unread shows Done and clears on successful native open; Input and Working outrank it', async () => {
  await mount();
  assert.equal(row('readme').querySelector('.sf-status').dataset.status, 'done');
  assert.equal(row('readme').dataset.unread, 'true');
  assert.equal(row('approval').querySelector('.sf-status').dataset.status, 'input');
  assert.equal(row('root').querySelector('.sf-status').dataset.status, 'working');
  assert.equal(flow.cardStatus({ unread: 'true', status: 'idle' }), null);
  assert.equal(flow.cardStatus({ unread: true, woke: true, status: 'waiting' }), 'input');
  assert.equal(flow.cardStatus({ unread: true, woke: true, status: 'working' }), 'working');
  await click(row('readme').querySelector('.sf-open'));
  assert.equal(row('readme').querySelector('.sf-status'), null);
  assert.equal(row('readme').dataset.unread, 'false');
});

test('Woke survives remount until read; pin and acknowledgment create no Undo', async () => {
  const wake = Math.floor(Date.now() / 1000) - 60;
  mock.control.metadata.sessions.readme = { state: 'active', pinned: false, woke_at: wake, updated_at: wake };
  await mount(); assert.equal(row('readme').querySelector('.sf-status').dataset.status, 'woke');
  await remount(); assert.equal(row('readme').querySelector('.sf-status').dataset.status, 'woke');
  await click(button('Actions for Sidebar layout')); await click(button('Pin')); assert.equal(button('Undo'), undefined);
  await click(row('readme').querySelector('.sf-open'));
  assert.equal(mock.control.metadata.sessions.readme.woke_at, null);
  assert.equal(row('readme').querySelector('.sf-status'), null);
  assert.equal(button('Undo'), undefined); assert.equal($('.sf-undo'), null);
  assert.equal(mock.calls.filter(call => call[0] === 'rest' && call[2]?.body?.action === 'ack_wake').length, 1);
});

test('failed open never acknowledges Woke; a foreign focused owner never acknowledges it', async () => {
  const wake = Math.floor(Date.now() / 1000) - 60;
  mock.control.metadata.sessions.readme = { state: 'active', pinned: false, woke_at: wake };
  mock.control.openError = true;
  await mount(); await click(row('readme').querySelector('.sf-open'));
  assert.equal(mock.control.metadata.sessions.readme.woke_at, wake);
  assert.equal(mock.calls.some(call => call[2]?.body?.action === 'ack_wake'), false);
  await act(async () => {
    mock.host.state.focusedStoredSessionId.set('readme');
    mock.host.state.focusedSessionOwner.set({ connectionId: 'foreign', profile: 'default' });
  }); await tick();
  assert.equal(mock.control.metadata.sessions.readme.woke_at, wake);
  await act(async () => mock.host.state.focusedSessionOwner.set({ connectionId: 'source-a', profile: 'default' })); await tick(); await tick();
  assert.equal(mock.control.metadata.sessions.readme.woke_at, null);
});

test('wake acknowledgments compare exact generations and do not clear newer markers', async () => {
  const wake = Math.floor(Date.now() / 1000) - 60;
  mock.control.metadata.sessions.readme = { state: 'active', pinned: true, woke_at: wake + 1, updated_at: wake + 1 };
  controller = flow.createController(mock.ctx);
  await controller.ackWake(flow.captureScope(), { id: 'readme', meta: { woke_at: wake } });
  assert.equal(mock.control.metadata.sessions.readme.woke_at, wake + 1);
  assert.equal(mock.control.metadata.sessions.readme.pinned, true);
  const stale = flow.captureScope(); mock.switchScope();
  await assert.rejects(controller.ackWake(stale, { id: 'readme', meta: { woke_at: wake + 1 } }), /Source\/profile changed/);
});

test('context menu copies durable ID and filters by exact session project without archive or snooze options', async () => {
  await mount(); await click(button('Actions for Runtime classification'));
  const text = $('[role=dialog]').textContent;
  assert.doesNotMatch(text, /Archive|Snooze ·|Custom snooze/);
  await click(button('Copy session ID')); assert.ok(mock.calls.some(call => call[0] === 'clipboard' && call[1] === 'root'));
  await click(button('Actions for Release notes')); await click(button('Project')); await click(button('Filter for'));
  assert.ok(row('readme')); assert.equal(row('design'), null);
  assert.equal(mock.calls.some(call => call[0] === 'new' || call[2] === 'session.cwd.set'), false);
});

test('clipboard failure stays visible without falsely closing context; stale copy never writes', async () => {
  mock.control.clipboardError = true;
  await mount(); await click(button('Actions for Sidebar layout')); await click(button('Copy session ID'));
  assert.match($('[role=alert]').textContent, /not copied/);
  const scope = flow.captureScope(); mock.switchScope();
  const count = mock.calls.filter(call => call[0] === 'clipboard').length;
  await assert.rejects(controller.copyId(scope, { id: 'design' }), /Source\/profile changed/);
  assert.equal(mock.calls.filter(call => call[0] === 'clipboard').length, count);
});

test('Rename is available only for live runtime and verifies the title with exact lineage readback', async () => {
  await mount(); await click(button('Actions for Sidebar layout')); assert.equal(button('Rename').disabled, true);
  assert.match($('[role=dialog]').textContent, /live runtime/); await click(button('Close session actions'));
  await click(button('Actions for Runtime classification')); assert.equal(button('Rename').disabled, false);
  await click(button('Rename')); await input($('input[aria-label="Session title"]'), 'Renamed runtime'); await click(button('Save rename'));
  assert.equal(row('root').querySelector('.sf-row-title').textContent, 'Renamed runtime');
  const writes = mock.calls.filter(call => call[0] === 'requestProfile' && call[2] === 'session.title');
  assert.deepEqual(writes.map(call => call[3]), [{ session_id: 'runtime-worker', title: 'Renamed runtime' }, { session_id: 'runtime-worker' }]);
  assert.equal(writes[0][1].connectionId, 'source-a');
});

test('Rename refuses dropped, pending, wrong-lineage and switched-source confirmations', async () => {
  controller = flow.createController(mock.ctx);
  const item = { ...mock.control.rows.find(row => row.id === 'tip'), runtimeId: 'runtime-worker' };
  for (const [flag, value, message] of [['dropRename', true, /did not confirm/], ['renamePending', true, /pending/], ['renameWrongId', 'foreign', /did not confirm/]]) {
    mock.control[flag] = value;
    await assert.rejects(controller.rename(flow.captureScope(), item, 'New title'), message);
    delete mock.control[flag];
  }
  mock.control.afterRename = () => mock.switchScope();
  await assert.rejects(controller.rename(flow.captureScope(), item, 'Other title'), /Source\/profile changed/);
});

test('Rename rechecks runtime ownership before writing and collapsed bodies are inert for animation', async () => {
  controller = flow.createController(mock.ctx);
  const item = { ...mock.control.rows.find(row => row.id === 'tip'), runtimeId: 'stale-runtime' };
  await assert.rejects(controller.rename(flow.captureScope(), item, 'New title'), /same live runtime/);
  assert.equal(mock.calls.some(call => call[2] === 'session.title'), false);
  controller.dispose(); await mount(); await click(button('Archived (1)'));
  const body = shelf('Archived').querySelector('.sf-section-body');
  assert.equal(body.hasAttribute('inert'), true); assert.equal(body.getAttribute('aria-hidden'), 'true');
  assert.match($('style').textContent, /transition:grid-template-rows/);
  assert.match($('style').textContent, /prefers-reduced-motion:reduce/);
});

const draftQueries = () => mock.queryClient.getQueryCache().findAll({ queryKey: ['hermes-t3sidebar-drafts'] });
async function refreshDrafts() {
  await act(async () => mock.queryClient.invalidateQueries({ queryKey: ['hermes-t3sidebar-drafts'] }));
  await tick();
}

test('composer presence is boolean-only, text-trimmed, read-only and exact open-tip addressed', async () => {
  controller = flow.createController(mock.ctx); const scope = flow.captureScope();
  const item = { id: 'old', resolved_id: 'tip', _lineage_root_id: 'root', _lineage_ids: ['root', 'old', 'tip'] };
  mock.control.drafts.tip = 'SYNTHETIC private draft';
  assert.equal(await controller.hasDraft(scope, item), true);
  assert.deepEqual(mock.calls, [['getDraft', 'tip']]);
  mock.control.mountedDrafts.tip = ' \n\t ';
  assert.equal(await controller.hasDraft(scope, item), false, 'mounted whitespace overrides nonempty stash');
  mock.control.mountedDrafts.tip = '';
  assert.equal(await controller.hasDraft(scope, item), false, 'mounted empty overrides stash');
  delete mock.control.mountedDrafts.tip;
  mock.control.drafts.tip = ''; // Attachment-only composer has no textual draft.
  assert.equal(await controller.hasDraft(scope, item), false, 'attachments alone are not exposed as text');
  assert.equal(await controller.hasDraft(scope, { id: 'missing' }), false);
  mock.control.draftError = true;
  assert.equal(await controller.hasDraft(scope, item), false);
  delete mock.host.composer;
  assert.equal(await controller.hasDraft(scope, item), false, 'older SDK without composer');
  mock.host.composer = {};
  assert.equal(await controller.hasDraft(scope, item), false, 'older SDK without getter');
  assert.ok(mock.calls.every(call => call[0] === 'getDraft'));
  assert.equal(mock.queryClient.getQueryCache().getAll().length, 0);
  assert.equal(mock.storageData.size, 0);
});

test('composer reads fence source, profile, ABA, disposal and stale failures before publishing', async () => {
  for (const drift of ['source', 'profile', 'aba', 'dispose', 'error']) {
    mock.reset(); controller = flow.createController(mock.ctx); const scope = flow.captureScope(); let finish, fail;
    mock.control.readDraft = () => new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const pending = controller.hasDraft(scope, { id: 'design' });
    const rejected = assert.rejects(pending, /Source\/profile changed/);
    if (drift === 'dispose') controller.dispose();
    else if (drift === 'profile') mock.switchScope('source-a', 'other');
    else { mock.switchScope(); if (drift === 'aba') mock.switchScope('source-a'); }
    if (drift === 'error') fail(new Error('SYNTHETIC private error')); else finish('SYNTHETIC private draft');
    await rejected;
    const count = mock.calls.length;
    await assert.rejects(controller.hasDraft(scope, { id: 'design' }), /Source\/profile changed/);
    assert.equal(mock.calls.length, count, 'stale invocation never calls SDK');
    controller.dispose();
  }
});

test('composer focused owner mismatch stays neutral before and after asynchronous read', async () => {
  controller = flow.createController(mock.ctx); const scope = flow.captureScope();
  mock.control.mountedDrafts.design = 'SYNTHETIC foreign composer';
  mock.host.state.focusedSessionOwner.set({ connectionId: 'foreign', profile: 'default' });
  assert.equal(await controller.hasDraft(scope, { id: 'design' }), false);
  assert.equal(mock.calls.length, 0);
  mock.host.state.focusedSessionOwner.set({ connectionId: 'source-a', profile: 'default' });
  let finish; mock.control.readDraft = () => new Promise(resolve => { finish = resolve; });
  const pending = controller.hasDraft(scope, { id: 'design' });
  mock.host.state.focusedSessionOwner.set({ connectionId: 'source-a', profile: 'other' });
  finish('SYNTHETIC foreign composer'); assert.equal(await pending, false);
});

test('React draft tint follows typing and clearing with boolean-only independent cache and no writes', async () => {
  await mount(); assert.equal(row('design').dataset.hasDraft, 'false');
  const stored = [...mock.storageData]; const calls = mock.calls.length;
  mock.control.mountedDrafts.design = 'SYNTHETIC private composer text';
  await refreshDrafts();
  assert.equal(row('design').dataset.hasDraft, 'true'); assert.equal(row('design').dataset.current, 'true');
  assert.equal(row('readme').dataset.hasDraft, 'false');
  assert.ok(mock.calls.slice(calls).every(call => call[0] === 'getDraft'));
  assert.ok(draftQueries().length > 0);
  assert.ok(draftQueries().every(query => typeof query.state.data === 'boolean'));
  assert.ok(draftQueries().every(query => query.queryKey[1] === 'source-a' && query.queryKey[2] === 'default' && query.queryKey[3] === 1));
  assert.doesNotMatch(JSON.stringify(mock.queryClient.getQueryCache().getAll().map(query => query.state)), /SYNTHETIC private/);
  assert.doesNotMatch(document.body.textContent, /SYNTHETIC private/);
  assert.deepEqual([...mock.storageData], stored);
  const css = $('style').textContent;
  assert.match(css, /\.sf-row\[data-has-draft=true\]\[data-current=false\]\{background:color-mix\(in srgb,var\(--ui-orange[^)]*\) 10%,transparent\)/);
  assert.match(css, /\.sf-row\[data-has-draft=true\]\[data-current=false\]:hover,\.sf-row\[data-has-draft=true\]\[data-current=false\]:focus-within[^}]*14%,transparent/);
  assert.ok([...css.matchAll(/([^{}]+)\{[^{}]*background:color-mix\(in srgb,var\(--ui-orange[^{}]+\}/g)].every(match => match[1].split(',').every(selector => selector.includes('[data-current=false]'))));
  assert.match(css, /\.sf-row\[data-current=true\][^}]*box-shadow:inset 2px 0 var\(--ui-accent\)/);
  mock.control.mountedDrafts.design = ' \t\n'; await refreshDrafts();
  assert.equal(row('design').dataset.hasDraft, 'false');
  mock.control.mountedDrafts.design = 'SYNTHETIC draft again'; await refreshDrafts();
  mock.control.draftError = true; await refreshDrafts();
  assert.equal(row('design').dataset.hasDraft, 'false', 'getter error removes previous tint');
});

test('React draft reads are mount/open-shelf bounded and independent from gateway token invalidation', async () => {
  mock.ctx.storage.set(JSON.stringify(['folds', 'source-a', 'default']), { working: true, snoozed: true, archived: true });
  mock.control.drafts.tip = 'SYNTHETIC stashed tip';
  await mount();
  assert.ok(!mock.calls.some(call => call[0] === 'getDraft' && ['tip', 'snoozed', 'archived'].includes(call[1])));
  const before = mock.calls.filter(call => call[0] === 'getDraft').length;
  await refresh();
  assert.equal(mock.calls.filter(call => call[0] === 'getDraft').length, before, 'session token/list refresh does not fan out draft reads');
  await click(button('Working (1)')); assert.equal(row('root').dataset.hasDraft, 'true');
  assert.equal(mock.calls.filter(call => call[0] === 'getDraft' && call[1] === 'tip').length, 1);
  const tipQuery = draftQueries().find(query => query.queryKey[4] === 'root');
  assert.ok(tipQuery); assert.equal(tipQuery.state.data, true);
  await click(button('Working (1)')); mock.control.drafts.tip = '';
  await refreshDrafts();
  assert.equal(mock.calls.filter(call => call[0] === 'getDraft' && call[1] === 'tip').length, 1, 'folded cached query disabled');
  await click(button('Working (1)')); assert.equal(row('root').dataset.hasDraft, 'false');
  assert.equal(mock.calls.filter(call => call[0] === 'getDraft' && call[1] === 'tip').length, 2);
});

test('React draft focus entering/leaving refetches only affected cards and configures focused polling', async () => {
  await mount();
  const counts = () => Object.fromEntries(['design', 'readme', 'approval'].map(id => [id, mock.calls.filter(call => call[0] === 'getDraft' && call[1] === id).length]));
  const before = counts();
  mock.control.mountedDrafts.design = 'SYNTHETIC unsaved before switch';
  mock.control.drafts.readme = 'SYNTHETIC stashed new selection';
  await act(async () => mock.host.state.focusedStoredSessionId.set('readme')); await tick();
  assert.equal(row('design').dataset.hasDraft, 'true'); assert.equal(row('readme').dataset.hasDraft, 'true');
  assert.equal(row('design').dataset.current, 'false'); assert.equal(row('readme').dataset.current, 'true');
  const after = counts();
  assert.equal(after.design, before.design + 1); assert.equal(after.readme, before.readme + 1); assert.equal(after.approval, before.approval);
  for (const query of draftQueries()) {
    const observer = query.getObserversCount() ? query.observers[0] : null;
    assert.equal(observer?.options.refetchInterval, query.queryKey[4] === 'readme' ? 2000 : false);
    assert.equal(observer?.options.refetchOnMount, 'always');
    assert.equal(observer?.options.refetchOnWindowFocus, false);
  }
});

test('React stale draft result cannot tint new scope with colliding ID or populate its cache', async () => {
  let finish; mock.control.readDraft = id => id === 'design' ? new Promise(resolve => { finish = resolve; }) : null;
  await mount(); const oldScope = flow.captureScope();
  const staleFinish = finish;
  await act(async () => { delete mock.control.readDraft; mock.switchScope('source-b', 'other'); }); await tick(); await tick();
  await act(async () => staleFinish('SYNTHETIC old-scope draft')); await tick();
  assert.equal(row('design').dataset.hasDraft, 'false');
  const queries = draftQueries().filter(query => query.queryKey[1] === 'source-b');
  assert.ok(queries.length > 0); assert.ok(queries.every(query => query.state.data === false));
  assert.ok(draftQueries().filter(query => query.queryKey[1] === oldScope.connectionId).every(query => query.state.data !== true));
});

test('plugin disposal cancels and removes only its listing and separate draft cache roots', async () => {
  plugin.register(mock.ctx);
  const scope = flow.captureScope(); let finish;
  const pending = mock.queryClient.fetchQuery({ queryKey: ['hermes-t3sidebar-drafts', scope.connectionId, scope.profile, scope.epoch, 'design'], queryFn: () => new Promise(resolve => { finish = resolve; }) });
  const rejected = assert.rejects(pending);
  mock.queryClient.setQueryData(['hermes-t3sidebar-drafts', 'other', 'default', 1, 'design'], true);
  mock.queryClient.setQueryData(['unrelated-fixture'], true);
  mock.control.disposers.forEach(fn => fn()); finish(true); await rejected;
  assert.equal(draftQueries().length, 0);
  assert.equal(mock.queryClient.getQueryData(['unrelated-fixture']), true);
});

async function remount() {
  await act(async () => root.unmount()); root = null; controller.dispose(); mock.queryClient.clear();
  await mount();
}

test('fold preferences survive remount/reconnect but remain source and profile scoped', async () => {
  await mount();
  for (const label of ['Working', 'Snoozed', 'Archived']) await click(button(`${label} (1)`));
  assert.equal(mock.storageData.size, 1);
  const [key, raw] = [...mock.storageData][0];
  assert.deepEqual(JSON.parse(raw), { working: true, snoozed: true, archived: true });
  await remount();
  for (const id of ['root', 'snoozed', 'archived']) assert.equal(row(id), null);
  await act(async () => mock.switchScope('source-a')); await tick(); await tick();
  assert.equal(row('root'), null); assert.equal(mock.storageData.get(key), raw);
  await act(async () => mock.switchScope('source-b')); await tick(); await tick();
  assert.ok(row('root'));
  await click(button('Snoozed (1)'));
  await act(async () => mock.switchScope('source-b', 'other')); await tick(); await tick();
  assert.ok(row('snoozed'));
  await act(async () => mock.switchScope('source-a')); await tick(); await tick();
  assert.equal(row('root'), null); assert.equal(row('snoozed'), null); assert.equal(row('archived'), null);
  await click(button('Working (1)')); await remount(); assert.ok(row('root'));
  assert.equal(row('snoozed'), null); assert.equal(row('archived'), null);
});

test('fold storage accepts only secondary-shelf booleans and tolerates read/write failures', async () => {
  await mount(); const key = [...mock.storageData.keys()][0];
  for (const value of [null, [], 'bad', { working: 'true', snoozed: 1, archived: true, active: true, pinned: true }]) {
    mock.ctx.storage.set(key, value); await remount();
    assert.ok(row('root')); assert.ok(row('snoozed')); assert.ok(row('pinned')); assert.ok(row('design'));
    assert.equal(!!row('archived'), value?.archived !== true);
  }
  mock.control.storageReadError = true; mock.control.storageWriteError = true;
  await remount(); assert.ok(row('archived'));
  await click(button('Working (1)')); assert.equal(row('root'), null);
  assert.equal($('[role=alert]'), null);
});

test('search keeps Archived folded while retaining matching counts and explicit expansion', async () => {
  await mount(); await click(button('Archived (1)'));
  const before = [...mock.storageData];
  await input($('input[type=search]'), 'SDK inventory'); assert.equal(Boolean(row('archived')), false);
  assert.equal(button('Archived (1)').getAttribute('aria-expanded'), 'false');
  assert.doesNotMatch(document.body.textContent, /All caught up|No matching sessions/);
  assert.deepEqual([...mock.storageData], before);
  await input($('input[type=search]'), 'no such session');
  assert.match(document.body.textContent, /No matching sessions/);
  assert.doesNotMatch(document.body.textContent, /All caught up/);
  await input($('input[type=search]'), ''); assert.equal(row('archived'), null);
  await input($('input[type=search]'), 'SDK inventory'); await click(button('Archived (1)')); assert.ok(row('archived'));
});

test('search never unfolds Snoozed; counts, manual opening and durable fold preferences remain usable', async () => {
  await mount(); await click(button('Snoozed (1)')); const before = [...mock.storageData];
  await input($('input[type=search]'), 'Review tomorrow');
  assert.equal(row('snoozed'), null);
  assert.equal(button('Snoozed (1)').getAttribute('aria-expanded'), 'false');
  assert.equal(shelf('Snoozed').querySelector('.sf-section-body').hasAttribute('inert'), true);
  assert.equal(shelf('Snoozed').querySelector('.sf-section-body').getAttribute('aria-hidden'), 'true');
  assert.doesNotMatch(document.body.textContent, /All caught up|No matching sessions/);
  assert.deepEqual([...mock.storageData], before);
  await input($('input[type=search]'), 'nothing matches'); assert.match(document.body.textContent, /No matching sessions/);
  await input($('input[type=search]'), ''); assert.equal(row('snoozed'), null);
  await input($('input[type=search]'), 'Review tomorrow'); await click(button('Snoozed (1)'));
  assert.ok(row('snoozed')); assert.equal(button('Snoozed (1)').getAttribute('aria-expanded'), 'true');
  await input($('input[type=search]'), ''); await remount(); assert.ok(row('snoozed'));
  await click(button('Snoozed (1)')); await remount(); assert.equal(row('snoozed'), null);
});

test('search clear control is present for any text and rename uses an adjacent icon-only submit', async () => {
  await mount(); assert.equal(button('Clear search'), undefined);
  await input($('input[type=search]'), '  '); assert.ok(button('Clear search'));
  await click(button('Clear search')); assert.equal($('input[type=search]').value, '');
  assert.equal(document.activeElement, $('input[type=search]'));
  await click(button('Actions for Runtime classification')); await click(button('Rename'));
  const field = $('input[aria-label="Session title"]'), save = button('Save rename');
  assert.equal(save.parentElement, field.parentElement);
  assert.equal(save.textContent, ''); assert.ok(save.querySelector('svg'));
});

test('project filtering counts folded matches rather than claiming none or Ready caught up', async () => {
  Object.assign(mock.control.rows.find(r => r.id === 'archived'), { cwd: '/only-archive', project: { name: 'Archive only' } });
  await mount(); await click(button('Archived (1)')); await click(button('Filter sessions'));
  await click(button('Filter by Archive only'));
  assert.equal(all('.sf-row').filter(node => !node.closest('[data-closed=true]')).length, 0);
  assert.equal(shelf('Archived').querySelector('.sf-section-body').hasAttribute('inert'), true);
  assert.equal(button('Archived (1)').getAttribute('aria-expanded'), 'false');
  assert.doesNotMatch(document.body.textContent, /No matching sessions|All caught up/);
  await click(button('Archived (1)')); assert.ok(row('archived'));
});

test('secondary headers contain label, parenthesized filtered count, line and right-edge up/right chevron', async () => {
  await mount();
  for (const name of ['Working', 'Snoozed', 'Archived']) {
    const header = shelf(name).querySelector('.sf-section-toggle');
    assert.deepEqual([...header.children].map(node => node.className), ['sf-section-label', 'sf-count', 'sf-section-line', 'sf-section-chevron']);
    assert.equal(header.querySelector('.sf-count').textContent, `(${shelf(name).querySelectorAll('.sf-row').length})`);
    assert.equal(header.querySelector('.sf-section-chevron path').getAttribute('d'), 'M6 15l6-6 6 6');
  }
  await click(button('Working (1)'));
  assert.equal(shelf('Working').querySelector('.sf-section-chevron path').getAttribute('d'), 'M9 6l6 6-6 6');
  await input($('input[type=search]'), 'SDK inventory');
  for (const name of ['Working', 'Snoozed', 'Archived']) {
    assert.equal(shelf(name).querySelector('.sf-count').textContent, `(${shelf(name).querySelectorAll('.sf-row').length})`);
  }
});

test('shared actions omit obsolete footer; picker omits Cancel; hidden card controls retain layout', async () => {
  await mount();
  const css = $('style').textContent;
  assert.match(css, /\.sf-hover\{[^}]*display:flex[^}]*visibility:hidden/);
  assert.match(css, /\.sf-row:hover \.sf-hover\{visibility:visible\}/);
  assert.doesNotMatch(css, /focus-within \.sf-hover|focus-visible \.sf-hover/);
  assert.match(css, /\.sf-project-icon\{[^}]*background:transparent/);
  assert.match(css, /\.sf-row\[data-working=true\] \.sf-time[^}]*var\(--ui-blue,#0053fd\)/);
  for (const label of ['Snooze session', 'Actions for Sidebar layout']) {
    await click(row('design').querySelector(`[aria-label="${label}"]`));
    assert.doesNotMatch($('[role=dialog]').textContent, /History kept · never stops the agent\./);
    await click(button('Close session actions'));
  }
  await click(button('New session')); assert.equal(button('Cancel'), undefined);
});

test('pin, archive and unarchive create no Undo even when native readback fails', async () => {
  await mount();
  for (const id of ['design', 'archived']) {
    await click(button('Actions for Sidebar layout')); await click(button(mock.control.metadata.sessions.design?.pinned ? 'Unpin' : 'Pin'));
    assert.equal(button('Undo'), undefined);
    await click(row(id).querySelector(`[aria-label="${id === 'design' ? 'Archive' : 'Unarchive'} session"]`));
    assert.equal(button('Undo'), undefined);
  }
  await click(button('Actions for Sidebar layout')); await click(button('Pin')); assert.equal(button('Undo'), undefined);
  mock.control.archiveReadError = true;
  await click(row('design').querySelector('[aria-label="Unarchive session"]'));
  assert.equal(button('Undo'), undefined); assert.match($('[role=alert]').textContent, /unavailable/);
});

test('pin, snooze and restore are reversed through ordinary actions without any Undo UI', async () => {
  await mount();
  const noUndo = () => { assert.equal(button('Undo'), undefined); assert.equal(button('Dismiss undo'), undefined); assert.equal($('.sf-undo'), null); };
  await click(button('Actions for Sidebar layout')); await click(button('Pin'));
  assert.equal(row('design').closest('section'), shelf('Pinned')); noUndo();
  await click(button('Actions for Sidebar layout')); await click(button('Unpin'));
  assert.equal(row('design').closest('section'), shelf('Ready')); noUndo();
  await click(row('design').querySelector('[aria-label="Snooze session"]')); await click(button('In 1 hour'));
  assert.equal(row('design').closest('section'), shelf('Snoozed')); noUndo();
  await click(button('Actions for Sidebar layout')); await click(button('Restore to Ready'));
  assert.equal(row('design').closest('section'), shelf('Ready')); noUndo();
  await click(row('readme').querySelector('[aria-label="Snooze session"]')); await click(button('In 1 hour'));
  assert.equal(row('readme').closest('section'), shelf('Snoozed')); noUndo();
  await click(row('readme').querySelector('[aria-label="Archive session"]'));
  assert.equal(row('readme').closest('section'), shelf('Archived')); noUndo();
});

test('unfiltered empty Ready keeps catch-up while a no-match project filter suppresses it', async () => {
  mock.control.rows = mock.control.rows.filter(r => r.id === 'archived'); mock.control.live = [];
  await mount(); assert.match(shelf('Ready').textContent, /All caught up/);
  await click(button('Filter sessions'));
  // A known project disappears from the loaded data after it has been selected.
  await click(button('Filter by hermes-t3sidebar'));
  mock.control.rows = []; await refresh();
  assert.match(document.body.textContent, /No matching sessions/);
  assert.doesNotMatch(document.body.textContent, /All caught up/);
});
