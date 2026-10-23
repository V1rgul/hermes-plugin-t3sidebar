import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snoozePresets } from '../desktop/plugin.js';

test('fourth snooze preset uses the next calendar Monday at local 08:00 across weekdays and DST', () => {
	const previous = process.env.TZ;
	try {
		for (const timezone of ['UTC', 'Europe/Paris', 'America/New_York']) {
			process.env.TZ = timezone;
			for (const [input, expected] of [
				['2026-10-19T00:01:00', '2026-10-26T08:00:00'],
				['2026-10-19T08:00:00', '2026-10-26T08:00:00'],
				['2026-10-19T23:59:59', '2026-10-26T08:00:00'],
				['2026-10-20T17:00:00', '2026-10-26T08:00:00'],
				['2026-10-21T17:00:00', '2026-10-26T08:00:00'],
				['2026-10-22T17:00:00', '2026-10-26T08:00:00'],
				['2026-10-23T17:00:00', '2026-10-26T08:00:00'],
				['2026-10-24T17:00:00', '2026-10-26T08:00:00'],
				['2026-10-25T23:59:59', '2026-10-26T08:00:00'],
				['2026-10-26T07:59:59', '2026-11-02T08:00:00'],
				['2026-03-27T23:45:59', '2026-03-30T08:00:00'],
				['2026-03-06T17:00:00', '2026-03-09T08:00:00'],
				['2026-10-30T17:00:00', '2026-11-02T08:00:00'],
				['2026-12-31T17:00:00', '2027-01-04T08:00:00'],
				['2028-02-29T17:00:00', '2028-03-06T08:00:00']
			]) {
				const now = new Date(input).getTime(), presets = snoozePresets(now);
				assert.deepEqual(presets.map(preset => preset.label), ['In 1 hour', 'In 3 hours', 'Tomorrow at 9:00', 'Next Monday at 8:00']);
				assert.equal(presets[0].wake_at, now / 1000 + 3600);
				assert.equal(presets[1].wake_at, now / 1000 + 10800);
				const wake = new Date(presets[3].wake_at * 1000);
				assert.equal(wake.getTime(), new Date(expected).getTime(), `${timezone}: ${input}`);
				assert.equal(wake.getDay(), 1); assert.equal(wake.getHours(), 8);
				assert.equal(wake.getMinutes(), 0); assert.equal(wake.getSeconds(), 0);
				assert.ok(wake.getTime() > now);
			}
		}
	} finally {
		if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
	}
});
