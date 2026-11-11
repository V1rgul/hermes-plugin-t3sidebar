// The default new chat (archive-and-advance with nothing left to open) is fenced like every other native action.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createController, captureScope } from '../desktop/plugin.js';
import * as mock from './sdk.mock.mjs';

afterEach(() => mock.reset());

test('a default new chat that resolves after a source switch is rejected', async () => {
	const scope = captureScope();
	const host = { ...mock.host, async newChat(route) { mock.host.newChat(route); mock.switchScope('source-b'); } };
	const controller = createController(mock.ctx, mock.queryClient, { capture: captureScope, routes: mock.host.profileRoutes, host });
	await assert.rejects(controller.newChat(scope), /Source\/profile changed/);
	assert.equal(mock.calls.filter(call => call[0] === 'new').length, 1);
	controller.dispose();
});

test('a default new chat that resolves after disposal is rejected', async () => {
	const scope = captureScope();
	let controller;
	const host = { ...mock.host, async newChat(route) { mock.host.newChat(route); controller.dispose(); } };
	controller = createController(mock.ctx, mock.queryClient, { capture: captureScope, routes: mock.host.profileRoutes, host });
	await assert.rejects(controller.newChat(scope), /Source\/profile changed/);
});

test('a default new chat in an unchanged scope still opens through the owning route', async () => {
	const scope = captureScope();
	const controller = createController(mock.ctx, mock.queryClient, { capture: captureScope, routes: mock.host.profileRoutes, host: mock.host });
	await controller.newChat(scope);
	assert.deepEqual(mock.calls.filter(call => call[0] === 'new').map(call => [call[1].connectionId, call[1].profile]), [['source-a', 'default']]);
	controller.dispose();
});
