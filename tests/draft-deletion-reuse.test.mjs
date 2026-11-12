// A verified deletion retires what predates it (a sync answer already on its way, the deleted session's last composer text), never the session id itself.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as mock from './sdk.mock.mjs';
import { captureScope, createController } from '../desktop/plugin.js';

const STORAGE_KEY = 'drafts:source-a:default';
const stored = () => JSON.parse(mock.storageData.get(STORAGE_KEY) ?? 'null');
const target = id => ({ key: id, ids: [id], address: id, cwd: null });
const ids = (controller, scope) => controller.localDrafts(scope).map(draft => draft.session_id);
const serverDraft = (session_id, text, seq) => ({ session_id, text, cwd: '/projects/docs', project: null, seq, edited_at: Date.now() / 1000 });
const controllers = [], directories = [];
function make() {
  const controller = createController(mock.ctx, mock.queryClient, { capture: captureScope, routes: () => mock.host.profileRoutes(), host: mock.host });
  controllers.push(controller);
  return controller;
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const rest = mock.ctx.rest;
afterEach(() => {
  mock.ctx.rest = rest;
  for (const controller of controllers.splice(0)) controller.dispose();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  mock.reset();
});
// The companion marks a deleted session's draft deleted before it answers the deletion; the fixture's delete route does not.
function withDraftDeletion(next) {
  return async (route, options) => {
    const value = await next(route, options);
    if (/^\/sessions\/[^/]+\/delete$/.test(route)) {
      for (const draft of mock.control.serverDrafts) if (value.deleted_ids.includes(draft.session_id) && draft.text !== null) Object.assign(draft, { text: null, seq: ++mock.control.draftSeq });
    }
    return value;
  };
}

test('a draft another client writes for a session after its verified deletion is received, also after a new activation and a restart', async () => {
  const controller = make(), scope = captureScope();
  mock.ctx.rest = withDraftDeletion(rest);
  mock.control.serverDrafts = [serverDraft('readme', 'original draft', 1)];
  await controller.syncDrafts(scope);
  await controller.delete(scope, { id: 'readme', status: 'idle' });
  await controller.syncDrafts(scope);
  assert.deepEqual(ids(controller, scope), []);
  // Drafts need no stored history: another client saves new text addressed to that id.
  Object.assign(mock.control.serverDrafts[0], { text: 'written after the deletion', seq: ++mock.control.draftSeq, edited_at: Date.now() / 1000 });
  await controller.syncDrafts(scope);
  assert.deepEqual(ids(controller, scope), ['readme']);
  mock.switchScope('source-a');
  const next = captureScope();
  await controller.syncDrafts(next);
  assert.deepEqual(ids(controller, next), ['readme']);
  assert.equal(stored().known.readme.text, 'written after the deletion');
  const restarted = make();
  await restarted.syncDrafts(next);
  assert.deepEqual(ids(restarted, next), ['readme']);
});

test('a sync sent before a deletion but answered with a newer draft for that session leaves the draft for the next sync', async () => {
  const controller = make(), scope = captureScope(), arrived = deferred(), release = deferred();
  mock.control.serverDrafts = [serverDraft('readme', 'original draft', 1)];
  await controller.syncDrafts(scope);
  let hold = false;
  const deleting = withDraftDeletion(rest);
  mock.ctx.rest = async (route, options) => {
    // The request leaves before the deletion; the companion handles it only after the deletion and a new draft for that id.
    if (route === '/drafts/sync' && hold) { hold = false; arrived.resolve(); await release.promise; }
    return deleting(route, options);
  };
  hold = true;
  const sync = controller.syncDrafts(scope);
  await arrived.promise;
  await controller.delete(scope, { id: 'readme', status: 'idle' });
  Object.assign(mock.control.serverDrafts[0], { text: 'written after the deletion', seq: ++mock.control.draftSeq, edited_at: Date.now() / 1000 });
  release.resolve();
  await sync;
  await controller.syncDrafts(scope);
  assert.deepEqual(ids(controller, scope), ['readme']);
  assert.equal(stored().known.readme.text, 'written after the deletion');
});

test('a composer read started before its session\'s deletion does not queue the draft that was only local', async () => {
  const controller = make(), scope = captureScope(), readme = target('readme'), arrived = deferred(), release = deferred();
  mock.host.state.focusedStoredSessionId.set('readme');
  mock.control.mountedDrafts.readme = 'never synced';
  await controller.enterDraft(scope, readme);
  mock.control.readDraft = () => { arrived.resolve(); return release.promise; };
  const note = controller.noteDraft(scope, readme);
  await arrived.promise;
  await controller.delete(scope, { id: 'readme', status: 'idle' });
  release.resolve('never synced');
  await note;
  await controller.leaveDraft(scope, readme);
  assert.deepEqual(ids(controller, scope), []);
  assert.deepEqual(Object.keys(stored().pending), []);
});

test('an edit sent before its session\'s deletion does not stand for the composer\'s later text once the answer comes back', async () => {
  const controller = make(), scope = captureScope(), readme = target('readme'), arrived = deferred(), release = deferred();
  mock.control.serverDrafts = [serverDraft('readme', 'saved draft', 1)];
  await controller.syncDrafts(scope);
  mock.host.state.focusedStoredSessionId.set('readme');
  mock.control.mountedDrafts.readme = 'saved draft';
  await controller.enterDraft(scope, readme);
  mock.control.mountedDrafts.readme = 'first edit';
  await controller.noteDraft(scope, readme);
  let hold = true;
  const deleting = withDraftDeletion(rest);
  mock.ctx.rest = async (route, options) => {
    const value = await deleting(route, options);
    if (route === '/drafts/sync' && hold) { hold = false; arrived.resolve(); await release.promise; }
    return value;
  };
  const sync = controller.syncDrafts(scope);
  await arrived.promise;
  // Typed while the first edit was on its way, then the session is deleted before the answer arrives.
  mock.control.mountedDrafts.readme = 'second edit';
  await controller.noteDraft(scope, readme);
  await controller.delete(scope, { id: 'readme', status: 'idle' });
  release.resolve();
  await sync;
  await controller.leaveDraft(scope, readme);
  await controller.syncDrafts(scope);
  assert.deepEqual(ids(controller, scope), []);
  assert.equal(mock.control.serverDrafts[0].text, null);
});

// The companion's real draft store, in a scratch SQLite file.
const STORE = `import json, sys
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from session_drafts import DraftStore
request = json.load(sys.stdin)
store = DraftStore(Path(sys.argv[2]))
if request.get("delete"):
\tstore.delete(request["delete"])
\tprint("null")
else:
\tbody = request["body"]
\tprint(json.dumps({**store.sync(body["since"], body["changes"], body["sent_at"]), "profile": "default"}))
`;
function realStore() {
  const directory = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'draft-deletion-reuse-'));
  directories.push(directory);
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  return request => JSON.parse(execFileSync(process.env.PYTHON || 'python', ['-c', STORE, root, path.join(directory, 'drafts.sqlite3')], { input: JSON.stringify(request), encoding: 'utf8' }));
}

test('a new draft the companion\'s store accepts for a session after its verified deletion reaches the sidebar', async () => {
  const call = realStore(), controller = make(), scope = captureScope();
  const save = text => call({ body: { since: 0, sent_at: Date.now() / 1000, changes: [{ session_id: 'readme', text, edited_at: Date.now() / 1000, cwd: '/projects/docs' }] } });
  mock.ctx.rest = async (route, options) => {
    if (route === '/drafts/sync') return call({ body: options.body });
    const value = await rest(route, options);
    if (/^\/sessions\/[^/]+\/delete$/.test(route)) call({ delete: value.deleted_ids });
    return value;
  };
  save('original draft');
  await controller.syncDrafts(scope);
  assert.deepEqual(ids(controller, scope), ['readme']);
  await controller.delete(scope, { id: 'readme', status: 'idle' });
  await controller.syncDrafts(scope);
  assert.deepEqual(ids(controller, scope), []);
  assert.equal(save('written after the deletion').drafts.find(draft => draft.session_id === 'readme')?.text, 'written after the deletion');
  mock.switchScope('source-a');
  const next = captureScope();
  await controller.syncDrafts(next);
  assert.deepEqual(ids(controller, next), ['readme']);
});
