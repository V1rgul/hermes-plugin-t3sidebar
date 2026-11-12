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
				// On a Sunday, Monday is tomorrow: the Monday button moves on a week so it never repeats Tomorrow.
				['2026-10-25T23:59:59', '2026-11-02T09:00:00'],
				['2026-10-26T08:59:59', '2026-11-02T09:00:00'],
				['2026-03-27T23:45:59', '2026-03-30T09:00:00'],
				['2026-03-06T17:00:00', '2026-03-09T09:00:00'],
				['2026-10-30T17:00:00', '2026-11-02T09:00:00'],
				['2026-12-31T17:00:00', '2027-01-04T09:00:00'],
				['2028-02-29T17:00:00', '2028-03-06T09:00:00']
			]) {
				const now = new Date(input).getTime(), presets = snoozePresets(now);
				assert.equal(presets.labelTime, '9:00');
				assert.deepEqual(presets.relative.map(preset => [preset.label, preset.name, preset.wake_at]),
					[['+1h', 'In 1 hour', now / 1000 + 3600], ['+2h', 'In 2 hours', now / 1000 + 7200], ['+4h', 'In 4 hours', now / 1000 + 14400]]);
				assert.deepEqual(presets.days.map(preset => preset.label), ['Tomorrow', 'Monday', 'Next week']);
				const wake = new Date(presets.days[1].wake_at * 1000);
				assert.equal(wake.getTime(), new Date(expected).getTime(), `${timezone}: ${input}`);
				assert.equal(wake.getDay(), 1); assert.equal(wake.getHours(), 9);
				assert.equal(wake.getMinutes(), 0); assert.equal(wake.getSeconds(), 0);
				assert.ok(wake.getTime() > now);
				assert.notEqual(presets.days[1].wake_at, presets.days[0].wake_at);
				for (const time of ['00:00', '07:15', '14:35', '23:59']) {
					const [hour, minute] = time.split(':').map(Number), custom = snoozePresets(now, time);
					const at = days => { const date = new Date(now); date.setDate(date.getDate() + days); date.setHours(hour, minute, 0, 0); return date.getTime() / 1000; };
					const monday = new Date(expected); monday.setHours(hour, minute, 0, 0);
					assert.deepEqual(custom.days.map(preset => preset.wake_at), [at(1), monday.getTime() / 1000, at(7)]);
					assert.deepEqual(custom.days.map(preset => preset.date.getTime() / 1000), custom.days.map(preset => preset.wake_at));
					assert.equal(custom.labelTime, `${hour}:${String(minute).padStart(2, '0')}`);
					assert.deepEqual(custom.relative, presets.relative);
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
