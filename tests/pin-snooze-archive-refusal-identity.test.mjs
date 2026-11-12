// Only the companion's exact archived-session refusal (HTTP 409, detail native_session_archived) becomes the Unarchive message; any other refusal keeps its own text.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createController, captureScope } from '../desktop/plugin.js';
import * as mock from './sdk.mock.mjs';

afterEach(() => mock.reset());

for (const message of [
	'409: {"detail":"not_native_session_archived"}',
	'409: {"detail":"another_conflict","diagnostic":"native_session_archived"}',
	'Error invoking remote method \'hermes:api\': Error: 409: {"detail":"native_session_archived_soon"}',
	'409: native_session_archived',
	'503: {"detail":"native_session_archived"}'
]) test(`a pin refused with ${message} keeps that refusal`, async () => {
	const controller = createController({ ...mock.ctx, rest: async (path, options) => {
		if (options?.method === 'POST') throw new Error(message);
		return mock.ctx.rest(path, options);
	} });
	try {
		await assert.rejects(controller.mutate(captureScope(), 'design', { action: 'pin' }), error => error.message === message);
	} finally { controller.dispose(); }
});
