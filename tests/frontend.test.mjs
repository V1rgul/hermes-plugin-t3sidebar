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
const row = id => $(`[data-session-id="${id}"]`);
const shelf = name => $(`section[aria-label="${name}"]`);
const button = label => all('button').find(node => node.getAttribute('aria-label') === label || node.textContent === label);
async function click(node) { assert.ok(node, 'button exists'); await act(async () => { node.click(); }); await tick(); }
async function input(node, value) {
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); }); await tick();
}
async function mount() {
  controller = flow.createController(mock.ctx);
  root = createRoot($('#app'));
  await act(async () => { root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(flow.SessionFlow, { ctx: mock.ctx, controller }))); });
  await tick(); await tick();
}
afterEach(async () => { if (root) { await act(async () => root.unmount()); root = null; } controller?.dispose(); controller = null; mock.reset(); });

test('only supported import specifiers; opt-in left-pane registration and disposal', async () => {
  const source = await readFile(new URL('../desktop/plugin.js', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => match[1]), ['@hermes/plugin-sdk', 'react']);
  assert.equal(plugin.id, 'session-flow'); assert.equal(plugin.defaultEnabled, false);
  assert.doesNotMatch(source, /setInterval|document\.|window\.|localStorage|__reactFiber|restartGateway/);
  plugin.register(mock.ctx);
  assert.equal(mock.control.contributions[0].data.placement, 'left');
  assert.equal(mock.control.contributions[0].id, 'sidebar'); assert.equal(typeof mock.control.settings.render, 'function');
  mock.control.disposers.forEach(fn => fn()); assert.equal(mock.control.listener, null);
});

test('waiting outranks pin, settled, snoozed and working across compression aliases', () => {
  for (const state of ['active', 'settled', 'snoozed']) {
    const result = flow.buildSections([{ id: 'tip', _lineage_root_id: 'root', _lineage_ids: ['old'] }], { sessions: { root: { state, pinned: true, wake_at: 9999 } } }, [
      { id: 'worker', session_key: 'tip', status: 'working' }, { id: 'approval', session_key: 'old', status: 'waiting' }
    ], { now: 100 });
    assert.equal(result.active[0].key, 'root'); assert.equal(result.active[0].status, 'waiting');
    assert.equal(Object.values(result).flat().length, 1);
  }
});

test('working and starting dim shelf; idle pins; snooze wake; settlement ordering', () => {
  const rows = ['work', 'start', 'pin', 'due', 'later', 's1', 's2'].map(id => ({ id }));
  const result = flow.buildSections(rows, { sessions: {
    pin: { state: 'active', pinned: true }, due: { state: 'snoozed', wake_at: 100 }, later: { state: 'snoozed', wake_at: 101 },
    s1: { state: 'settled', settled_at: 30 }, s2: { state: 'settled', settled_at: 40 }
  } }, [{ session_key: 'work', status: 'working' }, { session_key: 'start', status: 'starting' }], { now: 100 });
  assert.deepEqual(result.working.map(r => r.id), ['start', 'work']); assert.equal(result.pinned[0].id, 'pin');
  assert.equal(result.active[0].id, 'due'); assert.equal(result.active[0].woke, true); assert.equal(result.snoozed[0].id, 'later');
  assert.deepEqual(result.settled.map(r => r.id), ['s2', 's1']);
});

test('unknown runtime never silently classifies idle or hides in settled', () => {
  const result = flow.buildSections([{ id: 's' }], { sessions: { s: { state: 'settled' } } }, [], { runtimeKnown: false });
  assert.equal(result.active[0].status, 'unknown'); assert.equal(result.settled.length, 0);
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
  const presets = flow.snoozePresets(new Date('2026-10-23T17:00:00').getTime()); assert.equal(presets.length, 3);
  assert.equal(new Date(presets[2].wake_at * 1000).getHours(), 9);
});

test('scope keys separate same-profile sources and epochs; exact route required', () => {
  const a = { connectionId: 'a', profile: 'default', epoch: 1 }, b = { ...a, connectionId: 'b' };
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

test('React mounts all shelves, waiting above pins, dim working, native open/new', async () => {
  await mount(); assert.ok(row('approval')); assert.equal(row('approval').closest('section'), shelf('Active'));
  assert.equal(row('root').dataset.working, 'true'); assert.equal(row('pinned').closest('section'), shelf('Pinned'));
  assert.equal(row('snoozed').closest('section'), shelf('Snoozed')); assert.equal(row('settled').closest('section'), shelf('Recently Settled'));
  await click(row('design').querySelector('.sf-open')); assert.ok(mock.calls.some(c => c[0] === 'open' && c[1] === 'design'));
  await click(button('New session')); assert.ok(mock.calls.some(c => c[0] === 'new'));
  assert.match(document.body.textContent, /native workspace selection/);
});

test('React search, project filter, grouping, compact detail and keyboard navigation', async () => {
  await mount(); await input($('input[type=search]'), 'Sidebar'); assert.ok(row('design')); assert.equal(row('readme'), null);
  await input($('input[type=search]'), '');
  await act(async () => { $('select').value = '/projects/docs'; $('select').dispatchEvent(new Event('change', { bubbles: true })); }); await tick();
  assert.ok(row('readme')); assert.equal(row('design'), null);
  await click(button('Group by project')); assert.ok($('.sf-group'));
  await click(button('Use flat list')); assert.equal($('.sf-group'), null);
  await click(button('Show project details')); assert.ok($('.sf-row-detail'));
  const first = row('readme').querySelector('.sf-open'); first.focus();
  await act(async () => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  assert.equal(document.activeElement, row('snoozed').querySelector('.sf-open'));
});

test('React settles and restores with Undo and readback, and settle-and-advance opens next', async () => {
  await mount(); await click(row('design').querySelector('[aria-label="Settle session"]'));
  assert.equal(row('design').closest('section'), shelf('Recently Settled')); assert.ok(button('Undo'));
  await click(button('Undo')); assert.equal(row('design').closest('section'), shelf('Active'));
  await click(button('Actions for Sidebar layout')); await click(button('Settle and advance'));
  assert.equal(row('design').closest('section'), shelf('Recently Settled'));
  assert.ok(mock.calls.some(c => c[0] === 'open' && c[1] === 'approval'));
});

test('React context menu snooze preset and custom validation, Restore', async () => {
  await mount(); await act(async () => row('design').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))); await tick();
  assert.ok($('[role=dialog]')); await click(button('Snooze · In 1 hour'));
  assert.equal(row('design').closest('section'), shelf('Snoozed'));
  await click(row('design').querySelector('[aria-label="Restore session"]')); assert.equal(row('design').closest('section'), shelf('Active'));
  await click(button('Actions for Sidebar layout')); await input($('input[type=datetime-local]'), '2020-01-01T12:00');
  await click(button('Snooze until chosen time')); assert.match($('[role=alert]').textContent, /future/);
  await input($('input[type=datetime-local]'), '2030-01-01T12:00'); await click(button('Snooze until chosen time'));
  assert.equal(row('design').closest('section'), shelf('Snoozed'));
});

test('React waiting cannot collapse away or be settled; all sections collapse otherwise', async () => {
  await mount(); await click(button('Active (3)')); assert.ok(row('approval'));
  assert.equal(row('approval').querySelector('[aria-label="Restore session"]').disabled, false);
  await click(button('Actions for Approval request')); assert.equal(button('Settle').disabled, true); assert.equal(button('Snooze · In 1 hour').disabled, true);
  await click(button('Close session actions')); await click(button('Recently Settled (1)')); assert.equal(row('settled'), null);
});

test('React runtime failure shows unknown and keeps settled rows in Active', async () => {
  mock.control.runtimeError = true; await mount();
  assert.match(document.body.textContent, /Runtime status unavailable/); assert.equal(row('settled').closest('section'), shelf('Active'));
  assert.match(row('settled').querySelector('.sf-open').getAttribute('aria-label'), /status unknown/);
});

test('React missing backend is read-only without local fallback; list errors visible', async () => {
  mock.control.backendMissing = true; await mount(); assert.match(document.body.textContent, /Read-only browsing/);
  assert.equal(row('design').querySelector('[aria-label="Settle session"]').disabled, true);
  await click(row('design').querySelector('.sf-open')); assert.ok(mock.calls.some(c => c[0] === 'open'));
  mock.control.listError = true; await click(button('Refresh sessions')); assert.match(document.body.textContent, /Session list failed/);
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

test('scope change after POST prevents wrong-source readback or cache publication', async () => {
  let scope = { connectionId: 'a', profile: 'default', epoch: 1 }; const original = { ...scope }; const paths = [];
  controller = flow.createController({ rest: async (path, options) => { paths.push(path); scope = { ...scope, connectionId: 'b', epoch: 2 }; return { version: 1, sessions: {} }; } }, mock.queryClient, { capture: () => scope });
  await assert.rejects(controller.mutate(original, 'design', { action: 'settle' }), /Source\/profile changed/);
  assert.deepEqual(paths, ['/sessions/design']); assert.equal(mock.queryClient.getQueryData([...flow.scopeKey(original), 'metadata']), undefined);
});

test('React route switch clears undo and scoped metadata; no cross-source cache collision', async () => {
  await mount(); await click(row('design').querySelector('[aria-label="Settle session"]')); assert.ok(button('Undo'));
  await act(async () => { mock.control.metadata = { version: 1, sessions: {} }; mock.switchScope('source-b', 'default'); }); await tick(); await tick();
  assert.equal(button('Undo'), undefined); assert.equal(row('design').closest('section'), shelf('Active'));
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
  await mount(); await click(button('Recently Settled (1)')); assert.equal(row('settled'), null);
  await input($('input[type=search]'), 'SDK inventory'); assert.ok(row('settled'));
  assert.doesNotMatch(document.body.textContent, /No matching sessions/);
  await input($('input[type=search]'), ''); assert.equal(row('settled'), null);
});

test('501st organized session survives remount and keeps rich project filtering after due wake', async () => {
  mock.control.rows = Array.from({ length: 500 }, (_, i) => ({ id: `recent${i}`, title: `Recent ${i}` }));
  mock.control.extra = [{ id: 'old-tip', _lineage_root_id: 'old-root', _lineage_ids: ['old-root', 'old-tip'], title: 'Old project session', cwd: '/old-project', git_branch: 'retained' }];
  await mount(); await click(button('Browse older sessions'));
  await click(row('old-root').querySelector('[aria-label="Settle session"]'));
  await act(async () => root.unmount()); root = null; controller.dispose(); mock.queryClient.clear();
  await mount(); assert.equal(row('old-root').closest('section'), shelf('Recently Settled'));
  mock.control.metadata.sessions['old-root'] = { state: 'snoozed', pinned: false, wake_at: 1, settled_at: null, updated_at: 1 };
  await click(button('Refresh sessions')); assert.equal(row('old-root').closest('section'), shelf('Active'));
  await act(async () => { $('select').value = '/old-project'; $('select').dispatchEvent(new Event('change', { bubbles: true })); }); await tick();
  assert.ok(row('old-root')); assert.equal(all('.sf-row').length, 1);
});

test('SDK fallback keeps 500 rich rows and discloses unavailable older organized recovery', async () => {
  mock.control.sessionsMissing = true; mock.control.total = 900; await mount();
  assert.ok(row('design')); assert.match(document.body.textContent, /capped at 500 of 900/);
  assert.equal(button('Browse older sessions'), undefined);
});
