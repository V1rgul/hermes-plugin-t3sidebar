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
  assert.equal(mock.control.contributions[0].title, plugin.name); assert.equal(mock.control.settings.title, plugin.name);
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

test('React search, project filter, optional local grouping and keyboard navigation', async () => {
  await mount(); await input($('input[type=search]'), 'Sidebar'); assert.ok(row('design')); assert.equal(row('readme'), null);
  await input($('input[type=search]'), '');
  if (!$('select')) await click(button('Filter sessions'));
  await act(async () => { $('select').value = '/projects/docs'; $('select').dispatchEvent(new Event('change', { bubbles: true })); }); await tick();
  assert.ok(row('readme')); assert.equal(row('design'), null);
  await click(button('Group by project')); assert.ok($('.sf-group'));
  await click(button('Use flat list')); assert.equal($('.sf-group'), null);
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

test('React settles and restores with Undo and readback, and settle-and-advance opens next', async () => {
  await mount(); await click(row('design').querySelector('[aria-label="Archive session"]'));
  assert.equal(row('design').closest('section'), shelf('Archived')); assert.ok(button('Undo'));
  await click(button('Undo')); assert.equal(row('design').closest('section'), shelf('Ready'));
  await click(button('Actions for Sidebar layout')); await click(button('Archive and advance'));
  assert.equal(row('design').closest('section'), shelf('Archived'));
  assert.ok(mock.calls.some(c => c[0] === 'open' && c[1] === 'approval'));
});

test('React context menu snooze preset and custom validation, Restore', async () => {
  await mount(); await act(async () => row('design').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))); await tick();
  assert.ok($('[role=dialog]')); await click(button('Snooze · In 1 hour'));
  assert.equal(row('design').closest('section'), shelf('Snoozed'));
  await click(button('Actions for Sidebar layout')); await click(button('Restore to Ready')); assert.equal(row('design').closest('section'), shelf('Ready'));
  await click(button('Actions for Sidebar layout')); await input($('input[type=datetime-local]'), '2020-01-01T12:00');
  await click(button('Snooze until chosen time')); assert.match($('[role=alert]').textContent, /future/);
  await input($('input[type=datetime-local]'), '2030-01-01T12:00'); await click(button('Snooze until chosen time'));
  assert.equal(row('design').closest('section'), shelf('Snoozed'));
});

test('React waiting stays in headerless Ready and cannot be settled; secondary sections collapse', async () => {
  await mount(); assert.equal(button('Active (3)'), undefined); assert.ok(row('approval'));
  assert.equal(row('approval').querySelector('[aria-label="Archive session"]').disabled, true);
  await click(button('Actions for Approval request'));
  assert.equal([...$('[role=dialog]').querySelectorAll('button')].find(node => node.textContent === 'Archive').disabled, true);
  assert.equal(button('Snooze · In 1 hour').disabled, true);
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
  await mount(); await click(row('design').querySelector('[aria-label="Archive session"]')); assert.ok(button('Undo'));
  mock.control.rows.find(row => row.id === 'design').archived = false;
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

test('project picker explicitly rejects Home without creating a session and Add project explains unavailable', async () => {
  await mount(); await click(button('New session')); await click(button('New session in Home'));
  assert.match(document.body.textContent, /Home creation is unavailable/);
  assert.equal(mock.calls.some(c => c[0] === 'requestProfile' && c[2] === 'session.create'), false);
  await click(button('Cancel')); await click(button('Add project'));
  assert.match(document.body.textContent, /Adding projects is unavailable/);
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
  assert.equal(row('external').querySelector('[aria-label="Snooze session"]').disabled, true);
  await click(row('external').querySelector('[aria-label="Unarchive session"]'));
  assert.equal(row('external').closest('section')?.getAttribute('aria-label'), 'Ready');
  assert.equal(mock.control.metadata.sessions.external.state, 'active');
  await click(button('Undo'));
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

test('Unarchive restores Ready/pin, Undo rearchives and preserves previous future snooze and pin', async () => {
  const wake_at = Math.floor(Date.now() / 1000) + 7200;
  mock.control.metadata.sessions.archived = { state: 'snoozed', pinned: true, wake_at };
  await mount();
  await click(row('archived').querySelector('[aria-label="Unarchive session"]'));
  assert.equal(row('archived').closest('section')?.getAttribute('aria-label'), 'Pinned');
  assert.equal(mock.control.metadata.sessions.archived.state, 'active');
  await click(button('Undo'));
  assert.equal(row('archived').closest('section')?.getAttribute('aria-label'), 'Archived');
  assert.equal(mock.control.metadata.sessions.archived.state, 'snoozed');
  assert.equal(mock.control.metadata.sessions.archived.wake_at, wake_at);
  assert.equal(mock.control.metadata.sessions.archived.pinned, true);
  assert.equal(row('archived').querySelector('[aria-label="Snooze session"]').disabled, true);
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
