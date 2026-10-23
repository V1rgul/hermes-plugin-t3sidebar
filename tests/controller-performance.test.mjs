// Deterministic latency checks against the real controller and React Query.
// All RPC/REST/session data here are synthetic SDK fixtures, never live history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createController, captureScope, scopeKey, aliases } from '../desktop/plugin.js';
import * as mock from './sdk.mock.mjs';

function gate() {
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  return { started, release, async wait() { entered(); await waiting; } };
}
function fixture(t, action, { verify = true } = {}) {
  mock.reset();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const scope = captureScope(), prefix = scopeKey(scope), verification = gate(), refresh = gate();
  const native = ['archive', 'unarchive', 'rename', 'delete'].includes(action);
  const suffix = native || action === 'open' ? 'sessions' : 'metadata';
  const target = action === 'unarchive' ? 'archived' : 'design';
  const row = { ...mock.control.rows.find(item => item.id === target), status: 'idle', runtimeId: 'runtime-design' };
  mock.control.live.push({ id: 'runtime-design', session_key: target, status: 'idle' });
  if (action === 'open-wake') {
    row.meta = { state: 'active', pinned: false, woke_at: 123 };
    mock.control.metadata.sessions[target] = { ...row.meta };
  }
  const active = { sessions: structuredClone(mock.control.rows.filter(item => !item.archived)), has_more: false };
  const archived = { sessions: structuredClone(mock.control.rows.filter(item => item.archived)), has_more: false };
  client.setQueryData([...prefix, 'sessions'], active);
  client.setQueryData([...prefix, 'archives', 0], archived);
  client.setQueryData([...prefix, 'metadata'], structuredClone(mock.control.metadata));
  const initialData = client.getQueryData([...prefix, suffix]);
  let refreshFinished = false, refreshStarted = false, archiveReads = 0, snapshots = 0;
  const observer = new QueryObserver(client, { queryKey: [...prefix, suffix], initialData, staleTime: Infinity,
    queryFn: async () => { refreshStarted = true; await refresh.wait(); refreshFinished = true; return initialData; } });
  const unsubscribe = observer.subscribe(() => {});
  const rest = async (path, options) => {
    const value = await mock.ctx.rest(path, options);
    const isVerification = path === '/state' && !native || path.endsWith('/archive') && ++archiveReads === 2 || path.endsWith('/snapshot') && ++snapshots === 2;
    if (verify && isVerification) await verification.wait();
    return value;
  };
  const envHost = { ...mock.host,
    async requestProfile(route, method, params) {
      const value = await mock.host.requestProfile(route, method, params);
      if (verify && method === 'session.title' && params.title === undefined) await verification.wait();
      return value;
    },
    async openSession(...args) {
      const result = await mock.host.openSession(...args);
      if (verify && action === 'open') await verification.wait();
      return result;
    }
  };
  const controller = createController({ ...mock.ctx, rest }, client, { capture: captureScope, routes: mock.host.profileRoutes, host: envHost });
  t.after(() => { verification.release(); refresh.release(); controller.dispose(); unsubscribe(); client.clear(); });
  function run() {
    if (action === 'rename') return controller.rename(scope, row, 'Verified new title');
    if (action === 'delete') return controller.delete(scope, row);
    if (action === 'open' || action === 'open-wake') return controller.open(scope, row);
    const payload = action === 'snooze' ? { action, wake_at: Math.floor(Date.now() / 1000) + 3600 } : { action };
    return controller.mutate(scope, target, payload);
  }
  return { client, controller, scope, prefix, row, verification, refresh, run,
    get refreshFinished() { return refreshFinished; }, get refreshStarted() { return refreshStarted; } };
}
function track(promise) {
  const status = { settled: false };
  status.done = promise.then(value => { Object.assign(status, { settled: true, value }); }, error => { Object.assign(status, { settled: true, error }); });
  return status;
}

for (const action of ['pin', 'snooze', 'restore', 'archive', 'unarchive', 'rename', 'delete', 'open', 'open-wake']) {
  test(`${action} waits for exact verification but not an unrelated observed refresh`, { timeout: 3000 }, async t => {
    const f = fixture(t, action), before = f.client.getQueriesData({ queryKey: f.prefix }), operation = track(f.run());
    await f.verification.started;
    assert.equal(operation.settled, false, 'unverified work must remain pending');
    assert.equal(f.refreshStarted, false, 'refresh is not verification');
    assert.deepEqual(f.client.getQueriesData({ queryKey: f.prefix }), before, 'no optimistic cache publication');
    f.verification.release();
    await turn();
    assert.equal(operation.settled, true, 'verified work must settle while refresh is gated');
    assert.equal(operation.error, undefined);
    assert.equal(f.refreshStarted, true, 'background refresh is still scheduled');
    assert.equal(f.refreshFinished, false);
    await operation.done;
  });
}

for (const action of ['pin', 'archive', 'unarchive', 'rename', 'delete', 'open', 'open-wake']) {
  test(`${action} cannot publish after an epoch/source ABA during verification`, { timeout: 3000 }, async t => {
    const f = fixture(t, action), before = f.client.getQueriesData({ queryKey: f.prefix });
    const operation = track(f.run());
    await f.verification.started;
    mock.switchScope(); mock.switchScope('source-a');
    f.verification.release(); await turn();
    assert.equal(operation.settled, true);
    assert.match(operation.error?.message || '', /Source\/profile changed/);
    assert.equal(f.refreshStarted, false, 'obsolete actions must not trigger refresh');
    assert.deepEqual(f.client.getQueriesData({ queryKey: f.prefix }), before, 'no stale confirmed cache publication');
  });
}

for (const [action, flag] of [['pin', 'dropWrite'], ['archive', 'dropArchiveWrite'], ['rename', 'dropRename'], ['delete', 'dropDelete']]) {
  test(`${action} verification failure rejects before an unrelated refresh finishes`, { timeout: 3000 }, async t => {
    const f = fixture(t, action, { verify: false });
    mock.control[flag] = true;
    const before = f.client.getQueryData([...f.prefix, 'sessions']);
    const operation = track(f.run()); await turn();
    assert.equal(operation.settled, true, 'refresh must not delay errors either');
    assert.match(operation.error?.message || '', /did not confirm|still exists/);
    assert.equal(f.refreshStarted, true);
    assert.equal(f.refreshFinished, false);
    assert.deepEqual(f.client.getQueryData([...f.prefix, 'sessions']), before);
  });
}

for (const action of ['archive', 'unarchive']) {
  test(`${action} immediately moves the existing rich row across cached native shelves only in its scope`, async t => {
    const f = fixture(t, action, { verify: false });
    const foreignKey = ['hermes-t3sidebar', 'foreign', f.scope.profile, f.scope.epoch, 'sessions'];
    const foreign = { sessions: [{ ...f.row }] }; f.client.setQueryData(foreignKey, foreign);
    await f.run();
    const active = f.client.getQueryData([...f.prefix, 'sessions']).sessions;
    const archived = f.client.getQueryData([...f.prefix, 'archives', 0]).sessions;
    const destination = action === 'archive' ? archived : active, source = action === 'archive' ? active : archived;
    assert.equal(source.some(row => aliases(row).includes(f.row.id)), false);
    const moved = destination.find(row => aliases(row).includes(f.row.id));
    assert.ok(moved, 'verified row must remain visible during slow native refresh');
    assert.equal(moved.archived, action === 'archive');
    for (const field of ['title', 'project', 'cwd', 'git_branch', 'provider', 'total_tokens']) assert.deepEqual(moved[field], f.row[field], field);
    assert.deepEqual(f.client.getQueryData(foreignKey), foreign);
  });
}

test('rename and delete update only verified rows without waiting for the list', async t => {
  for (const action of ['rename', 'delete']) await t.test(action, async t => {
    const f = fixture(t, action, { verify: false });
    await f.run();
    const row = f.client.getQueryData([...f.prefix, 'sessions']).sessions.find(row => row.id === f.row.id);
    if (action === 'rename') assert.equal(row.title, 'Verified new title');
    else assert.equal(row, undefined);
    assert.equal(f.refreshFinished, false);
  });
});

test('native archive never fabricates a rich card from runtime-only evidence', async t => {
  const f = fixture(t, 'archive', { verify: false });
  f.client.setQueryData([...f.prefix, 'sessions'], { sessions: [] });
  const runtime = { id: 'runtime-design', session_key: 'design', status: 'idle' };
  f.client.setQueryData([...f.prefix, 'runtime'], { sessions: [runtime] });
  await f.run();
  assert.equal(f.client.getQueryData([...f.prefix, 'archives', 0]).sessions.some(row => aliases(row).includes('design')), false);
});

test('ambiguous delete rejects promptly and retries exact request identity before publishing absence', async t => {
  const f = fixture(t, 'delete', { verify: false });
  mock.control.deleteLostReply = true;
  const operation = track(f.run()); await turn();
  assert.equal(operation.settled, true);
  assert.match(operation.error?.message || '', /reply lost/);
  assert.equal(f.refreshFinished, false);
  assert.ok(f.client.getQueryData([...f.prefix, 'sessions']).sessions.find(row => row.id === 'design'));
  await f.run();
  const writes = mock.calls.filter(call => call[0] === 'rest' && call[1].endsWith('/delete'));
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0][2].body, writes[1][2].body);
  assert.equal(f.client.getQueryData([...f.prefix, 'sessions']).sessions.some(row => row.id === 'design'), false);
});

test('a rejected background invalidation cannot replace a confirmed result or escape unhandled', async t => {
  const f = fixture(t, 'pin', { verify: false });
  f.client.invalidateQueries = () => Promise.reject(new Error('background refresh failed'));
  await f.run(); await turn();
  assert.equal(f.client.getQueryData([...f.prefix, 'metadata']).sessions.design.pinned, true);
});

function routedFixture(t, routes) {
  mock.reset();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const controller = createController(mock.ctx, client, { capture: captureScope, routes, host: mock.host });
  t.after(() => { controller.dispose(); client.clear(); });
  return { client, controller, scope: captureScope() };
}

test('concurrent scoped reads and open share only in-flight route discovery, not a settled route cache', async t => {
  const discovery = gate(); let calls = 0;
  t.after(discovery.release);
  const f = routedFixture(t, async () => { calls++; await discovery.wait(); return mock.host.profileRoutes(); });
  const work = Promise.all([f.controller.list(f.scope), f.controller.runtime(f.scope), f.controller.archives(f.scope), f.controller.open(f.scope, { id: 'design' })]);
  await discovery.started;
  assert.equal(calls, 1);
  discovery.release(); await work;
  await f.controller.open(f.scope, { id: 'design' });
  assert.equal(calls, 2, 'a subsequent action must revalidate routes');
  await f.controller.mutate(f.scope, 'design', { action: 'archive' });
  assert.equal(calls, 3, 'native writes must not reuse settled route authority');
});

test('failed route discovery is shared and removed so a subsequent action can retry', async t => {
  const discovery = gate(); let calls = 0;
  t.after(discovery.release);
  const f = routedFixture(t, async () => { calls++; if (calls === 1) { await discovery.wait(); throw new Error('route discovery failed'); } return mock.host.profileRoutes(); });
  const work = Promise.allSettled([f.controller.list(f.scope), f.controller.runtime(f.scope), f.controller.archives(f.scope)]);
  await discovery.started; assert.equal(calls, 1); discovery.release();
  for (const result of await work) { assert.equal(result.status, 'rejected'); assert.match(result.reason.message, /route discovery failed/); }
  await f.controller.open(f.scope, { id: 'design' });
  assert.equal(calls, 2);
});

test('in-flight route sharing is epoch-qualified and old completion cannot clear newer discovery', async t => {
  const oldGate = gate(), newGate = gate(); let calls = 0;
  t.after(() => { oldGate.release(); newGate.release(); });
  const f = routedFixture(t, async () => {
    const call = ++calls, routes = await mock.host.profileRoutes();
    await (call === 1 ? oldGate : newGate).wait(); return routes;
  });
  const old = track(f.controller.open(f.scope, { id: 'design' }));
  await oldGate.started;
  mock.switchScope(); mock.switchScope('source-a');
  const nextScope = captureScope(), next = f.controller.open(nextScope, { id: 'design' });
  await newGate.started; assert.equal(calls, 2);
  oldGate.release(); await old.done;
  assert.match(old.error?.message || '', /Source\/profile changed/);
  const shared = f.controller.projects(nextScope);
  assert.equal(calls, 2, 'old cleanup must not clear the current in-flight discovery');
  newGate.release(); await Promise.all([next, shared]);
  assert.equal(mock.calls.filter(call => call[0] === 'open').length, 1);
});

test('disposal rejects shared route waiters before any native action', async t => {
  const discovery = gate(); let calls = 0;
  t.after(discovery.release);
  const f = routedFixture(t, async () => { calls++; await discovery.wait(); return mock.host.profileRoutes(); });
  const work = Promise.allSettled([f.controller.open(f.scope, { id: 'design' }), f.controller.newChat(f.scope)]);
  await discovery.started; f.controller.dispose(); discovery.release();
  for (const result of await work) { assert.equal(result.status, 'rejected'); assert.match(result.reason.message, /Source\/profile changed/); }
  assert.equal(calls, 1);
  assert.equal(mock.calls.some(call => ['open', 'new'].includes(call[0])), false);
});
