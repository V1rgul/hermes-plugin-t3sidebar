// The draft-sync state machine of the Desktop controller, driven directly (no React tree): persistence, restoration, batching and handoff.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as mock from './sdk.mock.mjs';
import { captureScope, createController, draftSyncKey } from '../desktop/plugin.js';

const STORAGE_KEY = 'drafts:source-a:default';
const stored = () => JSON.parse(mock.storageData.get(STORAGE_KEY) ?? 'null');
const store = value => mock.storageData.set(STORAGE_KEY, JSON.stringify(value));
// The focused-composer target the sidebar hands the controller for a listed session.
const target = (id, cwd = '/projects/hermes-t3sidebar') => ({ key: id, ids: [id], address: id, cwd });
const lastSent = id => mock.control.draftSyncs?.at(-1)?.changes.find(change => change.session_id === id);
let controllers = [];
function make() { const controller = createController(mock.ctx); controllers.push(controller); return controller; }
afterEach(() => { for (const controller of controllers) controller.dispose(); controllers = []; mock.reset(); });

test('editing an already synced draft saves the new text at once, so a restart before the next sync still sends it', async () => {
	const scope = captureScope(), controller = make();
	mock.control.mountedDrafts.design = 'first version';
	await controller.noteDraft(scope, target('design'));
	await controller.syncDrafts(scope);
	assert.equal(mock.control.serverDrafts.find(draft => draft.session_id === 'design')?.text, 'first version');
	mock.control.mountedDrafts.design = 'second version';
	await controller.noteDraft(scope, target('design'));
	// Desktop closes before the next sync; the next run sends the edit from storage.
	await make().syncDrafts(scope);
	assert.equal(lastSent('design')?.text, 'second version');
	assert.equal(mock.control.serverDrafts.find(draft => draft.session_id === 'design')?.text, 'second version');
});

test('the focused poll stores and publishes nothing while the composer is unchanged', async () => {
	const scope = captureScope(), controller = make(), set = mock.ctx.storage.set, writes = [];
	mock.ctx.storage.set = function (key, value) { writes.push(key); return set.call(this, key, value); };
	try {
		mock.control.mountedDrafts.design = 'typed';
		await controller.noteDraft(scope, target('design'));
		const published = mock.queryClient.getQueryState(draftSyncKey(scope))?.dataUpdateCount, saved = writes.length;
		assert.equal(published, 1); assert.equal(saved, 1);
		for (let poll = 0; poll < 3; poll++) await controller.noteDraft(scope, target('design'));
		assert.equal(mock.queryClient.getQueryState(draftSyncKey(scope))?.dataUpdateCount, published);
		assert.equal(writes.length, saved);
	} finally { mock.ctx.storage.set = set; }
});

test('a draft edited here takes the time of its local edit, not the time it was last received', () => {
	store({ cursor: 3, known: { design: { text: 'synced', cwd: '/p', project: null, edited_at: 1000, seen: null } },
		pending: { design: { text: 'edited', cwd: '/p', edited_at: 2000 } } });
	assert.deepEqual(make().localDrafts(captureScope()).map(draft => [draft.session_id, draft.edited_at]), [['design', 2000]]);
});

test('restored draft records are validated one by one: invalid ones are dropped, valid ones of the same store survive', () => {
	store({ cursor: 2,
		known: { bare: { text: 'no time' }, badcwd: { text: 'y', cwd: 5, project: null, edited_at: 1, seen: null },
			badseen: { text: 'z', cwd: null, project: null, edited_at: 1, seen: 7 }, badproject: { text: 'p', cwd: null, project: 'robot', edited_at: 1, seen: null },
			legacy: { text: 'kept', cwd: '/p', project: null, edited_at: 5, seen: null }, marker: { text: null, cwd: null, project: null, edited_at: 6, seen: 'abc:1' } },
		pending: { textless: { edited_at: 1 }, badtime: { text: 't', edited_at: 'now' }, baddiscard: { text: '', cwd: null, edited_at: 1, discarded: 4 },
			badpcwd: { text: 'u', cwd: [], edited_at: 1 }, good: { text: 'pending', cwd: null, edited_at: 7 } } });
	const view = make().localDrafts(captureScope());
	assert.deepEqual(view.map(draft => draft.session_id).sort(), ['good', 'legacy']);
	assert.ok(view.every(draft => !Object.hasOwn(draft, 'text')), 'the view stays text-free');
});

test('beyond the retention limit, the oldest deletion markers are forgotten first, and never a live draft', async () => {
	const known = { 'live-a': { text: 'live', cwd: null, project: null, edited_at: 1, seen: null }, 'live-b': { text: 'live', cwd: null, project: null, edited_at: 2, seen: null },
		// First seen long ago, deleted most recently.
		'recent-marker': { text: null, cwd: null, project: null, edited_at: 5000, seen: null } };
	for (let index = 0; index < 499; index++) known[`marker-${index}`] = { text: null, cwd: null, project: null, edited_at: 1000 + index, seen: null };
	store({ cursor: 9, known, pending: {} });
	mock.control.mountedDrafts.design = 'typed';
	await make().noteDraft(captureScope(), target('design'));
	const kept = stored().known;
	assert.equal(Object.keys(kept).length, 500);
	assert.equal(Object.hasOwn(kept, 'recent-marker'), true);
	assert.equal(Object.hasOwn(kept, 'marker-0') || Object.hasOwn(kept, 'marker-1'), false);
	assert.equal(Object.hasOwn(kept, 'live-a') && Object.hasOwn(kept, 'live-b') && Object.hasOwn(kept, 'marker-2'), true);
});

test('an unsynced draft erased by Desktop\'s prune is put back on return, while a later clear still deletes it', async () => {
	const scope = captureScope(), controller = make(), fresh = target('fresh', null);
	// Every sync fails meanwhile, so the text exists only as a local pending change.
	mock.control.draftsError = true;
	mock.host.state.focusedStoredSessionId.set('fresh'); mock.control.mountedDrafts.fresh = 'unsent';
	await controller.enterDraft(scope, fresh);
	mock.host.state.focusedStoredSessionId.set('design');
	await controller.leaveDraft(scope, fresh);
	delete mock.control.mountedDrafts.fresh;
	// Back on it: its composer opens empty.
	mock.control.mountedDrafts.fresh = '';
	mock.host.state.focusedStoredSessionId.set('fresh');
	await controller.enterDraft(scope, fresh);
	assert.equal(mock.control.mountedDrafts.fresh, 'unsent');
	assert.deepEqual(controller.localDrafts(scope).map(draft => draft.session_id), ['fresh']);
	// Once entered, clearing the composer is a deletion, and stays one when the session is entered again.
	mock.control.mountedDrafts.fresh = '';
	await controller.noteDraft(scope, fresh);
	await controller.enterDraft(scope, fresh);
	assert.equal(mock.control.mountedDrafts.fresh, '');
	mock.control.draftsError = false;
	await controller.syncDrafts(scope);
	assert.equal(lastSent('fresh')?.text, '');
});

// A pending change as an older run of this client stored it.
const change = (text, edited_at = 100) => ({ text, cwd: null, edited_at });

for (const synced of [false, true]) {
	test(`a prompt sent and left before the next focused poll is not kept as a draft (${synced ? 'synced' : 'not synced yet'})`, async () => {
		const scope = captureScope(), controller = make(), design = target('design');
		mock.host.state.focusedStoredSessionId.set('design'); mock.control.mountedDrafts.design = 'the prompt';
		await controller.enterDraft(scope, design);
		if (synced) await controller.syncDrafts(scope);
		// Sent: Desktop empties the composer, and focus moves on before the 2 s poll sees it; Desktop copies the empty composer as it leaves.
		mock.control.mountedDrafts.design = '';
		mock.host.state.focusedStoredSessionId.set('alpha');
		delete mock.control.mountedDrafts.design; mock.control.drafts.design = '';
		await controller.leaveDraft(scope, design);
		assert.deepEqual(controller.localDrafts(scope), []);
		// Back on it, the sent text is not put into its composer again.
		mock.control.mountedDrafts.design = '';
		mock.host.state.focusedStoredSessionId.set('design');
		await controller.enterDraft(scope, design);
		assert.equal(mock.control.mountedDrafts.design, '');
		await controller.syncDrafts(scope);
		assert.equal(lastSent('design')?.text, '');
		assert.equal(mock.control.serverDrafts.find(draft => draft.session_id === 'design')?.text ?? null, null);
	});
}

test('leaving a session whose entry never reconciled its composer keeps its draft, whose local copy may be pruned', async () => {
	const scope = captureScope(), controller = make(), design = target('design');
	mock.control.serverDrafts = [{ session_id: 'design', text: 'kept', cwd: null, project: null, seq: 1, edited_at: Date.now() / 1000 }];
	await controller.syncDrafts(scope);
	// Its composer matched the draft once, then focus left with a local copy.
	mock.host.state.focusedStoredSessionId.set('design'); mock.control.mountedDrafts.design = 'kept';
	await controller.enterDraft(scope, design);
	mock.host.state.focusedStoredSessionId.set('alpha');
	delete mock.control.mountedDrafts.design; mock.control.drafts.design = 'kept';
	await controller.leaveDraft(scope, design);
	// Desktop's prune erases the copy; focus passes through the session and leaves before its composer mounts.
	delete mock.control.drafts.design;
	mock.host.state.focusedStoredSessionId.set('design');
	mock.host.state.focusedStoredSessionId.set('alpha');
	await controller.leaveDraft(scope, design);
	assert.deepEqual(controller.localDrafts(scope).map(draft => draft.session_id), ['design']);
});

test('a large backlog goes up in batches the companion accepts, and a text it would refuse stays pending here without blocking the rest', async () => {
	const pending = { oversized: change('x'.repeat(200_001)) };
	for (let index = 0; index < 450; index++) pending[`backlog-${index}`] = change(`draft ${index}`);
	// Counted in code points, as the companion counts: within the limit, though longer in UTF-16 units.
	pending.astral = change('\u{1F600}'.repeat(100_001));
	store({ cursor: 0, known: {}, pending });
	const scope = captureScope(), controller = make();
	await controller.syncDrafts(scope);
	const bodies = mock.control.draftSyncs;
	assert.ok(bodies.every(body => body.changes.length <= 200), `batch sizes ${bodies.map(body => body.changes.length)}`);
	const sent = bodies.flatMap(body => body.changes.map(item => item.session_id));
	assert.equal(new Set(sent).size, 451); assert.equal(sent.length, 451);
	assert.equal(sent.includes('oversized'), false);
	assert.equal(mock.control.serverDrafts.length, 451);
	// The refused text is kept, still shown as a draft, and sent once it fits.
	assert.deepEqual(Object.keys(stored().pending), ['oversized']);
	assert.ok(controller.localDrafts(scope).some(draft => draft.session_id === 'oversized'));
});

test('a sync response that does not acknowledge each sent change, or repeats a session, changes nothing locally', async () => {
	const rest = mock.ctx.rest;
	for (const alter of [drafts => drafts.filter(draft => draft.session_id !== 'second'), drafts => [...drafts, drafts[0]]]) {
		mock.reset();
		store({ cursor: 0, known: {}, pending: { first: change('one'), second: change('two') } });
		const before = mock.storageData.get(STORAGE_KEY), scope = captureScope(), controller = make();
		mock.ctx.rest = async (path, options) => { const value = await rest(path, options); return { ...value, drafts: alter(value.drafts) }; };
		try { await assert.rejects(controller.syncDrafts(scope), /Invalid current-profile drafts response/); }
		finally { mock.ctx.rest = rest; }
		assert.equal(mock.storageData.get(STORAGE_KEY), before);
		await controller.syncDrafts(scope);
		assert.deepEqual(mock.control.draftSyncs.at(-1).changes.map(item => item.session_id).sort(), ['first', 'second']);
	}
});

test('a sync still in flight from a previous gateway activation is not shared with the new one', async () => {
	const rest = mock.ctx.rest, scope = captureScope(), controller = make();
	let reached, release;
	const arrived = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
	mock.ctx.rest = async (path, options) => { if (path === '/drafts/sync' && !release.used) { release.used = true; reached(); await gate; } return rest(path, options); };
	try {
		const old = controller.syncDrafts(scope);
		await arrived;
		mock.switchScope('source-a', 'default');
		const next = captureScope();
		assert.notEqual(next.epoch, scope.epoch);
		assert.ok(Array.isArray(await controller.syncDrafts(next)), 'the new activation syncs on its own');
		release();
		await assert.rejects(old, /Source\/profile changed/);
	} finally { mock.ctx.rest = rest; }
});

test('reopening a draft deletes only the version it copied: a newer one received during the handoff stays', async () => {
	let release, reached;
	const gate = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
	// The new session's workspace confirmation is held until the test lets it through.
	const host = Object.create(mock.host, { request: { value: async (method, params) => {
		if (method === 'session.cwd.set') { reached(); await gate; }
		return mock.host.request(method, params);
	} } });
	const controller = createController(mock.ctx, mock.queryClient, { capture: captureScope, routes: () => mock.host.profileRoutes(), host }), scope = captureScope();
	controllers.push(controller);
	mock.control.serverDrafts = [{ session_id: 'gone', text: 'Reopen me', cwd: '/robot', project: null, seq: 7, edited_at: Date.now() / 1000 }];
	await controller.syncDrafts(scope);
	const opening = controller.openDraft(scope, { id: 'gone', _draftOnly: true, _liveOnly: true, cwd: '/robot' });
	await arrived;
	// Another client edits the source draft meanwhile, and this one receives it.
	Object.assign(mock.control.serverDrafts[0], { text: 'Edited elsewhere', seq: 8, edited_at: Date.now() / 1000 });
	await controller.syncDrafts(scope);
	release();
	await opening;
	await controller.syncDrafts(scope);
	assert.equal(mock.control.mountedDrafts['fixture-created'], 'Reopen me');
	const server = Object.fromEntries(mock.control.serverDrafts.map(draft => [draft.session_id, draft.text]));
	assert.deepEqual(server, { gone: 'Edited elsewhere', 'fixture-created': 'Reopen me' });
});

test('deleting a session forgets its local draft: no draft card returns and its pending edit is never sent', async () => {
	store({ cursor: 3, known: { readme: { text: 'synced', cwd: '/projects/docs', project: null, edited_at: 100, seen: null } },
		pending: { readme: change('unsent edit', Date.now() / 1000), design: change('kept', Date.now() / 1000) } });
	const scope = captureScope(), controller = make();
	assert.deepEqual(controller.localDrafts(scope).map(draft => draft.session_id).sort(), ['design', 'readme']);
	await controller.delete(scope, { id: 'readme', status: 'idle' });
	assert.deepEqual(mock.queryClient.getQueryData(draftSyncKey(scope))?.map(draft => draft.session_id), ['design']);
	assert.deepEqual(make().localDrafts(scope).map(draft => draft.session_id), ['design'], 'also after a restart');
	await controller.syncDrafts(scope);
	assert.deepEqual(mock.control.draftSyncs.flatMap(body => body.changes.map(item => item.session_id)), ['design']);
});

test('a reconciliation of a session focus has left neither writes its composer nor counts as the entry of the session focused now', async () => {
	const scope = captureScope(), controller = make();
	mock.control.serverDrafts = [{ session_id: 'design', text: 'b text', cwd: null, project: null, seq: 1, edited_at: Date.now() / 1000 },
		{ session_id: 'alpha', text: 'a text', cwd: null, project: null, seq: 2, edited_at: Date.now() / 1000 }];
	await controller.syncDrafts(scope);
	let release, reached;
	const gate = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
	mock.control.readDraft = id => {
		if (id === 'alpha' && !reached.used) { reached.used = true; reached(); return gate; }
		return Object.hasOwn(mock.control.mountedDrafts, id) ? mock.control.mountedDrafts[id] : mock.control.drafts[id] ?? null;
	};
	// Entering alpha, whose composer Desktop emptied: its read is still in flight when focus moves on to design.
	mock.host.state.focusedStoredSessionId.set('alpha'); mock.control.mountedDrafts.alpha = '';
	const enteringAlpha = controller.enterDraft(scope, target('alpha'));
	await arrived;
	mock.host.state.focusedStoredSessionId.set('design'); mock.control.mountedDrafts.design = 'b text';
	await controller.enterDraft(scope, target('design'));
	release('');
	await enteringAlpha;
	assert.equal(mock.control.mountedDrafts.alpha, '', 'the composer focus left is not written');
	// Clearing design after its entry settled deletes its draft rather than restoring it.
	mock.control.mountedDrafts.design = '';
	await controller.noteDraft(scope, target('design'));
	assert.equal(mock.control.mountedDrafts.design, '');
	await controller.syncDrafts(scope);
	assert.equal(lastSent('design')?.text, '');
});

test('a discarded draft whose composer could not be cleared stays discarded, while a later edit there is a draft again', async () => {
	const scope = captureScope(), controller = make(), design = target('design');
	mock.control.serverDrafts = [{ session_id: 'design', text: 'synced copy', cwd: null, project: null, seq: 1, edited_at: Date.now() / 1000 }];
	await controller.syncDrafts(scope);
	mock.control.mountedDrafts.design = 'synced copy';
	await controller.enterDraft(scope, design);
	// The focused composer refuses the clear.
	mock.control.composerUnmounted = true;
	await controller.discardDraft(scope, { id: 'design' });
	assert.equal(mock.control.mountedDrafts.design, 'synced copy');
	mock.control.composerUnmounted = false;
	await controller.noteDraft(scope, design);
	assert.equal(mock.control.mountedDrafts.design, '', 'the next focused check clears it');
	await controller.syncDrafts(scope);
	assert.equal(lastSent('design')?.text, '');
	assert.equal(mock.control.serverDrafts[0].text, null);
	mock.control.mountedDrafts.design = 'new words';
	await controller.noteDraft(scope, design);
	await controller.syncDrafts(scope);
	assert.equal(mock.control.serverDrafts[0].text, 'new words');
});
