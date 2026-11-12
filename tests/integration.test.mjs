// Actual Python HTTP companion + actual frontend controller; SDK routing is a test adapter.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import plugin, { createController, buildSections } from '../desktop/plugin.js';
import { startFixture } from './child-fixture.mjs';

test('frontend controller interoperates with real FastAPI and persistent SQLite metadata', { timeout: 15000 }, async () => {
	const fixture = startFixture(process.env.PYTHON || 'python', [new URL('./backend_fixture.py', import.meta.url).pathname], { readyMs: 12000 });
	// The test's own timeout abandons this function without running its finally; the watchdog still stops the fixture so the runner can exit.
	const timeout = setTimeout(() => fixture.stop(), 14000);
	try {
		const line = await fixture.ready;
		const base = `http://127.0.0.1:${Number(line)}/api/plugins/${plugin.id}`;
		const rest = async (path, options = {}) => {
			const url = new URL(base + path);
			// Desktop's profileScoped -> pathWithProfileScope injects this even
			// when the plugin itself supplies only /runtime or /sessions.
			url.searchParams.set('profile', 'default');
			const response = await fetch(url, { method: options.method || 'GET', headers: { 'content-type': 'application/json' }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
			const body = await response.json();
			if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
			return body;
		};
		let ready = false;
		for (let attempt = 0; attempt < 40; attempt++) {
			try { await rest('/state'); ready = true; break; } catch { await delay(50); }
		}
		assert.ok(ready, `HTTP fixture did not start: ${fixture.stderr()}`);
		const scope = { connectionId: 'fixture', profile: 'default', epoch: 1 };
		let cached;
		const pageCache = new QueryClient();
		const client = {
			fetchQuery: options => pageCache.fetchQuery(options), cancelQueries: async () => {},
			setQueryData: (key, data) => { if (key.at(-1) === 'metadata') cached = data; pageCache.setQueryData(key, data); },
			removeQueries: options => pageCache.removeQueries(options), invalidateQueries: async () => {}
		};
		const route = { connectionId: 'fixture', profile: 'default', targetProfile: 'default' };
		const rpcCalls = [];
		const env = { capture: () => scope, routes: async () => [route], host: {
			async requestProfile(target, method, params) {
				assert.deepEqual(target, route); assert.equal(method, 'session.archive');
				rpcCalls.push({ method, params });
				const response = await fetch(`http://127.0.0.1:${Number(line)}/fixture/native-archive`, {
					method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...params, profile: target.targetProfile })
				});
				assert.equal(response.status, 200); return response.json();
			}
		} };
		const controller = createController({ rest }, client, env);
		const offline = await controller.metadata(scope);
		assert.deepEqual(offline.sessions, {});
		assert.equal(offline.completions.durable.done_token, 'fixture-offline-turn');
		assert.ok(offline.completions.durable.done_at > 0);
		assert.equal((await controller.list(scope)).sessions.some(row => row.id === 'durable'), true, 'completion-only old history is recovered before any organization action');
		const secondCache = new QueryClient();
		const secondClient = createController({ rest }, secondCache, env);
		try {
			assert.deepEqual((await secondClient.metadata(scope)).completions, offline.completions);
			await secondClient.ackDone(scope, { id: 'durable', completion: offline.completions.durable });
			assert.deepEqual((await controller.metadata(scope)).completions, {}, 'one client acknowledgment clears the shared backend flag');
			const produce = async turn_id => {
				const response = await fetch(`http://127.0.0.1:${Number(line)}/fixture/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'durable', turn_id }) });
				assert.equal(response.status, 200);
			};
			await produce('fixture-offline-turn');
			assert.deepEqual((await controller.metadata(scope)).completions, {}, 'a duplicate backend receipt cannot recreate a read flag');
			await produce('fixture-newer-turn');
			await secondClient.ackDone(scope, { id: 'durable', completion: offline.completions.durable });
			const current = (await controller.metadata(scope)).completions.durable;
			assert.equal(current.done_token, 'fixture-newer-turn', 'a stale acknowledgment preserves the newer completion');
			await secondClient.ackDone(scope, { id: 'durable', completion: current });
			assert.deepEqual((await controller.metadata(scope)).completions, {});
		} finally { secondClient.dispose(); secondCache.clear(); }
		const first = await controller.list(scope);
		assert.equal(first.sessions.length, 500); assert.equal(first.has_more, true);
		const live = await controller.runtime(scope);
		assert.equal(live.profile, 'default'); assert.equal(live.sessions[0].status, 'waiting');
		const older = await controller.expanded(scope, 1);
		assert.equal(older.sessions[0].id, 'durable'); assert.equal(older.sessions[0].cwd, '/old-project');
		await controller.mutate(scope, 'durable', { action: 'pin' });
		assert.equal(cached.sessions.durable.pinned, true);
		const existingArchives = await controller.archives(scope);
		assert.deepEqual(existingArchives.sessions.map(row => row.id), ['external-archived']);
		assert.equal(existingArchives.sessions[0].archived, true);
		await controller.mutate(scope, 'durable', { action: 'archive' });
		assert.equal((await rest('/sessions/durable/archive')).archived, true);
		assert.equal(cached.sessions.durable.pinned, true);
		assert.equal((await controller.list(scope)).sessions.some(row => row.id === 'durable'), false);
		const reopened = createController({ rest }, client, env);
		const recovered = await reopened.archives(scope);
		assert.equal(recovered.sessions.length, 2);
		assert.equal(buildSections(recovered.sessions, await reopened.metadata(scope), live.sessions, { project: '/old-project' }).archived[0].id, 'durable');
		await reopened.mutate(scope, 'durable', { action: 'unarchive' });
		assert.equal((await rest('/sessions/durable/archive')).archived, false);
		assert.equal((await reopened.archives(scope)).sessions.some(row => row.id === 'durable'), false);
		assert.equal((await reopened.list(scope)).sessions.some(row => row.id === 'durable'), true);
		assert.deepEqual(rpcCalls.map(call => call.params.archived), [true, false]);
		reopened.dispose();
		const wake_at = Date.now() / 1000 + 0.25;
		await controller.mutate(scope, 'durable', { action: 'snooze', wake_at });
		assert.equal(cached.sessions.durable.wake_at, wake_at);
		await delay(300);
		const woke = await controller.metadata(scope);
		assert.equal(woke.sessions.durable.state, 'active');
		assert.equal(woke.sessions.durable.updated_at, wake_at);
		assert.equal(woke.sessions.durable.woke_at, wake_at);
		await controller.mutate(scope, 'durable', { action: 'ack_wake', woke_at: wake_at - 1 });
		assert.equal((await controller.metadata(scope)).sessions.durable.woke_at, wake_at);
		await controller.mutate(scope, 'durable', { action: 'ack_wake', woke_at: wake_at });
		const acknowledged = (await controller.metadata(scope)).sessions.durable;
		assert.equal(acknowledged.woke_at, null);
		assert.equal(acknowledged.updated_at, wake_at);
		assert.equal(acknowledged.pinned, true);
		const awakeSections = buildSections((await controller.list(scope)).sessions, woke, live.sessions, { project: '/old-project' });
		assert.equal([...awakeSections.active, ...awakeSections.pinned][0].id, 'durable');
		await controller.mutate(scope, 'durable', { action: 'restore' });
		await controller.mutate(scope, 'durable', { action: 'unpin' });
		assert.equal(cached.sessions.durable.pinned, false);
		await assert.rejects(() => controller.mutate(scope, 'durable', { action: 'snooze', wake_at: 1 }), /422/);
		assert.equal((await controller.metadata(scope)).sessions.durable.state, 'active');
		controller.dispose();
		pageCache.clear();
	} finally {
		clearTimeout(timeout);
		await fixture.stop();
	}
});

test('two clients sync one draft through the real HTTP companion: it appears, the newer edit wins and a deletion propagates', { timeout: 15000 }, async () => {
	const fixture = startFixture(process.env.PYTHON || 'python', [new URL('./backend_fixture.py', import.meta.url).pathname], { readyMs: 12000 });
	const timeout = setTimeout(() => fixture.stop(), 14000);
	const clients = [];
	try {
		const port = await fixture.ready;
		const base = `http://127.0.0.1:${port}/api/plugins/${plugin.id}`;
		const posted = [];
		const rest = async (path, options = {}) => {
			const url = new URL(base + path);
			url.searchParams.set('profile', 'default');
			if (options.method === 'POST') posted.push(path);
			const response = await fetch(url, { method: options.method || 'GET', headers: { 'content-type': 'application/json' }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
			const body = await response.json();
			if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
			return body;
		};
		let ready = false;
		for (let attempt = 0; attempt < 40; attempt++) {
			try { await rest('/state'); ready = true; break; } catch { await delay(50); }
		}
		assert.ok(ready, `HTTP fixture did not start: ${fixture.stderr()}`);
		const scope = { connectionId: 'fixture', profile: 'default', epoch: 1 };
		const route = { connectionId: 'fixture', profile: 'default', targetProfile: 'default' };
		// One Desktop per client: its own plugin storage, query cache and composers (only a mounted one, present in `composers`, accepts text).
		const desktop = () => {
			const storage = new Map(), composers = {}, cache = new QueryClient();
			const host = {
				state: { focusedSessionOwner: { get: () => ({ connectionId: 'fixture', profile: 'default' }) } },
				composer: {
					getDraft: async id => composers[id] ?? null,
					setDraft: async (id, text) => { if (!(id in composers)) return false; composers[id] = text; return true; }
				}
			};
			const ctx = { rest, storage: { get: (key, fallback) => storage.has(key) ? structuredClone(storage.get(key)) : fallback, set: (key, value) => storage.set(key, structuredClone(value)) } };
			const controller = createController(ctx, cache, { capture: () => scope, routes: async () => [route], host });
			clients.push({ controller, cache });
			return { controller, cache, composers };
		};
		const a = desktop(), b = desktop();
		const target = { key: 'recent-1', ids: ['recent-1'], address: 'recent-1', cwd: '/recent' };
		const elsewhere = { key: 'recent-2', ids: ['recent-2'], address: 'recent-2', cwd: '/recent' };
		const listed = view => view.map(draft => draft.session_id);

		// Typed in A, focused on the session.
		a.composers['recent-1'] = 'typed in A';
		assert.deepEqual(listed(await a.controller.syncDrafts(scope, () => target)), ['recent-1']);
		// B, focused elsewhere, learns that the session has a draft; entering it puts the text into its empty composer.
		b.composers['recent-2'] = '';
		const seen = await b.controller.syncDrafts(scope, () => elsewhere);
		assert.deepEqual(listed(seen), ['recent-1']);
		assert.equal(JSON.stringify(seen).includes('typed in A'), false, 'the card view carries presence, not text');
		b.composers['recent-1'] = '';
		await b.controller.enterDraft(scope, target);
		assert.equal(b.composers['recent-1'], 'typed in A');

		// Both edit before either syncs; B's edit is the newer one and wins even though A sends last.
		a.composers['recent-1'] = 'older edit in A';
		await a.controller.noteDraft(scope, target);
		await delay(100);
		b.composers['recent-1'] = 'newer edit in B';
		await b.controller.noteDraft(scope, target);
		await b.controller.syncDrafts(scope, () => target);
		await a.controller.syncDrafts(scope, () => target);
		assert.equal(a.composers['recent-1'], 'newer edit in B', 'the losing composer takes the winning text');
		await b.controller.syncDrafts(scope, () => target);
		assert.equal(b.composers['recent-1'], 'newer edit in B');

		// Cleared in B: the deletion reaches A, whose composer still held the synced text.
		b.composers['recent-1'] = '';
		assert.deepEqual(listed(await b.controller.syncDrafts(scope, () => target)), []);
		assert.deepEqual(listed(await a.controller.syncDrafts(scope, () => target)), []);
		assert.equal(a.composers['recent-1'], '');
		assert.deepEqual(listed(await a.controller.syncDrafts(scope, () => target)), [], 'a cleared composer does not bring the draft back');

		assert.deepEqual([...new Set(posted)], ['/drafts/sync'], 'syncing drafts writes nothing else');
		for (const { cache } of clients) {
			const cached = JSON.stringify(cache.getQueryCache().getAll().map(query => query.state.data));
			assert.equal(/typed in A|edit in [AB]/.test(cached), false, 'no query cache holds draft text');
		}
	} finally {
		for (const { controller, cache } of clients) { controller.dispose(); cache.clear(); }
		clearTimeout(timeout);
		await fixture.stop();
	}
});
