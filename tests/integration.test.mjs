// Actual Python HTTP companion + actual frontend controller; SDK routing is a test adapter.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import plugin, { createController, buildSections } from '../desktop/plugin.js';

test('frontend controller interoperates with real FastAPI and persistent SQLite metadata', { timeout: 15000 }, async () => {
	const child = spawn(process.env.PYTHON || 'python', [new URL('./backend_fixture.py', import.meta.url).pathname], { stdio: ['ignore', 'pipe', 'pipe'] });
	const exited = once(child, 'exit');
	let stderr = '';
	child.stderr.on('data', bytes => { stderr += bytes; });
	const lines = createInterface({ input: child.stdout });
	const timeout = setTimeout(() => child.kill('SIGTERM'), 14000);
	try {
		const [line] = await once(lines, 'line');
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
		assert.ok(ready, `HTTP fixture did not start: ${stderr}`);
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
		lines.close();
		child.kill('SIGTERM');
		await exited;
	}
});
