// Actual Python HTTP companion + actual frontend controller; SDK routing is a test adapter.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { createController, buildSections } from '../desktop/plugin.js';

test('frontend controller interoperates with real FastAPI and persistent SQLite metadata', { timeout: 15000 }, async () => {
	const child = spawn(process.env.PYTHON || 'python', [new URL('./backend_fixture.py', import.meta.url).pathname], { stdio: ['ignore', 'pipe', 'pipe'] });
	const exited = once(child, 'exit');
	let stderr = '';
	child.stderr.on('data', bytes => { stderr += bytes; });
	const lines = createInterface({ input: child.stdout });
	const timeout = setTimeout(() => child.kill('SIGTERM'), 14000);
	try {
		const [line] = await once(lines, 'line');
		const base = `http://127.0.0.1:${Number(line)}/api/plugins/session-flow`;
		const rest = async (path, options = {}) => {
			const response = await fetch(base + path, { method: options.method || 'GET', headers: { 'content-type': 'application/json' }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
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
		const client = { fetchQuery: options => pageCache.fetchQuery(options), cancelQueries: async () => {}, setQueryData: (_, data) => { cached = data; }, invalidateQueries: async () => {} };
		const route = { connectionId: 'fixture', profile: 'default', targetProfile: 'default' };
		const env = { capture: () => scope, routes: async () => [route], host: {} };
		const controller = createController({ rest }, client, env);
		assert.deepEqual(await controller.metadata(scope), { version: 1, sessions: {} });
		const first = await controller.list(scope);
		assert.equal(first.sessions.length, 500); assert.equal(first.has_more, true);
		const live = await controller.runtime(scope);
		assert.equal(live.profile, 'default'); assert.equal(live.sessions[0].status, 'waiting');
		const older = await controller.expanded(scope, 1);
		assert.equal(older.sessions[0].id, 'durable'); assert.equal(older.sessions[0].cwd, '/old-project');
		await controller.mutate(scope, 'durable', { action: 'pin' });
		assert.equal(cached.sessions.durable.pinned, true);
		await controller.mutate(scope, 'durable', { action: 'settle' });
		assert.equal(cached.sessions.durable.state, 'settled');
		assert.equal(cached.sessions.durable.pinned, true);
		assert.equal(buildSections([{ id: 'tip', _lineage_root_id: 'durable' }], cached, []).settled.length, 1);
		const reopened = createController({ rest }, client, env);
		const recovered = await reopened.list(scope);
		assert.equal(recovered.sessions.length, 501);
		assert.equal(buildSections(recovered.sessions, await reopened.metadata(scope), live.sessions, { project: '/old-project' }).settled[0].id, 'durable');
		reopened.dispose();
		const wake_at = Date.now() / 1000 + 0.25;
		await controller.mutate(scope, 'durable', { action: 'snooze', wake_at });
		assert.equal(cached.sessions.durable.wake_at, wake_at);
		await delay(300);
		const woke = await controller.metadata(scope);
		assert.equal(woke.sessions.durable.state, 'active');
		assert.equal(woke.sessions.durable.updated_at, wake_at);
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
