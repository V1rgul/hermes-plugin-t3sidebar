// Draft-sync reconciliations that overlap other work: focus moves, verified deletion, Discard, reopening, and a second client.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as mock from './sdk.mock.mjs';
import { captureScope, createController } from '../desktop/plugin.js';

const STORAGE_KEY = 'drafts:source-a:default';
const stored = () => JSON.parse(mock.storageData.get(STORAGE_KEY) ?? 'null');
const target = id => ({ key: id, ids: [id], address: id, cwd: null });
const controllers = [];
function make(host = mock.host, ctx = mock.ctx) {
  const controller = createController(ctx, mock.queryClient, { capture: captureScope, routes: () => mock.host.profileRoutes(), host });
  controllers.push(controller);
  return controller;
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); mock.reset(); });

test('a composer read from an earlier entry of the focused session cannot overwrite what its later entry observed', async () => {
  const scope = captureScope(), controller = make(), arrived = deferred(), release = deferred();
  mock.control.mountedDrafts.design = 'first text';
  await controller.enterDraft(scope, target('design'));
  let held = false;
  mock.control.readDraft = id => {
    if (id === 'design' && !held) { held = true; arrived.resolve(); return release.promise; }
    return mock.control.mountedDrafts[id] ?? null;
  };
  const old = controller.noteDraft(scope, target('design'));
  await arrived.promise;
  // Focus leaves design and comes back to it, where the composer now holds newer text.
  mock.host.state.focusedStoredSessionId.set('readme');
  mock.control.mountedDrafts.readme = '';
  await controller.enterDraft(scope, target('readme'));
  mock.host.state.focusedStoredSessionId.set('design');
  mock.control.mountedDrafts.design = 'latest text';
  await controller.enterDraft(scope, target('design'));
  release.resolve('first text');
  await old;
  assert.equal(stored().pending.design.text, 'latest text');
  assert.equal(mock.control.mountedDrafts.design, 'latest text');
});

// The companion marks a deleted session's draft deleted before it answers the deletion; the fixture's delete route does not.
function withDraftDeletion(rest) {
  return async (path, options) => {
    const value = await rest(path, options);
    if (/^\/sessions\/[^/]+\/delete$/.test(path)) {
      for (const draft of mock.control.serverDrafts) if (value.deleted_ids.includes(draft.session_id) && draft.text !== null) Object.assign(draft, { text: null, seq: ++mock.control.draftSeq });
    }
    return value;
  };
}

test('a sync answered before a session\'s verified deletion cannot bring its draft back afterwards', async () => {
  const scope = captureScope(), controller = make(), rest = mock.ctx.rest, ready = deferred(), release = deferred();
  mock.control.serverDrafts = [{ session_id: 'readme', text: 'saved draft', cwd: '/projects/docs', project: null, seq: 1, edited_at: 100 }];
  let hold = false;
  const deleting = withDraftDeletion(rest);
  mock.ctx.rest = async (path, options) => {
    const value = await deleting(path, options);
    if (path === '/drafts/sync' && hold) { hold = false; ready.resolve(); await release.promise; }
    return value;
  };
  try {
    await controller.syncDrafts(scope);
    mock.host.state.focusedStoredSessionId.set('readme');
    mock.control.mountedDrafts.readme = 'saved draft';
    await controller.enterDraft(scope, target('readme'));
    mock.control.mountedDrafts.readme = 'pending edit';
    await controller.noteDraft(scope, target('readme'));
    mock.host.state.focusedStoredSessionId.set('design');
    // The companion applies the edit; its answer is delivered only after the deletion.
    hold = true;
    const sync = controller.syncDrafts(scope);
    await ready.promise;
    await controller.delete(scope, { id: 'readme', status: 'idle' });
    assert.deepEqual(controller.localDrafts(scope).map(draft => draft.session_id), []);
    release.resolve();
    await sync;
    assert.deepEqual(controller.localDrafts(scope).map(draft => draft.session_id), []);
    assert.deepEqual(Object.keys(stored().pending), []);
    assert.equal(stored().known.readme?.text ?? null, null);
  } finally { release.resolve(); mock.ctx.rest = rest; }
});

test('leaving the focused session after its verified deletion does not queue its last text again', async () => {
  const scope = captureScope(), controller = make(), rest = mock.ctx.rest;
  mock.ctx.rest = withDraftDeletion(rest);
  try {
    mock.control.serverDrafts = [{ session_id: 'readme', text: 'saved draft', cwd: '/projects/docs', project: null, seq: 1, edited_at: 100 }];
    await controller.syncDrafts(scope);
    mock.host.state.focusedStoredSessionId.set('readme');
    mock.control.mountedDrafts.readme = 'saved draft';
    await controller.enterDraft(scope, target('readme'));
    mock.control.mountedDrafts.readme = 'last pending text';
    await controller.noteDraft(scope, target('readme'));
    await controller.delete(scope, { id: 'readme', status: 'idle' });
    assert.equal(mock.host.state.focusedStoredSessionId.get(), null, 'the deletion opened a fresh chat');
    // As the sidebar does once focus has moved: the session left is reconciled one last time.
    await controller.leaveDraft(scope, target('readme'));
    await controller.syncDrafts(scope);
    assert.deepEqual(mock.control.draftSyncs.slice(1).flatMap(body => body.changes.map(change => change.session_id)), []);
    assert.deepEqual(controller.localDrafts(scope).map(draft => draft.session_id), []);
  } finally { mock.ctx.rest = rest; }
});

test('Discard retires the text its composer actually held when the clear fails, even if no poll had seen that text yet', async () => {
  const scope = captureScope(), controller = make(), design = target('design');
  mock.control.serverDrafts = [{ session_id: 'design', text: 'old synced text', cwd: null, project: null, seq: 1, edited_at: 100 }];
  await controller.syncDrafts(scope);
  mock.control.mountedDrafts.design = 'old synced text';
  await controller.enterDraft(scope, design);
  // Edited, then discarded before the next focused poll; the composer refuses the clear.
  mock.control.mountedDrafts.design = 'text actually discarded';
  mock.control.composerUnmounted = true;
  await controller.discardDraft(scope, { id: 'design' });
  assert.deepEqual(controller.localDrafts(scope).map(draft => draft.session_id), []);
  mock.control.composerUnmounted = false;
  await controller.noteDraft(scope, design);
  assert.equal(mock.control.mountedDrafts.design, '');
  assert.deepEqual(controller.localDrafts(scope).map(draft => draft.session_id), []);
  await controller.syncDrafts(scope);
  assert.equal(mock.control.serverDrafts[0].text, null);
});

test('reopening keeps the source draft when only its folder changed during the handoff', async () => {
  const scope = captureScope(), arrived = deferred(), release = deferred();
  // The new session's workspace confirmation is held until the source draft has changed.
  const host = Object.create(mock.host, { requestProfile: { value: async (route, method, params) => {
    if (method === 'session.cwd.set') { arrived.resolve(); await release.promise; }
    return mock.host.requestProfile(route, method, params);
  } } });
  const controller = make(host);
  mock.control.serverDrafts = [{ session_id: 'gone', text: 'same text', cwd: '/robot', project: null, seq: 1, edited_at: 100 }];
  await controller.syncDrafts(scope);
  const opening = controller.openDraft(scope, { id: 'gone', _draftOnly: true, _liveOnly: true, cwd: '/robot' });
  await arrived.promise;
  Object.assign(mock.control.serverDrafts[0], { cwd: '/another-project', seq: 2, edited_at: Date.now() / 1000 });
  await controller.syncDrafts(scope);
  release.resolve();
  await opening;
  assert.equal(mock.control.mountedDrafts['fixture-created'], 'same text');
  assert.equal(controller.localDrafts(scope).find(draft => draft.session_id === 'gone')?.cwd, '/another-project');
  await controller.syncDrafts(scope);
  assert.equal(mock.control.serverDrafts.find(draft => draft.session_id === 'gone')?.text, 'same text');
});
