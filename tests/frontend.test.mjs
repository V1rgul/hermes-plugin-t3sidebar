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
async function refresh() { if (!button('Refresh sessions')) await click(button('Filter sessions')); await click(button('Refresh sessions')); }
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

test('unknown runtime never silently classifies idle or hides in settled', () => {
  const result = flow.buildSections([{ id: 's' }], { sessions: { s: { state: 'settled' } } }, [], { runtimeKnown: false });
  assert.equal(result.active[0].status, 'unknown'); assert.equal(result.archived.length, 0);
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
  const presets = flow.snoozePresets(new Date('2026-10-23T17:00:00').getTime()); assert.equal(presets.length, 3);
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
  await click(button('New session')); assert.ok(button('New session in Home'));
  assert.equal(mock.calls.some(c => c[0] === 'new'), false); assert.doesNotMatch(document.body.textContent, /native workspace selection/);
});

test('React search and exact project filter stay flat with keyboard navigation', async () => {
  await mount(); await input($('input[type=search]'), 'Sidebar'); assert.ok(row('design')); assert.equal(row('readme'), null);
  await input($('input[type=search]'), '');
  if (!$('select')) await click(button('Filter sessions'));
  await act(async () => { $('select').value = '/projects/docs'; $('select').dispatchEvent(new Event('change', { bubbles: true })); }); await tick();
  assert.ok(row('readme')); assert.equal(row('design'), null);
  assert.equal(button('Group by project'), undefined); assert.equal(button('Use flat list'), undefined); assert.equal($('.sf-group'), null);
  assert.equal(button('Show project details'), undefined); assert.equal($('.sf-row-detail'), null);
  const first = row('readme').querySelector('.sf-open'); first.focus();
  await act(async () => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  assert.equal(document.activeElement?.closest('[data-session-id]')?.dataset.sessionId, 'legacy');
});

test('card Snooze opens time choices and confirms organization without opening the session', async () => {
  await mount();
  await click(row('design').querySelector('[aria-label="Snooze session"]'));
  assert.equal($('[role=dialog]').getAttribute('aria-label'), 'Snooze session');
  assert.equal($('[role=dialog]').textContent.includes('Settle'), false);
  await click(button('Snooze · In 1 hour'));
  assert.equal(row('design').closest('section'), shelf('Snoozed'));
  assert.equal($('[role=dialog]'), null);
  assert.equal(mock.calls.some(call => call[0] === 'open'), false);
  await click(button('Undo'));
  assert.equal(row('design').closest('section'), shelf('Ready'));
  assert.equal(row('approval').querySelector('[aria-label="Snooze session"]').disabled, true);
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
  assert.ok($('[role=dialog]')); assert.equal(button('Snooze · In 1 hour'), undefined);
  await click(button('Close session actions')); await click(row('design').querySelector('[aria-label="Snooze session"]')); await click(button('Snooze · In 1 hour'));
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

test('scope change after POST prevents wrong-source readback or cache publication', async () => {
  let scope = { connectionId: 'a', profile: 'default', epoch: 1 }; const original = { ...scope }; const paths = [];
  controller = flow.createController({ rest: async (path, options) => { paths.push(path); scope = { ...scope, connectionId: 'b', epoch: 2 }; return { version: 1, sessions: {} }; } }, mock.queryClient, { capture: () => scope });
  await assert.rejects(controller.mutate(original, 'design', { action: 'settle' }), /Source\/profile changed/);
  assert.deepEqual(paths, ['/sessions/design']); assert.equal(mock.queryClient.getQueryData([...flow.scopeKey(original), 'metadata']), undefined);
});

test('React route switch clears undo and scoped metadata; no cross-source cache collision', async () => {
  await mount(); await click(row('design').querySelector('[aria-label="Snooze session"]')); await click(button('Snooze · In 1 hour')); assert.ok(button('Undo'));
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
  await mount(); await click(button('Archived (1)')); assert.equal(row('archived'), null);
  await input($('input[type=search]'), 'SDK inventory'); assert.ok(row('archived'));
  assert.doesNotMatch(document.body.textContent, /No matching sessions/);
  await input($('input[type=search]'), ''); assert.equal(row('archived'), null);
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
  if (!$('select')) await click(button('Filter sessions'));
  await act(async () => { $('select').value = '/old-project'; $('select').dispatchEvent(new Event('change', { bubbles: true })); }); await tick();
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
  assert.equal(card.querySelector('.sf-provider').getAttribute('aria-label'), 'Provider unavailable');
  assert.equal(card.querySelector('.sf-token').textContent, '—');
  assert.equal(card.querySelector('[data-provider-mark]'), null);
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

test('new-session picker renders native project icons and Home without printing identifiers', async () => {
  mock.control.projects = [{ id: 'p_infra', label: 'Infra', path: '/fixture/infra', icon: 'tools', color: '#123456' }];
  await mount(); await click(button('New session'));
  const infra = button('New session in Infra'), home = button('New session in Home');
  assert.ok(infra.querySelector('.sf-project-icon [data-codicon="tools"]'));
  assert.ok(home.querySelector('.sf-project-icon [data-codicon="home"]'));
  assert.equal(infra.textContent, 'Infra');
  assert.equal(home.textContent, 'Home');
  assert.equal(mock.calls.some(c => c[0] === 'requestProfile' && c[2] === 'session.create'), false);
});

test('unsupported Add project is absent while the existing-project picker remains available', async () => {
  await mount();
  assert.equal(Boolean(button('Add project')), false);
  await click(button('New session')); await click(button('New session in Home'));
  assert.match(document.body.textContent, /Home creation is unavailable/);
  assert.equal(mock.calls.some(c => c[0] === 'requestProfile' && c[2] === 'session.create'), false);
  assert.equal(button('Cancel'), undefined);
  await click(button('Close session actions'));
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

test('Woke survives remount until read, while pin Undo remains available after acknowledgment', async () => {
  const wake = Math.floor(Date.now() / 1000) - 60;
  mock.control.metadata.sessions.readme = { state: 'active', pinned: false, woke_at: wake, updated_at: wake };
  await mount(); assert.equal(row('readme').querySelector('.sf-status').dataset.status, 'woke');
  await remount(); assert.equal(row('readme').querySelector('.sf-status').dataset.status, 'woke');
  await click(button('Actions for Sidebar layout')); await click(button('Pin')); assert.ok(button('Undo'));
  await click(row('readme').querySelector('.sf-open'));
  assert.equal(mock.control.metadata.sessions.readme.woke_at, null);
  assert.equal(row('readme').querySelector('.sf-status'), null);
  assert.ok(button('Undo'));
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
  await click(button('Actions for Release notes')); await click(button('Filter by docs'));
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

test('search temporarily expands saved folds without persisting expansion or showing catch-up', async () => {
  await mount(); await click(button('Archived (1)'));
  const before = [...mock.storageData];
  await input($('input[type=search]'), 'SDK inventory'); assert.ok(row('archived'));
  assert.doesNotMatch(document.body.textContent, /All caught up|No matching sessions/);
  assert.deepEqual([...mock.storageData], before);
  await input($('input[type=search]'), 'no such session');
  assert.match(document.body.textContent, /No matching sessions/);
  assert.doesNotMatch(document.body.textContent, /All caught up/);
  await input($('input[type=search]'), ''); assert.equal(row('archived'), null);
});

test('project filtering counts folded matches rather than claiming none or Ready caught up', async () => {
  mock.control.rows.find(r => r.id === 'archived').cwd = '/only-archive';
  await mount(); await click(button('Archived (1)')); await click(button('Filter sessions'));
  await act(async () => { $('select').value = '/only-archive'; $('select').dispatchEvent(new Event('change', { bubbles: true })); }); await tick();
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

test('archive and unarchive clear previous pin Undo even when native readback fails', async () => {
  await mount();
  for (const id of ['design', 'archived']) {
    await click(button('Actions for Sidebar layout')); await click(button(mock.control.metadata.sessions.design?.pinned ? 'Unpin' : 'Pin'));
    assert.ok(button('Undo'));
    await click(row(id).querySelector(`[aria-label="${id === 'design' ? 'Archive' : 'Unarchive'} session"]`));
    assert.equal(button('Undo'), undefined);
  }
  await click(button('Actions for Sidebar layout')); await click(button('Pin')); assert.ok(button('Undo'));
  mock.control.archiveReadError = true;
  await click(row('design').querySelector('[aria-label="Unarchive session"]'));
  assert.equal(button('Undo'), undefined); assert.match($('[role=alert]').textContent, /unavailable/);
});

test('pin and Restore retain exact Undo behavior; archiving clears a stale snooze Undo', async () => {
  await mount();
  await click(button('Actions for Sidebar layout')); await click(button('Pin'));
  assert.equal(row('design').closest('section'), shelf('Pinned'));
  await click(button('Undo')); assert.equal(row('design').closest('section'), shelf('Ready'));
  await click(row('design').querySelector('[aria-label="Snooze session"]')); await click(button('Snooze · In 1 hour'));
  const wake = mock.control.metadata.sessions.design.wake_at;
  await click(button('Actions for Sidebar layout')); await click(button('Restore to Ready'));
  assert.equal(row('design').closest('section'), shelf('Ready'));
  await click(button('Undo')); assert.equal(row('design').closest('section'), shelf('Snoozed'));
  assert.equal(mock.control.metadata.sessions.design.wake_at, wake);
  await click(row('readme').querySelector('[aria-label="Snooze session"]')); await click(button('Snooze · In 1 hour'));
  assert.ok(button('Undo'));
  await click(row('readme').querySelector('[aria-label="Archive session"]'));
  assert.equal(button('Undo'), undefined);
});

test('unfiltered empty Ready keeps catch-up while a no-match project filter suppresses it', async () => {
  mock.control.rows = mock.control.rows.filter(r => r.id === 'archived'); mock.control.live = [];
  await mount(); assert.match(shelf('Ready').textContent, /All caught up/);
  await click(button('Filter sessions'));
  // A known project disappears from the loaded data after it has been selected.
  await act(async () => { $('select').value = '/projects/hermes-t3sidebar'; $('select').dispatchEvent(new Event('change', { bubbles: true })); }); await tick();
  mock.control.rows = []; await refresh();
  assert.match(document.body.textContent, /No matching sessions/);
  assert.doesNotMatch(document.body.textContent, /All caught up/);
});
