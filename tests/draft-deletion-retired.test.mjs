// A session deleted and verified here keeps its draft retired on this client, whatever began before the deletion and completes after it.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as mock from './sdk.mock.mjs';
import { captureScope, createController } from '../desktop/plugin.js';

const STORAGE_KEY = 'drafts:source-a:default';
const stored = () => JSON.parse(mock.storageData.get(STORAGE_KEY) ?? 'null');
const target = id => ({ key: id, ids: [id], address: id, cwd: null });
const localIds = (controller, scope) => controller.localDrafts(scope).map(draft => draft.session_id);
const serverText = id => mock.control.serverDrafts.find(draft => draft.session_id === id)?.text;
const controllers = [], rest = mock.ctx.rest;
function make() {
  const controller = createController(mock.ctx, mock.queryClient, { capture: captureScope, routes: () => mock.host.profileRoutes(), host: mock.host });
  controllers.push(controller);
  return controller;
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
// The companion marks a deleted session's draft deleted before it answers the deletion; the fixture's delete route does not.
async function deleting(path, options) {
  const value = await rest(path, options);
  if (/^\/sessions\/[^/]+\/delete$/.test(path)) {
    for (const draft of mock.control.serverDrafts || []) if (value.deleted_ids.includes(draft.session_id) && draft.text !== null) Object.assign(draft, { text: null, seq: ++mock.control.draftSeq });
  }
  return value;
}
// 500 live drafts, the most the stored state keeps, beside a draft of readme that was never synced.
function storeFullStateWithPendingReadme() {
  const known = {};
  for (let i = 0; i < 500; i++) known[`live-${i}`] = { text: `saved ${i}`, cwd: null, project: null, seen: null, edited_at: 1 };
  mock.storageData.set(STORAGE_KEY, JSON.stringify({ cursor: 0, known, pending: { readme: { text: 'only local', cwd: null, edited_at: 2 } } }));
}
afterEach(() => { mock.ctx.rest = rest; for (const controller of controllers.splice(0)) controller.dispose(); mock.reset(); });

test('text typed in the focused composer before Delete, not polled yet, is not queued by the leave hook', async () => {
  const scope = captureScope(), controller = make(), readme = target('readme');
  mock.ctx.rest = deleting;
  mock.control.serverDrafts = [{ session_id: 'readme', text: 'last observed', cwd: null, project: null, seq: 1, edited_at: 100 }];
  await controller.syncDrafts(scope);
  mock.host.state.focusedStoredSessionId.set('readme');
  mock.control.mountedDrafts.readme = 'last observed';
  await controller.enterDraft(scope, readme);
  mock.control.mountedDrafts.readme = 'typed before Delete';
  await controller.delete(scope, { id: 'readme', status: 'idle' });
  assert.equal(mock.host.state.focusedStoredSessionId.get(), null, 'the deletion opened a fresh chat');
  await controller.leaveDraft(scope, readme);
  await controller.syncDrafts(scope);
  assert.deepEqual(localIds(controller, scope), []);
  assert.deepEqual(Object.keys(stored().pending), []);
  assert.deepEqual(mock.control.draftSyncs.slice(1).flatMap(body => body.changes.map(change => change.session_id)), []);
  assert.equal(serverText('readme'), null);
});

test('with the stored state full, the deleted pending-only draft stays retired when its composer is left', async () => {
  storeFullStateWithPendingReadme();
  const scope = captureScope(), controller = make();
  mock.host.state.focusedStoredSessionId.set('readme');
  mock.control.mountedDrafts.readme = 'only local';
  await controller.enterDraft(scope, target('readme'));
  await controller.delete(scope, { id: 'readme', status: 'idle' });
  assert.equal(localIds(controller, scope).length, 500);
  await controller.leaveDraft(scope, target('readme'));
  assert.equal(localIds(controller, scope).includes('readme'), false);
  assert.equal(Object.hasOwn(stored().pending, 'readme'), false);
});

test('with the stored state full, a composer read started before the deletion cannot bring the pending-only draft back', async () => {
  storeFullStateWithPendingReadme();
  const scope = captureScope(), controller = make(), arrived = deferred(), release = deferred();
  mock.host.state.focusedStoredSessionId.set('readme');
  mock.control.mountedDrafts.readme = 'only local';
  await controller.enterDraft(scope, target('readme'));
  mock.control.readDraft = () => { arrived.resolve(); return release.promise; };
  const reading = controller.noteDraft(scope, target('readme'));
  await arrived.promise;
  await controller.delete(scope, { id: 'readme', status: 'idle' });
  release.resolve('only local');
  await reading;
  assert.equal(localIds(controller, scope).includes('readme'), false);
  assert.equal(Object.hasOwn(stored().pending, 'readme'), false);
});

test('an edit sent before the deletion but applied by the companion after it is not shown again by a later sync', async () => {
  const scope = captureScope(), controller = make(), readme = target('readme'), arrived = deferred(), release = deferred();
  let hold = false;
  mock.ctx.rest = async (path, options) => {
    if (path === '/drafts/sync' && hold) { hold = false; arrived.resolve(); await release.promise; }
    return deleting(path, options);
  };
  mock.control.serverDrafts = [{ session_id: 'readme', text: 'original', cwd: null, project: null, seq: 1, edited_at: 100 }];
  await controller.syncDrafts(scope);
  mock.host.state.focusedStoredSessionId.set('readme');
  mock.control.mountedDrafts.readme = 'original';
  await controller.enterDraft(scope, readme);
  mock.control.mountedDrafts.readme = 'edit sent before deletion';
  await controller.noteDraft(scope, readme);
  // The request has left this client; the companion handles it only after the deletion, and keeps the edit as its newest row.
  hold = true;
  const sync = controller.syncDrafts(scope);
  await arrived.promise;
  await controller.delete(scope, { id: 'readme', status: 'idle' });
  assert.equal(serverText('readme'), null);
  release.resolve();
  await sync;
  assert.equal(serverText('readme'), 'edit sent before deletion');
  assert.deepEqual(localIds(controller, scope), []);
  await controller.syncDrafts(scope);
  assert.deepEqual(localIds(controller, scope), []);
  assert.equal(stored().known.readme?.text ?? null, null);
});
