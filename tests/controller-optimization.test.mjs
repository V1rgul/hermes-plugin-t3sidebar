// Synthetic SDK fixtures with real Query/Mutation observers, never live state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { QueryClient, QueryObserver, MutationObserver } from '@tanstack/react-query';
import { createController, captureScope, scopeKey } from '../desktop/plugin.js';
import * as mock from './sdk.mock.mjs';

function gate() {
	let release, enter;
	const started = new Promise(resolve => { enter = resolve; });
	const waiting = new Promise(resolve => { release = resolve; });
	return { started, release, async wait() { enter(); await waiting; } };
}

function fixture(t, action, { disabledWhileMutating = false, failure } = {}) {
	mock.reset();
	const scope = captureScope(), key = [...scopeKey(scope), 'metadata'], verification = gate();
	mock.control.metadata.sessions.design = { state: action === 'restore' ? 'settled' : 'active', pinned: false, wake_at: null, woke_at: 123 };
	mock.control.metadata.completions = { design: { done_token: 'done-123', done_at: 123 } };
	const initial = structuredClone(mock.control.metadata);
	const payload = { action, ...(action === 'snooze' ? { wake_at: Math.floor(Date.now() / 1000) + 3600 } : action === 'ack_done' ? { done_token: 'done-123' } : action === 'ack_wake' ? { woke_at: 123 } : {}) };
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
	client.setQueryData(key, initial);
	let stateReads = 0, posts = 0, invalidations = 0;
	const originalInvalidate = client.invalidateQueries.bind(client);
	client.invalidateQueries = (...args) => { invalidations++; return originalInvalidate(...args); };
	const controller = createController({ ...mock.ctx, rest: async (path, options) => {
		if (options?.method === 'POST') {
			posts++;
			if (failure === 'unconfirmed') mock.control.dropWrite = true;
			await mock.ctx.rest(path, options);
			if (failure === 'ambiguous') throw new Error('reply lost after commit');
			return { version: 999, sessions: {} }; // A POST response is never independent verification.
		}
		if (path === '/state') {
			stateReads++;
			if (stateReads === 1) { await verification.wait(); if (failure === 'readback') throw new Error('readback unavailable'); }
		}
		return mock.ctx.rest(path, options);
	} }, client);
	const options = { queryKey: key, queryFn: () => controller.metadata(scope), staleTime: 2000, retry: false, enabled: true };
	const observer = new QueryObserver(client, options), observed = [];
	const unsubscribe = observer.subscribe(result => observed.push(result.data));
	const mutation = new MutationObserver(client, { mutationFn: () => controller.mutate(scope, 'design', payload) });
	const stopMutation = mutation.subscribe(result => {
		if (disabledWhileMutating) observer.setOptions({ ...options, enabled: !result.isPending });
	});
	t.after(() => { verification.release(); stopMutation(); unsubscribe(); controller.dispose(); client.clear(); });
	return { scope, key, client, controller, observer, mutation, verification, initial, observed, payload,
		get stateReads() { return stateReads; }, get posts() { return posts; }, get invalidations() { return invalidations; } };
}

for (const action of ['pin', 'snooze', 'restore', 'ack_done', 'ack_wake']) {
	for (const disabledWhileMutating of [false, true]) {
		test(`${action} publishes independent readback without a duplicate metadata fetch (${disabledWhileMutating ? 'mutation-disabled/re-enabled' : 'active'} observer)`, { timeout: 3000 }, async t => {
			const f = fixture(t, action, { disabledWhileMutating });
			const work = f.mutation.mutate();
			await f.verification.started;
			assert.deepEqual(f.client.getQueryData(f.key), f.initial, 'no optimistic or POST-response publication');
			assert.equal(f.posts, 1); assert.equal(f.stateReads, 1);
			assert.equal(f.observer.options.enabled, !disabledWhileMutating);
			f.verification.release();
			const verified = await work;
			await delay(10);
			assert.equal(f.observer.options.enabled, true);
			assert.deepEqual(f.client.getQueryData(f.key), verified);
			assert.deepEqual(f.observer.getCurrentResult().data, verified);
			assert.ok(f.observed.some(value => JSON.stringify(value) === JSON.stringify(verified)));
			assert.equal(f.client.getQueryState(f.key).isInvalidated, false);
			assert.equal(f.invalidations, 0, 'verified metadata must not be invalidated in finally');
			assert.equal(f.stateReads, 1, 'publication and observer re-enable must not reread metadata');
			await f.observer.refetch();
			assert.equal(f.stateReads, 2, 'ordinary recovery refetch remains available');
			await f.client.invalidateQueries({ queryKey: f.key, exact: true });
			assert.equal(f.stateReads, 3, 'later history-event invalidation still reconciles');
		});

		test(`${action} verification failure retains reconciliation (${disabledWhileMutating ? 'mutation-disabled/re-enabled' : 'active'} observer)`, { timeout: 3000 }, async t => {
			const f = fixture(t, action, { disabledWhileMutating, failure: 'unconfirmed' });
			const rejected = assert.rejects(f.mutation.mutate(), /did not confirm/);
			await f.verification.started;
			f.verification.release(); await rejected; await delay(10);
			assert.equal(f.observer.options.enabled, true);
			assert.equal(f.invalidations, 1);
			assert.equal(f.stateReads, 2, 'failed verification must trigger independent recovery');
			assert.deepEqual(f.client.getQueryData(f.key), f.initial);
		});
	}

	test(`${action} cannot publish across an activation-epoch ABA during readback`, { timeout: 3000 }, async t => {
		const f = fixture(t, action);
		const rejected = assert.rejects(f.mutation.mutate(), /Source\/profile changed/);
		await f.verification.started;
		mock.switchScope(); mock.switchScope('source-a');
		f.verification.release(); await rejected;
		assert.deepEqual(f.client.getQueryData(f.key), f.initial);
		assert.equal(f.invalidations, 0);
	});
}

for (const failure of ['ambiguous', 'readback']) {
	test(`${failure} metadata failure still reconciles an observed query`, { timeout: 3000 }, async t => {
		const f = fixture(t, 'pin', { disabledWhileMutating: true, failure });
		const rejected = assert.rejects(f.mutation.mutate(), /reply lost|readback unavailable/);
		if (failure === 'readback') await f.verification.started;
		f.verification.release(); await rejected; await delay(10);
		assert.equal(f.invalidations, 1);
		assert.equal(f.stateReads, failure === 'ambiguous' ? 1 : 2);
		assert.equal(f.client.getQueryData(f.key).sessions.design.pinned, true, 'recovery observes the committed metadata');
	});
}