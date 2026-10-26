import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snoozePresets, snoozePreciseRemaining } from '../desktop/plugin.js';

test('calendar snooze presets use configurable local times, defaulting to 09:00 across weekdays and DST', () => {
	const previous = process.env.TZ;
	try {
		for (const timezone of ['UTC', 'Europe/Paris', 'America/New_York']) {
			process.env.TZ = timezone;
			for (const [input, expected] of [
				['2026-10-19T00:01:00', '2026-10-26T09:00:00'],
				['2026-10-19T09:00:00', '2026-10-26T09:00:00'],
				['2026-10-19T23:59:59', '2026-10-26T09:00:00'],
				['2026-10-20T17:00:00', '2026-10-26T09:00:00'],
				['2026-10-21T17:00:00', '2026-10-26T09:00:00'],
				['2026-10-22T17:00:00', '2026-10-26T09:00:00'],
				['2026-10-23T17:00:00', '2026-10-26T09:00:00'],
				['2026-10-24T17:00:00', '2026-10-26T09:00:00'],
				['2026-10-25T23:59:59', '2026-10-26T09:00:00'],
				['2026-10-26T08:59:59', '2026-11-02T09:00:00'],
				['2026-03-27T23:45:59', '2026-03-30T09:00:00'],
				['2026-03-06T17:00:00', '2026-03-09T09:00:00'],
				['2026-10-30T17:00:00', '2026-11-02T09:00:00'],
				['2026-12-31T17:00:00', '2027-01-04T09:00:00'],
				['2028-02-29T17:00:00', '2028-03-06T09:00:00']
			]) {
				const now = new Date(input).getTime(), presets = snoozePresets(now);
				assert.deepEqual(presets.map(preset => preset.label), ['In 1 hour', 'In 3 hours', 'Tomorrow at 9:00', 'Next Monday at 9:00']);
				assert.equal(presets[0].wake_at, now / 1000 + 3600);
				assert.equal(presets[1].wake_at, now / 1000 + 10800);
				const wake = new Date(presets[3].wake_at * 1000);
				assert.equal(wake.getTime(), new Date(expected).getTime(), `${timezone}: ${input}`);
				assert.equal(wake.getDay(), 1); assert.equal(wake.getHours(), 9);
				assert.equal(wake.getMinutes(), 0); assert.equal(wake.getSeconds(), 0);
				assert.ok(wake.getTime() > now);
				for (const time of ['00:00', '07:15', '14:35', '23:59']) {
					const [hour, minute] = time.split(':').map(Number), custom = snoozePresets(now, time);
					const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(hour, minute, 0, 0);
					const monday = new Date(expected); monday.setHours(hour, minute, 0, 0);
					assert.equal(custom[2].wake_at, tomorrow.getTime() / 1000);
					assert.equal(custom[3].wake_at, monday.getTime() / 1000);
					assert.equal(custom[2].label, `Tomorrow at ${hour}:${String(minute).padStart(2, '0')}`);
					assert.equal(custom[3].label, `Next Monday at ${hour}:${String(minute).padStart(2, '0')}`);
					assert.deepEqual(custom.slice(0, 2), presets.slice(0, 2));
				}
			}
		}
	} finally {
		if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
	}
});

test('invalid preset times fall back to 09:00 without normalizing malformed values', () => {
	for (const value of ['', '9:00', '24:00', '12:60', null, 900, {}]) assert.deepEqual(snoozePresets(100000, value), snoozePresets(100000));
});

test('precise snooze duration keeps day/hour/minute fields, rounding only partial minutes up', () => {
	for (const [remaining, expected] of [[-1, '0min left'], [0, '0min left'], [1, '1min left'], [3600, '1h 0min left'],
		[12 * 3600 + 14 * 60, '12h 14min left'], [2 * 86400 + 5 * 60, '2d 0h 5min left'], [2 * 86400 + 16 * 3600 + 12 * 60, '2d 16h 12min left']]) {
		assert.equal(snoozePreciseRemaining(100 + remaining, 100), expected);
	}
});
