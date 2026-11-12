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
