// Pin and snooze rely on the companion's own archived-session refusal instead of reading the archive flag first.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createController, captureScope, scopeKey } from '../desktop/plugin.js';
import * as mock from './sdk.mock.mjs';

const UNARCHIVE_FIRST = 'Unarchive this session before pinning or snoozing it.';
// How the companion's HTTPException(409, "native_session_archived") reaches a plugin: the Webapp's fetch transport throws "<status>: <body>", and Electron's IPC bridge wraps that message.
const REFUSALS = {
	webapp: '409: {"detail":"native_session_archived"}',
	electron: 'Error invoking remote method \'hermes:api\': Error: 409: {"detail":"native_session_archived"}'
};
const payloads = () => [{ action: 'pin' }, { action: 'snooze', wake_at: Math.floor(Date.now() / 1000) + 3600 }];
function controllerWith(rest) {
	return createController({ ...mock.ctx, rest }, mock.queryClient, { capture: captureScope, routes: mock.host.profileRoutes, host: mock.host });
}
afterEach(() => mock.reset());

test('pin and snooze write once and confirm through /state, without a client archive read', async () => {
	for (const payload of payloads()) {
		mock.reset();
		const controller = controllerWith((path, options) => mock.ctx.rest(path, options)), scope = captureScope();
		await controller.mutate(scope, 'design', payload);
		const rest = mock.calls.filter(call => call[0] === 'rest').map(call => [call[1], call[2]?.method ?? 'GET']);
		assert.deepEqual(rest, [['/sessions/design', 'POST'], ['/state', 'GET']], payload.action);
		assert.equal(mock.queryClient.getQueryData([...scopeKey(scope), 'metadata']).sessions.design.state, payload.action === 'snooze' ? 'snoozed' : 'active');
		controller.dispose();
	}
});

for (const [transport, message] of Object.entries(REFUSALS)) test(`the companion's archived refusal through the ${transport} transport keeps the unarchive message`, async () => {
	for (const payload of payloads()) {
		mock.reset();
		const controller = controllerWith(async (path, options) => {
			if (options?.method === 'POST') throw new Error(message);
			return mock.ctx.rest(path, options);
		});
		await assert.rejects(controller.mutate(captureScope(), 'design', payload), error => error.message === UNARCHIVE_FIRST);
		controller.dispose();
	}
});

test('other write failures keep their own message', async () => {
	for (const message of ['409: {"detail":"another_conflict"}', '503: {"detail":"native_archive_state_unavailable"}', 'fixture metadata write failed']) {
		mock.reset();
		const controller = controllerWith(async (path, options) => {
			if (options?.method === 'POST') throw new Error(message);
			return mock.ctx.rest(path, options);
		});
		await assert.rejects(controller.mutate(captureScope(), 'design', { action: 'pin' }), error => error.message === message);
		controller.dispose();
	}
});
